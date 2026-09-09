import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import express from "express";
import { WebSocketServer } from "ws";
import {
  defaultCharacterName,
  loadCharacter,
  loadStreamConfig,
  resolveFromRoot,
  ROOT,
  type CharacterConfig,
  type StreamConfig,
} from "./config.ts";
import { Broadcaster, readEnvFile } from "./broadcaster.ts";
import { DirectorController, DirectorError, isSessionEndedMessage, SessionEndedError } from "./director.ts";
import { applyEnvFile } from "./env.ts";
import { createFalProxyHandler } from "./falproxy.ts";
import { hasFalKey, uploadFile } from "./falstorage.ts";
import { OverlayServer } from "./overlay.ts";
import { buildDirectorPrompt, createApiRouter } from "./api.ts";
import { assertDirection } from "./prompt.ts";
import { ChatPoller } from "./chat.ts";
import { isCommentBeforeStart, StreamState, type ChatComment } from "./state.ts";
import { TtsClient, TtsError } from "./tts.ts";
import {
  AudioStore,
  DirectorAudioRecorder,
  makeRunId,
  TtsScheduleLog,
  type TtsScheduleEntry,
} from "./audio.ts";
import type { DirectorServerMessage, FromViewerMessage, PlayTrigger } from "../shared/protocol.ts";

/** voice_mode: native のときの発話長の見積もり（日本語 ≒ 7 文字/秒）。 */
const NATIVE_CHARS_PER_SEC = 7;

export interface SpeakInput {
  text: string;
  direction: string | null;
  emotion: string | null;
  commentId: string | null;
}

export interface SpeakResult {
  ok: true;
  duration_sec: number;
  on_air_at: string;
  on_air_at_ms: number;
  queue_remaining_sec: number;
  comment_used?: string;
  audio_url?: string;
  /** `audio_source: tts_direct` のとき、compositor に鳴らさせた wav の id。 */
  play_id?: string;
  /** その wav を鳴らす絶対時刻（`on_air_at_ms + audio_offset_ms`）。 */
  play_at_ms?: number;
}

/**
 * `tts_direct` で compositor に鳴らすよう指示した 1 発話。
 *
 * `audio_applied` で Director のキュー残の実測が届いたときに、同じ id で
 * `play_audio` を撃ち直して再生時刻を上書きするために覚えておく（SPEC §5.1）。
 * 突き合わせは Director に渡した `audio_url`（`audio_applied.source` に載る）で行う。
 */
interface ScheduledPlay {
  id: string;
  url: string;
  atMs: number;
  durationSec: number;
  /** Director に渡した音声 URL（fal storage）。ローカル検証では null。 */
  audioUrl: string | null;
  promptVersion: number | null;
  /** 音は鳴らさず字幕・強調の切替だけに使う（`audio_source: director`）。 */
  silent: boolean;
  /** 鳴り始めた瞬間に出す字幕。`audio_sync: scheduled` では使わない（null）。 */
  subtitle: string | null;
  /** 同時に強調するコメント id。 */
  highlightCommentId: string | null;
}

/** `audio_applied` を受けて再生時刻を撃ち直す最小のずれ（ms）。 */
const REPLAY_THRESHOLD_MS = 150;

/** 発話が終わってから字幕を消すまでの余韻（ms）。 */
const SUBTITLE_TAIL_MS = 500;

/** compositor が実際に鳴らし始めた実測（`audio_started`）。`h3 status` の `audio` に出す。 */
interface StartedPlayRecord {
  id: string;
  trigger: PlayTrigger;
  /** 推定（`at_ms`）との差。正なら推定より遅く鳴った。 */
  offsetMs: number;
  startedAtMs: number;
}

export class Daemon {
  readonly config: StreamConfig;
  readonly character: CharacterConfig;
  readonly state: StreamState;
  readonly overlay = new OverlayServer();
  readonly director: DirectorController;
  readonly tts: TtsClient;
  /** headless Chromium（/compositor）→ ffmpeg → RTMP。SPEC §8。 */
  readonly broadcaster: Broadcaster;
  /** `tts_direct` で compositor に直接再生させる wav（`/audio/<id>.wav`）。 */
  readonly audioStore = new AudioStore();
  /** このデーモン起動を表す ID。`state/analysis/` のファイル名に使う。 */
  readonly runId = makeRunId();
  /** `broadcast.record_director_audio` のときだけ使う解析用の記録。 */
  private readonly directorAudioRecorder: DirectorAudioRecorder | null;
  private readonly ttsScheduleLog: TtsScheduleLog | null;
  /** まだ鳴っていない（あるいは鳴り始めたばかりの）直接再生の予約。 */
  private readonly scheduledPlays = new Map<string, ScheduledPlay>();
  /** 直近に鳴り始めた発話の実測（`audio_started`）。 */
  private lastStartedPlay: StartedPlayRecord | null = null;

  private server: Server | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private chat: ChatPoller | null = null;
  private chatInfo: { liveChatId: string | null; broadcastId: string } | null = null;
  /** チャット取得を始められなかった理由（設定不足など）。`h3 status` に出す。 */
  private chatDisabledReason: string | null = null;
  private stopping = false;
  private staleCommentLogTimer: NodeJS.Timeout | null = null;
  /** `--no-tts`：起動時の TTS 疎通確認をしない（動作確認用）。 */
  probeTts = true;
  /** `h3 status` の `tts`。起動時の疎通確認と直近の合成結果で更新する。 */
  private ttsStatus: "ready" | "unreachable" | "skipped" | "disabled" | "unknown" = "unknown";
  private readonly pidFile = join(ROOT, "state", "daemon.json");

  /** `stateDir` はテスト用。既定は `<ROOT>/state`。 */
  constructor(config: StreamConfig, character: CharacterConfig, stateDir?: string) {
    this.config = config;
    this.character = character;
    this.state = new StreamState({
      chunkSeconds: config.chunk_seconds,
      queueLowSec: config.queue_low_sec,
      sessionMaxMin: config.session_max_min,
      restartWarnMin: config.restart_warn_min,
      ...(stateDir ? { stateDir } : {}),
    });
    this.director = new DirectorController(config, character, this.state);
    // Director が音声をキューに載せた実測が届いたら、直接再生の時刻を撃ち直す。
    this.director.onAudioApplied = (message) => this.onDirectorAudioApplied(message);
    this.director.onAudioStarted = (message) => this.onCompositorAudioStarted(message);
    this.tts = new TtsClient(config.tts, character.voice);
    this.broadcaster = new Broadcaster(
      config,
      {
        info: (message) => this.state.log("info", `broadcast: ${message}`),
        warn: (message) => this.state.log("warn", `broadcast: ${message}`),
        error: (message) => this.state.recordError(`broadcast: ${message}`),
      },
      {
        host: config.ports.host,
        port: config.ports.api,
        // compositor のコンソール行。WS が切れている間に届く死亡通知をここでも拾う
        // （初回配信では viewer_error が WS 再接続中に落ちて検知できなかった）。
        onCompositorMessage: (text) => {
          if (isSessionEndedMessage(text)) {
            this.state.endSession(`compositor: ${text.trim().slice(0, 200)}`);
          }
        },
      },
    );

    const analysisDir = join(this.state.stateDir, "analysis");
    const analysisLogger = {
      info: (message: string) => this.state.log("info", `analysis: ${message}`),
      warn: (message: string) => this.state.log("warn", `analysis: ${message}`),
    };
    this.directorAudioRecorder = config.broadcast.record_director_audio
      ? new DirectorAudioRecorder(analysisDir, this.runId, analysisLogger)
      : null;
    this.ttsScheduleLog = config.broadcast.record_director_audio
      ? new TtsScheduleLog(analysisDir, this.runId)
      : null;
  }

  // ---------- HTTP / WS ----------

  async listen(): Promise<{ host: string; port: number }> {
    const app = express();

    // fal proxy は本文を素通しするので、JSON パーサより前に raw で受ける。
    app.use(
      "/api/fal/proxy",
      express.raw({ type: () => true, limit: "64mb" }),
      createFalProxyHandler({
        credentials: () => process.env.FAL_KEY,
        onError: (message) => this.state.log("error", message),
      }),
    );

    app.use(express.json({ limit: "2mb" }));
    app.use("/api", createApiRouter(this));

    const overlayDir = join(ROOT, "overlay");
    app.get("/viewer", (_request, response) => response.sendFile(join(overlayDir, "viewer.html")));
    app.get("/overlay", (_request, response) => response.sendFile(join(overlayDir, "index.html")));
    // 合成ページ。broadcaster が headless Chromium で開くが、人がそのまま開いても見られる。
    app.get("/compositor", (_request, response) => response.sendFile(join(overlayDir, "compositor.html")));
    app.use("/static", express.static(overlayDir));

    // `audio_source: tts_direct` で compositor が直接再生する wav。
    // fal storage を経由しないので、Director を開かないローカル検証でも同じ経路が通る。
    app.get("/audio/:file", (request, response) => {
      const id = String(request.params.file).replace(/\.wav$/, "");
      const entry = this.audioStore.get(id);
      if (!entry) {
        response.status(404).json({ ok: false, error: "audio_not_found", id });
        return;
      }
      response.setHeader("Content-Type", "audio/wav");
      response.setHeader("Cache-Control", "no-store");
      response.send(Buffer.from(entry.bytes));
    });

    const server = createServer(app);
    this.server = server;

    const viewerWss = new WebSocketServer({ noServer: true });
    const overlayWss = new WebSocketServer({ noServer: true });
    // compositor が送ってくる webm チャンク（バイナリ）。
    const mediaWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    mediaWss.on("connection", (socket) => this.broadcaster.attachMedia(socket));
    // Director 音声トラックだけの別録り（broadcast.record_director_audio）。
    const directorAudioWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
    directorAudioWss.on("connection", (socket) => {
      if (!this.directorAudioRecorder) {
        socket.close(4003, "record_director_audio is off");
        return;
      }
      this.directorAudioRecorder.attach(socket, this.state.sessionSeq);
    });
    viewerWss.on("connection", (socket) => {
      this.director.attach(socket);
      void this.ensureSession();
    });
    overlayWss.on("connection", (socket) => {
      this.overlay.attach(socket);
      this.overlay.setComments(this.state.comments(30));
    });

    server.on("upgrade", (request, socket, head) => {
      const path = (request.url ?? "").split("?")[0];
      if (path === "/ws/viewer") {
        viewerWss.handleUpgrade(request, socket, head, (ws) => viewerWss.emit("connection", ws, request));
      } else if (path === "/ws/overlay") {
        overlayWss.handleUpgrade(request, socket, head, (ws) => overlayWss.emit("connection", ws, request));
      } else if (path === "/ws/media") {
        mediaWss.handleUpgrade(request, socket, head, (ws) => mediaWss.emit("connection", ws, request));
      } else if (path === "/ws/director-audio") {
        directorAudioWss.handleUpgrade(request, socket, head, (ws) =>
          directorAudioWss.emit("connection", ws, request),
        );
      } else {
        socket.destroy();
      }
    });

    const { host, api: port } = { host: this.config.ports.host, api: this.config.ports.api };
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    writeFileSync(
      this.pidFile,
      JSON.stringify({ pid: process.pid, host, port, character: this.character.name }, null, 2),
    );
    this.state.log("info", `daemon listening on http://${host}:${port} (character=${this.character.name})`);
    return { host, port };
  }

  // ---------- 起動 ----------

  async start(): Promise<Record<string, unknown>> {
    const { host, port } = await this.listen();
    this.tickTimer = setInterval(() => this.state.tick(), 1000);

    // TTS サーバーは外部サービス。落ちていても起動は続け、h3 status に unreachable を出す。
    if (this.config.voice_mode !== "tts") {
      this.ttsStatus = "disabled";
    } else if (!this.probeTts) {
      this.ttsStatus = "skipped";
    } else {
      const tts = await this.tts.start().catch(() => ({ ready: false }));
      this.ttsStatus = tts.ready ? "ready" : "unreachable";
      if (!tts.ready) {
        this.state.recordError(`tts: unreachable (${this.tts.baseUrl})`);
      }
    }

    const youtube = await this.startChat();
    const broadcast = await this.broadcaster.start();

    return {
      ok: true,
      character: this.character.name,
      url: `http://${host}:${port}`,
      viewer: `http://${host}:${port}/viewer`,
      overlay: `http://${host}:${port}/overlay`,
      compositor: `http://${host}:${port}/compositor`,
      tts: this.ttsStatus,
      director: hasFalKey() ? "waiting_for_viewer" : "fal_key_missing",
      youtube,
      broadcast,
      warnings: this.state.warnings(),
    };
  }

  private async startChat(): Promise<Record<string, unknown>> {
    if (!this.config.youtube.enabled) return { enabled: false };

    const auth = this.config.youtube.auth === "oauth" ? "oauth" : "api_key";
    const apiKey = auth === "api_key" ? process.env.YOUTUBE_API_KEY || readEnvFile().YOUTUBE_API_KEY || "" : "";

    // API キー方式は mine=true が使えないので、動画 ID が無いと何も引けない。
    // 配信自体は止めず、チャット取得だけ無効にして起動する。
    if (auth === "api_key") {
      const missing = !apiKey
        ? "YOUTUBE_API_KEY が .env にありません（docs/youtube-setup.md の「API キー方式」を参照）"
        : !this.config.youtube.broadcast_id
          ? "config/youtube.yaml の broadcast_id が空です（API キー方式では必須。配信ページ URL の v= の値を書いてください）"
          : null;
      if (missing) {
        const message = `youtube chat disabled: ${missing}`;
        this.state.recordError(message);
        this.chatDisabledReason = missing;
        return { enabled: false, reason: missing };
      }
    }

    try {
      const poller = new ChatPoller(
        {
          auth,
          apiKey: apiKey || undefined,
          clientSecretPath: resolveFromRoot(this.config.youtube.client_secret_path),
          tokenPath: resolveFromRoot(this.config.youtube.token_path),
          broadcastId: this.config.youtube.broadcast_id || undefined,
          pollIntervalMs: this.config.youtube.poll_interval_ms,
          ngWords: this.config.youtube.ng_words,
          includeOwnerComments: this.config.youtube.include_owner_comments,
        },
        (comment) => this.ingestComment(comment),
        {
          info: (message) => this.state.log("info", `chat: ${message}`),
          warn: (message) => this.state.log("warn", `chat: ${message}`),
          error: (message) => this.state.recordError(`chat: ${message}`),
        },
      );
      this.chat = poller;
      this.chatInfo = await poller.start();
      return { enabled: true, ...this.chatInfo, ...poller.getChatStatus() };
    } catch (error) {
      const message = `youtube chat disabled: ${String(error)}`;
      this.state.log("warn", message);
      this.chat = null;
      this.chatDisabledReason = message;
      return { enabled: false, reason: message };
    }
  }

  /**
   * ChatPoller から届いたコメントを未使用バッファへ入れる。
   *
   * YouTube の初回ポーリングは過去のコメントを全部返すので、
   * `ignore_comments_before_start` が真ならデーモン起動時刻より前に投稿された
   * ものは捨てる（ログには件数だけ出す）。返り値は採用したかどうか。
   */
  ingestComment(comment: ChatComment): boolean {
    if (
      this.config.ignore_comments_before_start &&
      isCommentBeforeStart(comment.publishedAt, this.state.startedAtMs)
    ) {
      this.state.staleCommentsDropped += 1;
      this.scheduleStaleCommentLog();
      return false;
    }
    this.state.addComment(comment);
    this.overlay.setComments(this.state.comments(30));
    return true;
  }

  /** 捨てた件数はまとめて 1 行にする（初回ポーリングで一気に来るため）。 */
  private scheduleStaleCommentLog(): void {
    if (this.staleCommentLogTimer) return;
    this.staleCommentLogTimer = setTimeout(() => {
      this.staleCommentLogTimer = null;
      this.state.log(
        "info",
        `chat: 起動前のコメントを破棄した（累計 ${this.state.staleCommentsDropped} 件）`,
      );
    }, 500);
    this.staleCommentLogTimer.unref?.();
  }

  /**
   * `h3 comments skip`：発話せずにコメントを使用済みにする。
   *
   * 生成できない内容（NG・演出ルール違反・TTS 失敗）を、謝罪等を読み上げずに
   * 黙って捨てて次へ進むため。既に使用済みなら何もしない。
   */
  skipComment(commentId: string, reason: string): Record<string, unknown> {
    if (this.state.isCommentUsed(commentId)) {
      return { ok: false, error: "comment_already_used", comment_id: commentId };
    }
    const comment = this.state.findComment(commentId);
    this.state.markCommentUsed(commentId);
    this.overlay.setComments(this.state.comments(30));
    if (this.overlay.snapshot.highlight === commentId) this.overlay.setHighlight(null);
    this.state.log("info", `skip comment ${commentId} (${reason})${comment ? `: ${comment.text}` : ""}`);
    return { ok: true, comment_id: commentId, skipped: true, reason };
  }

  /** ビューワーが繋がったら、まだセッションが無ければ configure する。 */
  private async ensureSession(): Promise<void> {
    if (this.state.sessionState === "live" || this.state.sessionState === "opening") return;
    if (!hasFalKey()) {
      this.state.log("warn", "FAL_KEY が無いので Director セッションは開かない");
      return;
    }
    if (!existsSync(this.character.imagePath)) {
      this.state.recordError(`初期画像が無い: ${this.character.imagePath}`);
      return;
    }
    try {
      const imageUrl = await this.director.ensureImageUrl((path) => uploadFile(path, "image/png"));
      this.director.configure(imageUrl);
    } catch (error) {
      this.state.recordError(`configure に失敗: ${String(error)}`);
    }
  }

  // ---------- コマンド ----------

  async status(): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (this.chat) {
      this.state.viewers = await this.chat.getViewerCount().catch(() => null);
    }
    return {
      ok: true,
      character: this.character.name,
      elapsed_sec: this.state.elapsedSec(now),
      viewers: this.state.viewers,
      queue_remaining_sec: this.state.queueRemainingSec(now),
      session_remaining_sec: this.state.sessionRemainingSec(now),
      generation_lead_sec: this.state.generationLeadSec,
      session_state: this.state.sessionState,
      session_seq: this.state.sessionSeq,
      viewer_connected: this.director.connected,
      overlay_clients: this.overlay.clientCount,
      comments_pending: this.state.pendingCount(),
      stale_comments_dropped: this.state.staleCommentsDropped,
      voice_mode: this.config.voice_mode,
      tts: this.ttsStatus,
      tts_base_url: this.tts.baseUrl,
      audio: this.audioStatus(),
      last_event: this.state.lastDirectorMessage?.type ?? null,
      last_director_message: this.state.lastDirectorMessage,
      last_speech: this.state.lastSpeech,
      youtube: this.youtubeStatus(),
      broadcast: this.broadcaster.status(),
      warnings: this.state.warnings(),
      errors: this.state.errors.slice(-5),
      ...(this.state.sessionEndedReason ? { session_ended_reason: this.state.sessionEndedReason } : {}),
    };
  }

  /** `h3 status` の `audio`。配信音声をどこから出しているか（SPEC §5.1）。 */
  private audioStatus(): Record<string, unknown> {
    this.pruneScheduledPlays();
    return {
      source: this.config.audio_source,
      sync: this.config.audio_sync,
      offset_ms: this.config.audio_offset_ms,
      onset_threshold_db: this.config.onset_threshold_db,
      onset_fallback_sec: this.config.onset_fallback_sec,
      tts_gain_db: this.config.tts_gain_db,
      pending_plays: this.scheduledPlays.size,
      record_director_audio: this.config.broadcast.record_director_audio,
      // 直近の発話が「いつ・何をきっかけに」鳴ったか。推定との差はここでしか分からない。
      last_trigger: this.lastStartedPlay?.trigger ?? null,
      last_started_offset_ms: this.lastStartedPlay?.offsetMs ?? null,
      last_started_id: this.lastStartedPlay?.id ?? null,
      ...(this.directorAudioRecorder?.currentPath
        ? {
            director_audio_file: this.directorAudioRecorder.currentPath,
            director_audio_bytes: this.directorAudioRecorder.bytesWritten,
          }
        : {}),
      ...(this.ttsScheduleLog ? { tts_schedule_file: this.ttsScheduleLog.path } : {}),
    };
  }

  /**
   * `h3 status` の `youtube`。チャット取得の状態（`chat_state` / `reason`）を含める。
   *
   * `waiting` は配信枠がまだ `upcoming` などでチャットが開いていないだけで、
   * デーモンは 10〜15 秒ごとに activeLiveChatId を取り直しながら待ち続けている。
   */
  private youtubeStatus(): Record<string, unknown> {
    if (!this.chat) {
      return { ...(this.chatInfo ?? { enabled: false }), chat_state: "stopped", reason: this.chatDisabledReason };
    }
    return {
      ...this.chatInfo,
      liveChatId: this.chat.getLiveChatId(),
      ...this.chat.getChatStatus(),
    };
  }

  /** セッションが死んでいるあいだは speak / direct を受け付けない。 */
  private assertSessionUsable(): void {
    if (this.state.isSessionEnded()) {
      throw new SessionEndedError(this.state.sessionEndedReason ?? "unknown");
    }
  }

  async speak(input: SpeakInput): Promise<SpeakResult> {
    // セッションが死んでいるなら TTS もコメント消費もしない。
    this.assertSessionUsable();
    // 禁止語チェックは TTS より前。ここで弾いた発話は何も起きない（コメントも使用済みにしない）。
    assertDirection(input.direction, this.config.direction_blocklist);

    let audioUrl: string | null = null;
    let durationSec: number;
    let wav: Uint8Array | null = null;

    if (this.config.voice_mode === "tts") {
      const instructions = this.tts.instructionsFor(input.emotion);
      let result;
      try {
        result = await this.tts.synthesize({ text: input.text, instructions });
      } catch (error) {
        if (error instanceof TtsError && error.code === "tts_unavailable") this.ttsStatus = "unreachable";
        throw error;
      }
      this.ttsStatus = "ready";
      audioUrl = result.audio_url;
      durationSec = result.duration_sec;
      wav = result.wav ?? null;
    } else {
      durationSec = Math.max(2, Math.round((input.text.length / NATIVE_CHARS_PER_SEC) * 10) / 10);
    }

    // Director にはどちらのモードでも音声を渡す。tts_direct でも口パクの
    // 条件付けには必要で、配信に乗せるかどうかだけが違う（SPEC §5.1）。
    const sent = this.director.prompt(buildDirectorPrompt(this, input.direction, input.text, audioUrl));

    const timing = this.state.enqueueAudio(durationSec);

    // `director_onset` では字幕・強調も compositor 主導（実際の発話開始に同期）。
    // `scheduled` のときだけ従来どおりデーモンが on_air_at のタイマーで切り替える。
    const onsetDriven = this.config.audio_sync === "director_onset";
    if (!onsetDriven) {
      this.overlay.schedule(timing.on_air_at_ms, input.commentId, input.text, durationSec * 1000);
    }

    // tts_direct：同じ wav を compositor に直接鳴らさせる。
    // director でも、`director_onset` なら字幕用の仮想エントリだけ積む。
    const directPlay = this.config.audio_source === "tts_direct" && wav;
    const play =
      directPlay || onsetDriven
        ? this.schedulePlay(directPlay ? wav : null, durationSec, timing.on_air_at_ms, {
            audioUrl,
            promptVersion: sent?.prompt_version ?? null,
            subtitle: onsetDriven && this.overlay.subtitlesEnabled ? input.text : null,
            highlightCommentId: onsetDriven ? input.commentId : null,
          })
        : null;

    if (input.commentId) this.state.markCommentUsed(input.commentId);
    this.overlay.setComments(this.state.comments(30));

    this.state.lastSpeech = {
      text: input.text,
      direction: input.direction,
      emotion: input.emotion,
      comment_id: input.commentId,
      duration_sec: timing.duration_sec,
      on_air_at_ms: timing.on_air_at_ms,
      sent_at_ms: Date.now(),
    };
    this.state.log("info", `speak (${timing.duration_sec}s): ${input.text}`);

    return {
      ok: true,
      duration_sec: timing.duration_sec,
      on_air_at: `+${timing.on_air_in_sec.toFixed(1)}s`,
      on_air_at_ms: Math.round(timing.on_air_at_ms),
      queue_remaining_sec: timing.queue_remaining_sec,
      ...(input.commentId ? { comment_used: input.commentId } : {}),
      ...(audioUrl ? { audio_url: audioUrl } : {}),
      // 字幕用の仮想エントリ（silent）は鳴らす wav が無いので play_id は返さない。
      ...(play && !play.silent ? { play_id: play.id, play_at_ms: Math.round(play.atMs) } : {}),
    };
  }

  // ---------- tts_direct（配信音声の直接再生。SPEC §5.1） ----------

  /**
   * wav を `/audio/<id>.wav` に置き、`on_air_at + audio_offset_ms` に鳴らすよう
   * compositor へ指示する。
   *
   * compositor が繋がっていなくても予約は覚えておく（`audio_applied` での
   * 撃ち直しと `cancel_audio` の対象にするため）。実際に鳴らなかったことは
   * `h3 status` の `audio.pending` とログで分かる。
   */
  private schedulePlay(
    wav: Uint8Array | null,
    durationSec: number,
    onAirAtMs: number,
    meta: {
      audioUrl: string | null;
      promptVersion: number | null;
      subtitle?: string | null;
      highlightCommentId?: string | null;
    },
  ): ScheduledPlay {
    // wav が無い（`audio_source: director` / TTS が wav を返さない）ときは
    // 字幕・強調の切替だけを行う仮想エントリにする。
    const entry = wav ? this.audioStore.put(wav, durationSec) : null;
    const play: ScheduledPlay = {
      id: entry?.id ?? this.audioStore.nextSilentId(),
      url: entry ? this.audioStore.url(entry.id) : "",
      atMs: onAirAtMs + this.config.audio_offset_ms,
      durationSec,
      audioUrl: meta.audioUrl,
      promptVersion: meta.promptVersion,
      silent: entry === null,
      subtitle: meta.subtitle ?? null,
      highlightCommentId: meta.highlightCommentId ?? null,
    };
    this.scheduledPlays.set(play.id, play);
    this.pruneScheduledPlays();
    this.sendPlay(play);
    this.ttsScheduleLog?.append(this.scheduleEntry(play));
    return play;
  }

  private scheduleEntry(play: ScheduledPlay, extra: Record<string, unknown> = {}): TtsScheduleEntry {
    return {
      id: play.id,
      url: play.url,
      at_ms: Math.round(play.atMs),
      duration_sec: play.durationSec,
      prompt_version: play.promptVersion,
      ...(play.audioUrl ? { audio_url: play.audioUrl } : {}),
      ...extra,
    };
  }

  private sendPlay(play: ScheduledPlay): void {
    const delivered = this.director.playAudio({
      id: play.id,
      url: play.url,
      at_ms: Math.round(play.atMs),
      duration_sec: play.durationSec,
      ...(play.silent ? { silent: true } : {}),
      ...(play.subtitle !== null ? { subtitle: play.subtitle } : {}),
      ...(play.highlightCommentId !== null ? { highlight_comment_id: play.highlightCommentId } : {}),
    });
    this.state.log(
      delivered ? "info" : "warn",
      `play_audio ${play.id} at +${Math.round(play.atMs - Date.now())}ms (${play.durationSec}s)` +
        (delivered ? "" : " — compositor 未接続なので鳴らない"),
    );
  }

  /**
   * `audio_applied.remaining_seconds` でキュー残の実測が入ったら、その発話の
   * 再生時刻を計算し直して同じ id で撃ち直す（`play_audio` は同一 id で置き換わる）。
   *
   * キュー終端は `syncAudioQueue` が実測に合わせてあるので、この発話が鳴り始めるのは
   * 「キュー終端 − この発話の長さ」。そこに生成先行分と `audio_offset_ms` を足す。
   */
  onDirectorAudioApplied(message: DirectorServerMessage): void {
    if (this.config.audio_source !== "tts_direct") return;
    const source = typeof message.source === "string" ? message.source : null;
    if (!source) return;
    const play = [...this.scheduledPlays.values()].find((p) => p.audioUrl === source);
    if (!play) return;

    const durationSec =
      typeof message.duration_seconds === "number" && message.duration_seconds > 0
        ? message.duration_seconds
        : play.durationSec;
    const onAirAtMs =
      this.state.queueEndAtMs - durationSec * 1000 + this.state.generationLeadSec * 1000;
    const nextAtMs = onAirAtMs + this.config.audio_offset_ms;
    if (Math.abs(nextAtMs - play.atMs) < REPLAY_THRESHOLD_MS) return;

    const shiftMs = Math.round(nextAtMs - play.atMs);
    play.atMs = nextAtMs;
    play.durationSec = durationSec;
    this.sendPlay(play);
    this.ttsScheduleLog?.append(this.scheduleEntry(play, { resynced_by: "audio_applied", shift_ms: shiftMs }));
    this.state.log("info", `play_audio ${play.id} を audio_applied に合わせて ${shiftMs}ms 動かした`);
  }

  /**
   * compositor が実際に鳴らし始めた（`audio_started`）。
   *
   * `audio_sync: director_onset` では、鳴り始める時刻は Director の口パクが
   * 決めるのでデーモンには予測できない。実測をここで受け取り、次回の計測のために
   * `tts-schedule-<run>.jsonl` に追記して `h3 status` の `audio` に出す。
   */
  onCompositorAudioStarted(message: Extract<FromViewerMessage, { type: "audio_started" }>): void {
    const offsetMs = Math.round(message.started_at_ms - message.at_ms);
    this.lastStartedPlay = {
      id: message.id,
      trigger: message.trigger,
      offsetMs,
      startedAtMs: message.started_at_ms,
    };
    const play = this.scheduledPlays.get(message.id);
    // 実際の発話開始に合わせて字幕と強調を切り替える（推定 on_air_at では早く出てしまう）。
    if (play && (play.subtitle !== null || play.highlightCommentId !== null)) {
      this.overlay.showNow(
        play.highlightCommentId,
        play.subtitle,
        message.duration_sec * 1000 + SUBTITLE_TAIL_MS,
      );
    }
    this.ttsScheduleLog?.append({
      id: message.id,
      url: play?.url ?? "",
      at_ms: message.at_ms,
      duration_sec: message.duration_sec,
      prompt_version: play?.promptVersion ?? null,
      event: "audio_started",
      started_at_ms: message.started_at_ms,
      trigger: message.trigger,
      offset_ms: offsetMs,
    });
    // 鳴り始めたので、この予約はもう撃ち直しの対象にしない。
    this.scheduledPlays.delete(message.id);
  }

  /**
   * 鳴り終わった予約は覚えておく必要が無い（撃ち直しの対象にもならない）。
   *
   * `director_onset` では鳴り始めるのが推定より遅れることがあるので、
   * フォールバックの締切（`at_ms + onset_fallback_sec`）を過ぎるまでは残す
   * （実際に鳴ったものは `audio_started` で消える）。
   */
  private pruneScheduledPlays(now = Date.now()): void {
    const graceMs =
      this.config.audio_sync === "director_onset" ? this.config.onset_fallback_sec * 1000 : 0;
    for (const [id, play] of this.scheduledPlays) {
      if (play.atMs + graceMs + play.durationSec * 1000 < now) this.scheduledPlays.delete(id);
    }
  }

  /**
   * `h3 audio test`：任意の wav を fal storage も Director も通さずに
   * compositor へ鳴らさせる。送出経路（WebAudio → MediaRecorder → ffmpeg）の
   * 検証を Director セッション無しで行うためのもの。
   */
  audioTest(wavPath: string, atMs: number | null, delayMs: number): Record<string, unknown> {
    const path = resolveFromRoot(wavPath);
    if (!existsSync(path)) {
      throw new DirectorError("wav_not_found", `wav が無い: ${path}`);
    }
    const wav = new Uint8Array(readFileSync(path));
    const entry = this.audioStore.put(wav);
    const play: ScheduledPlay = {
      id: entry.id,
      url: this.audioStore.url(entry.id),
      atMs: atMs ?? Date.now() + delayMs,
      durationSec: entry.durationSec,
      audioUrl: null,
      promptVersion: null,
      silent: false,
      subtitle: null,
      highlightCommentId: null,
    };
    this.scheduledPlays.set(play.id, play);
    this.sendPlay(play);
    this.ttsScheduleLog?.append(this.scheduleEntry(play, { source: "audio_test", wav_path: path }));
    return {
      ok: true,
      id: play.id,
      url: play.url,
      wav: path,
      at_ms: Math.round(play.atMs),
      in_ms: Math.round(play.atMs - Date.now()),
      duration_sec: Math.round(play.durationSec * 1000) / 1000,
      compositor_connected: this.director.connected,
    };
  }

  async direct(direction: string): Promise<Record<string, unknown>> {
    this.assertSessionUsable();
    this.director.prompt(buildDirectorPrompt(this, direction, null, null));
    this.state.log("info", `direct: ${direction}`);
    return {
      ok: true,
      applied: "next_chunk",
      queue_remaining_sec: this.state.queueRemainingSec(),
    };
  }

  /**
   * Director セッションを閉じ、初期画像と default_scene で configure し直す。
   *
   * `h3 session restart`（セッション上限・エラー時）と `h3 reset`（見た目が崩れたときに
   * 映像を最初の状態へ戻す）の共通実装。`trigger` は意図の記録にだけ使う。
   *
   * 積んであった音声キューは Director 側で失われるので、失った秒数を返す。
   * オーバーレイのコメント一覧と強調はそのまま残し、まだ流れていない字幕の予約だけ捨てる。
   */
  async restartSession(reason: string, trigger: "restart" | "reset" = "restart"): Promise<Record<string, unknown>> {
    if (!this.director.connected) {
      throw new DirectorError("viewer_not_connected", "ビューワーページが繋がっていない");
    }
    // 画像 URL の解決を先に済ませる。ここで失敗したら今のセッションは触らずに終わる。
    const imageUrl = await this.director.ensureImageUrl((path) => uploadFile(path, "image/png"));
    const queueLostSec = this.state.queueRemainingSec();
    this.state.log("info", `session ${trigger}: ${reason} (queue lost ${queueLostSec}s)`);
    this.director.closeSession();
    // 予約されていた字幕の切替は捨てるが、オーバーレイ状態（コメント一覧・強調・
    // いま出ている字幕）はリセットしない。配信はあくまで継続中だから。
    const subtitle = this.overlay.snapshot.subtitle;
    this.overlay.clearSchedule();
    if (subtitle !== null) this.overlay.setSubtitle(subtitle);
    // Director 側のキューが消えるので、compositor に積んだ直接再生も全部捨てる。
    // 残すと、もう流れない映像に合わせて声だけが鳴ってしまう。
    const cancelled = this.cancelScheduledPlays();
    this.director.configure(imageUrl);
    return {
      ok: true,
      trigger,
      reconfigured: true,
      reason,
      session_seq: this.state.sessionSeq,
      session_remaining_sec: this.state.sessionRemainingSec(),
      queue_cleared: true,
      queue_lost_sec: queueLostSec,
      queue_remaining_sec: 0,
      // director でも `director_onset` なら字幕用の仮想エントリを積んでいる。
      ...(this.config.audio_source === "tts_direct" || this.config.audio_sync === "director_onset"
        ? { audio_cancelled: cancelled }
        : {}),
    };
  }

  /** compositor に積んだ直接再生の予約を全部捨てる。返り値は捨てた件数。 */
  private cancelScheduledPlays(): number {
    const count = this.scheduledPlays.size;
    this.scheduledPlays.clear();
    this.director.cancelAudio();
    if (count > 0) this.state.log("info", `cancel_audio: 未再生の直接再生 ${count} 件を捨てた`);
    return count;
  }

  stoppedComponents(): string[] {
    const stopped = ["director"];
    if (this.broadcaster.mode !== "off") stopped.push("broadcaster");
    if (this.chat) stopped.push("chat-poller");
    stopped.push("overlay");
    return stopped;
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.state.log("info", "daemon stopping");
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.staleCommentLogTimer) clearTimeout(this.staleCommentLogTimer);
    this.state.releaseWaiters();
    try {
      this.director.closeSession();
    } catch {
      /* ビューワー未接続なら何もしない */
    }
    this.chat?.stop();
    this.directorAudioRecorder?.close();
    await this.broadcaster.stop();
    this.overlay.close();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      setTimeout(resolve, 2000);
    });
    try {
      rmSync(this.pidFile, { force: true });
    } catch {
      /* noop */
    }
    process.exit(0);
  }
}

async function main(): Promise<void> {
  // FAL_KEY などをシェルで export していなくても、`.env` に書いてあれば拾う。
  applyEnvFile();
  const { values } = parseArgs({
    options: {
      character: { type: "string", short: "c" },
      config: { type: "string" },
      port: { type: "string" },
      "no-tts": { type: "boolean" },
    },
    allowPositionals: true,
  });

  const config = loadStreamConfig(values.config ? resolveFromRoot(values.config) : undefined);
  if (values.port) config.ports.api = Number(values.port);
  const characterName = values.character ?? defaultCharacterName();
  const character = loadCharacter(characterName);

  const daemon = new Daemon(config, character);
  if (values["no-tts"]) daemon.probeTts = false;
  const info = await daemon.start();
  process.stdout.write(`${JSON.stringify(info)}\n`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void daemon.shutdown());
  }
}

// エントリポイントとして起動されたときだけデーモンを立ち上げる。
// api.ts はこのモジュールを型としてしか読まないが、テストやツールが値として
// import したときに勝手に listen しないようにしておく。
const entry = process.argv[1];
if (entry !== undefined && resolvePath(entry) === fileURLToPath(import.meta.url)) {
  await main();
}
