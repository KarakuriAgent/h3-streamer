import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WebSocket } from "ws";
import { broadcastSize, resolveFromRoot, ROOT, type BroadcastConfig, type StreamConfig } from "./config.ts";

/**
 * 自前送出（SPEC §8）。
 *
 * ```
 * [headless Chromium] /compositor  --(webm/vp8+opus, 500ms ごと)-->  /ws/media
 *                                                                      │
 *                                        ffmpeg stdin ─ h264/aac ─ RTMP or *.flv
 * ```
 *
 * Chromium と ffmpeg のプロセス管理だけを持ち、合成そのものはページ側（`web/compositor.ts`）。
 *
 * webm は先頭チャンクにしかヘッダが無いので、**ffmpeg は接続 1 本につき 1 プロセス**にする。
 * ffmpeg が落ちたら、途中から読める新しい ffmpeg は作れないので、media 用の WebSocket を
 * 切ってページに録り直させ、その新しい接続で ffmpeg を起動し直す（＝自動再起動）。
 */

export interface BroadcasterLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface BroadcasterOptions {
  host: string;
  port: number;
  /**
   * compositor ページの `[compositor] …` コンソール行。
   * デーモンとの WebSocket が切れている間のエラー（data channel の切断など）は
   * `viewer_error` として届かないので、コンソール経由でも拾えるようにしてある。
   */
  onCompositorMessage?: (text: string) => void;
}

export type BroadcasterMode = "off" | "preview" | "broadcast";

/** ffmpeg が落ちてから ffmpeg を作り直すまでの待ち時間（連続失敗で伸ばす）。 */
const FFMPEG_RETRY_BASE_MS = 1000;
const FFMPEG_RETRY_MAX_MS = 15_000;
/** ページが落ちてから開き直すまでの待ち時間。 */
const PAGE_RETRY_MS = 3000;
/** 送出中のスループットをログに出す間隔。 */
const THROUGHPUT_LOG_MS = 60_000;

export class Broadcaster {
  private readonly broadcast: BroadcastConfig;
  private readonly size: { width: number; height: number };

  private browser: import("playwright").Browser | null = null;
  private page: import("playwright").Page | null = null;
  private context: import("playwright").BrowserContext | null = null;
  private ffmpeg: ChildProcessWithoutNullStreams | null = null;
  private mediaSocket: WebSocket | null = null;

  private stopping = false;
  private pageRetryTimer: NodeJS.Timeout | null = null;
  private ffmpegFailures = 0;
  private encoderInUse: "nvenc" | "x264" | null = null;
  private startedAtMs = 0;
  private bytesIn = 0;
  private chunksIn = 0;
  private lastChunkAtMs = 0;
  /** webm チャンクの到着間隔（ms）の移動平均。実測の目安。 */
  private chunkIntervalMs = 0;
  private throughputTimer: NodeJS.Timeout | null = null;
  private ffmpegRestarts = 0;
  private ffmpegCooldownUntilMs = 0;
  private ffmpegHealthTimer: NodeJS.Timeout | null = null;
  private pageRestarts = 0;
  private lastError: string | null = null;

  constructor(
    private readonly config: StreamConfig,
    private readonly logger: BroadcasterLogger,
    private readonly options: BroadcasterOptions,
  ) {
    this.broadcast = config.broadcast;
    this.size = broadcastSize(config);
  }

  /** off = 何もしない / preview = Chromium だけ / broadcast = Chromium + ffmpeg。 */
  get mode(): BroadcasterMode {
    if (this.broadcast.enabled) return "broadcast";
    return this.broadcast.preview ? "preview" : "off";
  }

  private get compositorUrl(): string {
    const { width, height } = this.size;
    const query = new URLSearchParams({
      w: String(width),
      h: String(height),
      fps: String(this.broadcast.fps),
      vb: String(this.broadcast.video_bitrate_k * 1000),
      timeslice: String(this.broadcast.chunk_ms),
      record: this.mode === "broadcast" ? "1" : "0",
    });
    return `http://${this.options.host}:${this.options.port}/compositor?${query.toString()}`;
  }

  /** 送出先。`output: file` なら flv ファイル、そうでなければ rtmp URL + ストリームキー。 */
  private get target(): { url: string; label: string } | null {
    if (this.broadcast.output === "file") {
      const path = resolveFromRoot(this.broadcast.file_path);
      mkdirSync(dirname(path), { recursive: true });
      return { url: path, label: path };
    }
    const key = process.env.RTMP_KEY || readEnvFile().RTMP_KEY;
    if (!key) return null;
    const base = (process.env.RTMP_URL || readEnvFile().RTMP_URL || this.broadcast.rtmp_url).replace(/\/$/, "");
    // ストリームキーはログにも status にも出さない。
    return { url: `${base}/${key}`, label: `${base}/<RTMP_KEY>` };
  }

  // ---------- 起動・停止 ----------

  async start(): Promise<Record<string, unknown>> {
    // stop() のあとでも start() し直せるようにする（h3 broadcast start/stop）。
    this.stopping = false;
    if (this.mode === "off") return { mode: "off" };
    if (this.browser) return { mode: this.mode, already_running: true, compositor: this.compositorUrl };
    this.startedAtMs = Date.now();

    if (this.mode === "broadcast") {
      const target = this.target;
      if (!target) {
        this.logger.warn("RTMP_KEY が無いので送出せずプレビューだけ動かす（.env に RTMP_KEY を書く）");
        this.broadcast.enabled = false;
        this.broadcast.preview = true;
      } else {
        this.encoderInUse = await this.pickEncoder();
        this.logger.info(`broadcast: ${target.label} (encoder=${this.encoderInUse})`);
      }
    }

    try {
      await this.openBrowser();
    } catch (error) {
      // Chromium が無い・起動できない環境でもデーモン自体は動かす。
      this.lastError = String(error);
      this.logger.error(
        `compositor の Chromium を起動できなかった: ${String(error)}\n` +
          `  → npx playwright install chromium を実行するか、ブラウザで ${this.compositorUrl} を開く`,
      );
      return { mode: this.mode, browser: "failed", error: this.lastError };
    }

    return {
      mode: this.mode,
      compositor: this.compositorUrl,
      size: `${this.size.width}x${this.size.height}@${this.broadcast.fps}`,
      encoder: this.encoderInUse,
      output: this.mode === "broadcast" ? (this.target?.label ?? null) : null,
    };
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.pageRetryTimer) clearTimeout(this.pageRetryTimer);
    if (this.ffmpegHealthTimer) clearTimeout(this.ffmpegHealthTimer);
    this.stopThroughputLog();
    this.stopFfmpeg("daemon shutdown");
    try {
      this.mediaSocket?.close(1001, "shutting down");
    } catch {
      /* noop */
    }
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    this.context = null;
    if (browser) await browser.close().catch(() => undefined);
  }

  status(): Record<string, unknown> {
    return {
      mode: this.mode,
      running: this.browser !== null,
      compositor_connected: this.mediaSocket !== null,
      ffmpeg_running: this.ffmpeg !== null,
      encoder: this.encoderInUse,
      output: this.mode === "broadcast" ? (this.target?.label ?? null) : null,
      size: `${this.size.width}x${this.size.height}@${this.broadcast.fps}`,
      uptime_sec: this.startedAtMs ? Math.round((Date.now() - this.startedAtMs) / 1000) : 0,
      chunks_in: this.chunksIn,
      chunk_interval_ms: Math.round(this.chunkIntervalMs),
      bytes_in: this.bytesIn,
      last_chunk_age_ms: this.lastChunkAtMs ? Date.now() - this.lastChunkAtMs : null,
      ffmpeg_restarts: this.ffmpegRestarts,
      page_restarts: this.pageRestarts,
      last_error: this.lastError,
    };
  }

  // ---------- Chromium ----------

  private async openBrowser(): Promise<void> {
    const { chromium } = await import("playwright");
    const { width, height } = this.size;
    const args = [
      // 音声・映像を人の操作なしで再生する（headless には操作する人がいない）。
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--disable-dev-shm-usage",
      // 非表示のページでも requestAnimationFrame を止めない。
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      `--window-size=${width},${height}`,
    ];
    args.push(
      ...(this.broadcast.gpu
        ? ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--enable-zero-copy"]
        : ["--disable-gpu"]),
    );

    const launch = (env?: Record<string, string>): Promise<import("playwright").Browser> =>
      chromium.launch({
        headless: this.broadcast.headless,
        // headless shell は WebRTC / MediaRecorder 周りが欠けることがあるので、
        // 通常の Chromium を --headless=new で使う。
        channel: "chromium",
        args,
        ...(env ? { env } : {}),
      });

    try {
      this.browser = await launch();
    } catch (error) {
      // Chromium は TMPDIR が fuse/NTFS だと起動直後に SIGTRAP で落ちる。
      // 変な TMPDIR を渡されていたら /tmp で 1 度だけやり直す。
      const tmpdir = process.env.TMPDIR;
      if (!tmpdir || tmpdir === "/tmp") throw error;
      this.logger.warn(`Chromium が TMPDIR=${tmpdir} で起動できなかった。TMPDIR=/tmp でやり直す`);
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value;
      }
      env.TMPDIR = "/tmp";
      this.browser = await launch(env);
    }
    this.browser.on("disconnected", () => {
      if (!this.stopping) this.logger.error("compositor の Chromium が落ちた");
    });
    await this.openPage();
  }

  private async openPage(): Promise<void> {
    const browser = this.browser;
    if (!browser || this.stopping) return;
    // 開き直しのたびに context が積み上がらないよう、前のものを閉じてから作る。
    const previous = this.context;
    this.context = null;
    if (previous) await previous.close().catch(() => undefined);

    const context = await browser.newContext({ viewport: { width: this.size.width, height: this.size.height } });
    this.context = context;
    const page = await context.newPage();
    this.page = page;

    page.on("console", (message) => {
      const text = message.text();
      if (!text.startsWith("[compositor]")) return;
      const body = text.replace("[compositor] ", "");
      this.logger.info(`compositor: ${body}`);
      this.options.onCompositorMessage?.(body);
    });
    page.on("pageerror", (error) => {
      this.lastError = error.message;
      this.logger.error(`compositor page error: ${error.message}`);
    });
    page.on("crash", () => {
      this.logger.error("compositor page crashed — 開き直す");
      this.scheduleReopen();
    });
    page.on("close", () => {
      if (this.page === page && !this.stopping) {
        this.logger.warn("compositor page closed — 開き直す");
        this.scheduleReopen();
      }
    });

    await page.goto(this.compositorUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    this.logger.info(`compositor open: ${this.compositorUrl}`);
  }

  private scheduleReopen(): void {
    if (this.stopping || this.pageRetryTimer) return;
    this.page = null;
    this.pageRetryTimer = setTimeout(() => {
      this.pageRetryTimer = null;
      this.pageRestarts += 1;
      void this.openPage().catch((error: unknown) => {
        this.lastError = String(error);
        this.logger.error(`compositor page を開き直せなかった: ${String(error)}`);
        this.scheduleReopen();
      });
    }, PAGE_RETRY_MS);
  }

  // ---------- /ws/media ----------

  /**
   * compositor ページからの webm ストリームを受ける。
   * 送出元は 1 本だけ（後から来た接続は断る）。接続ごとに ffmpeg を起動し直す。
   */
  attachMedia(socket: WebSocket): void {
    if (this.mediaSocket) {
      socket.close(4001, "another compositor is already streaming");
      return;
    }
    this.mediaSocket = socket;
    this.chunksIn = 0;
    this.bytesIn = 0;
    this.lastChunkAtMs = 0;
    this.chunkIntervalMs = 0;
    this.logger.info("compositor media stream connected");
    this.startThroughputLog();

    if (this.broadcast.enabled) this.startFfmpeg();

    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      const now = Date.now();
      if (this.lastChunkAtMs > 0) {
        const interval = now - this.lastChunkAtMs;
        this.chunkIntervalMs = this.chunkIntervalMs === 0 ? interval : this.chunkIntervalMs * 0.8 + interval * 0.2;
      }
      this.chunksIn += 1;
      this.bytesIn += chunk.length;
      this.lastChunkAtMs = now;
      const stdin = this.ffmpeg?.stdin;
      if (!stdin || stdin.destroyed) return;
      if (!stdin.write(chunk)) {
        // ffmpeg が読み切れていない。落とさず溜めるが、続くようならログに出る。
        stdin.once("drain", () => undefined);
      }
    });

    socket.on("close", () => {
      if (this.mediaSocket !== socket) return;
      this.mediaSocket = null;
      this.stopThroughputLog();
      this.logger.warn("compositor media stream disconnected");
      this.stopFfmpeg("compositor disconnected");
    });
    socket.on("error", (error) => this.logger.warn(`media socket error: ${String(error)}`));
  }

  /** 1 分ごとに実測のチャンク間隔とビットレートをログに残す（監視用）。 */
  private startThroughputLog(): void {
    this.stopThroughputLog();
    let lastBytes = 0;
    this.throughputTimer = setInterval(() => {
      const kbps = Math.round(((this.bytesIn - lastBytes) * 8) / THROUGHPUT_LOG_MS);
      lastBytes = this.bytesIn;
      this.logger.info(
        `送出中: ${this.chunksIn} chunks, 間隔 ${Math.round(this.chunkIntervalMs)}ms, ${kbps} kbps`,
      );
    }, THROUGHPUT_LOG_MS);
  }

  private stopThroughputLog(): void {
    if (this.throughputTimer) clearInterval(this.throughputTimer);
    this.throughputTimer = null;
  }

  // ---------- ffmpeg ----------

  private async pickEncoder(): Promise<"nvenc" | "x264"> {
    if (this.broadcast.encoder === "nvenc") return "nvenc";
    if (this.broadcast.encoder === "x264") return "x264";
    return (await hasWorkingNvenc()) ? "nvenc" : "x264";
  }

  private ffmpegArgs(targetUrl: string): string[] {
    const { video_bitrate_k, audio_bitrate_k, fps } = this.broadcast;
    const bitrate = `${video_bitrate_k}k`;
    const encoder =
      this.encoderInUse === "nvenc"
        ? ["-c:v", "h264_nvenc", "-preset", "p4"]
        : ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency"];
    return [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-nostdin",
      // output: file で張り直したとき、既存ファイルを上書きする。
      "-y",
      // MediaRecorder の webm は途中から届くのでタイムスタンプを整えてもらう。
      "-fflags",
      "+genpts",
      "-i",
      "pipe:0",
      ...encoder,
      "-b:v",
      bitrate,
      "-maxrate",
      bitrate,
      "-bufsize",
      `${video_bitrate_k * 2}k`,
      "-g",
      String(fps * 2),
      "-r",
      String(fps),
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      `${audio_bitrate_k}k`,
      "-ar",
      "48000",
      "-ac",
      "2",
      // 送出も file 出力も、溜め込まず出た端から書く（確認とレイテンシのため）。
      "-flush_packets",
      "1",
      "-f",
      "flv",
      targetUrl,
    ];
  }

  private startFfmpeg(): void {
    if (this.ffmpeg || this.stopping) return;
    const target = this.target;
    if (!target) return;
    const wait = this.ffmpegCooldownUntilMs - Date.now();
    if (wait > 0) {
      // 連続失敗の直後。冷ましてからページに録り直させる。
      setTimeout(() => {
        if (this.mediaSocket) this.startFfmpeg();
      }, wait);
      return;
    }

    const child = spawn("ffmpeg", this.ffmpegArgs(target.url), { stdio: ["pipe", "pipe", "pipe"] });
    this.ffmpeg = child;
    this.logger.info(`ffmpeg started (${this.encoderInUse} → ${target.label})`);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => {
      for (const line of text.split("\n")) {
        if (line.trim().length > 0) this.logger.warn(`ffmpeg: ${line.trim()}`);
      }
    });
    child.stdout.resume();
    child.stdin.on("error", () => undefined);

    // 30 秒生き延びたら「安定した」とみなして失敗回数を戻す。
    if (this.ffmpegHealthTimer) clearTimeout(this.ffmpegHealthTimer);
    this.ffmpegHealthTimer = setTimeout(() => {
      if (this.ffmpeg === child) this.ffmpegFailures = 0;
    }, 30_000);

    child.on("exit", (code, signal) => {
      if (this.ffmpeg !== child) return;
      this.ffmpeg = null;
      if (this.stopping) return;
      this.lastError = `ffmpeg exited (code=${code} signal=${signal})`;
      this.logger.error(this.lastError);
      this.restartPipeline();
    });
    child.on("error", (error) => {
      this.lastError = `ffmpeg spawn error: ${error.message}`;
      this.logger.error(this.lastError);
    });
  }

  private stopFfmpeg(reason: string): void {
    const child = this.ffmpeg;
    this.ffmpeg = null;
    if (!child) return;
    this.logger.info(`ffmpeg stopping: ${reason}`);
    try {
      child.stdin.end();
    } catch {
      /* noop */
    }
    // flv を閉じる時間を少しだけ待ってから殺す。
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => clearTimeout(killTimer));
  }

  /**
   * ffmpeg が落ちたときの復帰。
   *
   * webm はヘッダが先頭チャンクにしか無いので、途中から新しい ffmpeg には渡せない。
   * media の WebSocket を切ってページに録り直させ、次の接続で ffmpeg を作り直す。
   */
  private restartPipeline(): void {
    this.ffmpegFailures += 1;
    this.ffmpegRestarts += 1;
    const socket = this.mediaSocket;
    this.mediaSocket = null;
    try {
      socket?.close(4002, "ffmpeg restarting");
    } catch {
      /* noop */
    }
    // 実際の張り直しはページの再接続（MediaUplink の retryMs）で起きる。
    // 連続して落ちるときだけ、ページが繋ぎ直しても ffmpeg を作らない時間を設けて暴走を防ぐ。
    const cooldownMs = Math.min(FFMPEG_RETRY_MAX_MS, FFMPEG_RETRY_BASE_MS * this.ffmpegFailures);
    this.ffmpegCooldownUntilMs = Date.now() + cooldownMs;
    this.logger.info(`ffmpeg は ${cooldownMs}ms 待ってから張り直す（ページが録り直して再接続する）`);
  }
}

/**
 * `.env` の RTMP_KEY / RTMP_URL / YOUTUBE_API_KEY。
 *
 * デーモンは環境変数をそのまま見る作りなので、`.env` に書いただけの値も拾えるよう
 * ここでファイルを 1 度だけ読む（読めなければ空）。他のキーには触らない。
 */
let envFileCache: Record<string, string> | null = null;
export function readEnvFile(path = join(ROOT, ".env")): Record<string, string> {
  if (envFileCache) return envFileCache;
  const out: Record<string, string> = {};
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = /^\s*(RTMP_KEY|RTMP_URL|YOUTUBE_API_KEY)\s*=\s*(.*)$/.exec(line);
      if (match?.[1] && match[2] !== undefined) {
        out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  }
  envFileCache = out;
  return out;
}

/**
 * NVENC が実際に使えるか。`-encoders` に載っていても GPU が無ければ失敗するので、
 * 極小のダミーを 1 本エンコードして確かめる。
 */
export function hasWorkingNvenc(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=black:s=256x144:d=0.1",
      "-c:v",
      "h264_nvenc",
      "-f",
      "null",
      "-",
    ]);
    const timer = setTimeout(() => {
      probe.kill("SIGKILL");
      resolve(false);
    }, 10_000);
    probe.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    probe.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
