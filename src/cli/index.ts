import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { loadStreamConfig, resolveFromRoot, ROOT } from "../daemon/config.ts";
import { runOAuthFlow } from "../daemon/youtube-auth.ts";

/**
 * `h3` コマンド。すべて JSON を標準出力に返す。終了コード 0 = 成功。
 * 実処理はデーモン（127.0.0.1 のローカル HTTP API）が持つ。
 */

interface DaemonInfo {
  pid: number;
  host: string;
  port: number;
  character: string;
}

const config = loadStreamConfig();
const PID_FILE = join(ROOT, "state", "daemon.json");

function daemonInfo(): DaemonInfo | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PID_FILE, "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

function baseUrl(): string {
  const info = daemonInfo();
  const host = info?.host ?? config.ports.host;
  const port = info?.port ?? config.ports.api;
  return `http://${host}:${port}`;
}

function output(value: unknown, code = 0): never {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(code);
}

function fail(error: string, message: string, extra: Record<string, unknown> = {}): never {
  output({ ok: false, error, message, ...extra }, 1);
}

async function request(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<unknown> {
  const url = `${baseUrl()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? {} : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 180_000),
    });
  } catch (error) {
    fail("daemon_unreachable", `デーモンに接続できない (${url}): ${String(error)}。h3 daemon start を実行する。`);
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("bad_response", `デーモンの応答が JSON ではない: ${text.slice(0, 300)}`);
  }
  if (!response.ok) output(parsed, 1);
  return parsed;
}

async function daemonAlive(timeoutMs = 1500): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl()}/api/status`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

const program = new Command();
program.name("h3").description("MiniMax H3 Max Director で AI キャラの配信を回す CLI").version("0.3.0");

// ---------- daemon ----------

const daemon = program.command("daemon").description("デーモンの起動・停止");

daemon
  .command("start")
  .description("デーモンをデタッチ起動する。既に起動中なら何もしない")
  .option("--character <name>", "characters/<name> を使う（省略時はキャラが 1 つだけならそれ）")
  .option("--foreground", "フォアグラウンドで起動する（デバッグ用）", false)
  .option("--no-tts", "起動時の TTS 疎通確認をしない（動作確認用）")
  .action(async (options: { character?: string; foreground: boolean; tts: boolean }) => {
    if (await daemonAlive()) {
      const status = (await request("/api/status")) as Record<string, unknown>;
      output({ ok: true, already_running: true, character: status.character, url: baseUrl() });
    }
    const entry = join(ROOT, "src", "daemon", "index.ts");
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        entry,
        ...(options.character ? ["--character", options.character] : []),
        ...(options.tts ? [] : ["--no-tts"]),
      ],
      {
        cwd: ROOT,
        detached: !options.foreground,
        stdio: options.foreground ? "inherit" : "ignore",
        env: process.env,
      },
    );
    if (!options.foreground) child.unref();

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (await daemonAlive()) {
        const status = (await request("/api/status")) as Record<string, unknown>;
        output({
          ok: true,
          character: status.character,
          url: baseUrl(),
          viewer: `${baseUrl()}/viewer`,
          overlay: `${baseUrl()}/overlay`,
          director: status.session_state,
          ...(Array.isArray(status.warnings) && status.warnings.length > 0
            ? { warnings: status.warnings }
            : {}),
          hint: "ブラウザで viewer を開くと Director セッションが始まる",
        });
      }
      if (child.exitCode !== null) break;
    }
    fail("daemon_start_failed", "デーモンが起動しなかった。state/log/daemon.log を確認する。");
  });

daemon
  .command("stop")
  .description("デーモンを停止する")
  .action(async () => {
    if (!(await daemonAlive())) output({ ok: true, already_stopped: true });
    output(await request("/api/stop", { method: "POST", body: {} }));
  });

// ---------- 運用コマンド ----------

program
  .command("status")
  .description("経過時間・視聴者数・キュー残・セッション残り等")
  .action(async () => output(await request("/api/status")));

const comments = program
  .command("comments")
  .description("未使用コメント（新しい順）")
  .option("--limit <n>", "件数", "5")
  .action(async (options: { limit: string }) =>
    output(await request(`/api/comments?limit=${encodeURIComponent(options.limit)}`)),
  );

comments
  .command("skip")
  .description("コメントを発話せずに使用済みにする（生成できない内容を黙って捨てる）")
  .requiredOption("--id <id>", "コメント ID")
  .option("--reason <reason>", "理由（ログ用）", "skipped by operator")
  .action(async (options: { id: string; reason: string }) =>
    output(
      await request("/api/comments/skip", {
        method: "POST",
        body: { comment_id: options.id, reason: options.reason },
      }),
    ),
  );

program
  .command("speak")
  .description("TTS 生成 → Director に prompt + audio を送る")
  .requiredOption("--text <text>", "セリフ（日本語）")
  .option("--direction <direction>", "映像演出（英語・自由記述）")
  .option("--emotion <emotion>", "tts.yaml の emotion_instructions のキー")
  .option("--comment-id <id>", "返答対象のコメント ID（使用済みに登録）")
  .action(async (options: { text: string; direction?: string; emotion?: string; commentId?: string }) =>
    output(
      await request("/api/speak", {
        method: "POST",
        body: {
          text: options.text,
          direction: options.direction ?? null,
          emotion: options.emotion ?? null,
          comment_id: options.commentId ?? null,
        },
      }),
    ),
  );

program
  .command("direct")
  .description("音声なしで映像演出だけ変える")
  .requiredOption("--direction <direction>", "映像演出（英語・自由記述）")
  .action(async (options: { direction: string }) =>
    output(await request("/api/direct", { method: "POST", body: { direction: options.direction } })),
  );

program
  .command("wait")
  .description("次のイベントまでブロックする")
  .option("--timeout <sec>", "秒", "60")
  .action(async (options: { timeout: string }) => {
    const timeoutSec = Number(options.timeout) || 60;
    output(
      await request(`/api/wait?timeout=${timeoutSec}`, { timeoutMs: (timeoutSec + 15) * 1000 }),
    );
  });

program
  .command("overlay")
  .description("コメント欄オーバーレイの表示を更新する")
  .option("--highlight <id>", "強調するコメント ID（none で解除）")
  .option("--subtitle <text>", "字幕（none で消す）")
  .option("--comments <onoff>", "コメント一覧の表示 on|off")
  .action(async (options: { highlight?: string; subtitle?: string; comments?: string }) => {
    const body: Record<string, unknown> = {};
    if (options.highlight !== undefined) body.highlight = options.highlight === "none" ? null : options.highlight;
    if (options.subtitle !== undefined) body.subtitle = options.subtitle === "none" ? null : options.subtitle;
    if (options.comments !== undefined) body.comments = options.comments !== "off";
    output(await request("/api/overlay", { method: "POST", body }));
  });

const session = program.command("session").description("Director セッション操作");
session
  .command("restart")
  .description("初期画像でセッションを張り直す")
  .option("--reason <reason>", "理由（ログ用）", "manual")
  .action(async (options: { reason: string }) =>
    output(await request("/api/session/restart", { method: "POST", body: { reason: options.reason } })),
  );

program
  .command("reset")
  .description("キャラの見た目が崩れたとき、映像を初期画像・default_scene の状態へ戻す")
  .option("--reason <reason>", "理由（ログ用）", "visual drift")
  .action(async (options: { reason: string }) =>
    output(await request("/api/reset", { method: "POST", body: { reason: options.reason } })),
  );

// ---------- 音声（SPEC §5.1） ----------

const audio = program.command("audio").description("配信音声（tts_direct）の確認");
audio
  .command("test")
  .description("任意の wav を compositor に直接再生させる（Director セッションは開かない）")
  .requiredOption("--wav <path>", "再生する wav のパス")
  .option("--at-ms <ms>", "再生する絶対時刻（Date.now() 基準）。省略時は --delay-ms 後")
  .option("--delay-ms <ms>", "今から何 ms 後に鳴らすか", "3000")
  .action(async (options: { wav: string; atMs?: string; delayMs: string }) =>
    output(
      await request("/api/audio/test", {
        method: "POST",
        body: {
          wav: options.wav,
          at_ms: options.atMs === undefined ? null : Number(options.atMs),
          delay_ms: Number(options.delayMs),
        },
      }),
    ),
  );

// ---------- 送出（SPEC §8） ----------

const broadcast = program.command("broadcast").description("送出（Chromium + ffmpeg）の状態・起動・停止");
broadcast
  .command("status")
  .description("送出の状態")
  .action(async () => output(await request("/api/broadcast")));
broadcast
  .command("start")
  .description("送出を開始する（停止後の再開にも使う）")
  .action(async () => output(await request("/api/broadcast/start", { method: "POST", body: {} })));
broadcast
  .command("stop")
  .description("送出だけ止める（デーモンは動かしたまま）")
  .action(async () => output(await request("/api/broadcast/stop", { method: "POST", body: {} })));

program
  .command("frame")
  .description("現在フレームを PNG で保存する")
  .option("--out <path>", "保存先", "./state/frame.png")
  .action(async (options: { out: string }) => {
    const result = (await request("/api/frame", { method: "POST", body: {} })) as {
      ok: boolean;
      data_url?: string;
    };
    if (!result.data_url) fail("frame_failed", "ビューワーがフレームを返さなかった");
    const base64 = result.data_url.replace(/^data:image\/\w+;base64,/, "");
    const out = resolveFromRoot(options.out);
    writeFileSync(out, Buffer.from(base64, "base64"));
    output({ ok: true, path: out, bytes: Buffer.from(base64, "base64").byteLength });
  });

program
  .command("log")
  .description("直近ログ")
  .option("--tail <n>", "行数", "20")
  .action(async (options: { tail: string }) =>
    output(await request(`/api/log?tail=${encodeURIComponent(options.tail)}`)),
  );

const youtube = program.command("youtube").description("YouTube 連携");
youtube
  .command("auth")
  .description("OAuth フローを実行してトークンを保存する")
  .action(async () => {
    try {
      await runOAuthFlow(
        resolveFromRoot(config.youtube.client_secret_path),
        resolveFromRoot(config.youtube.token_path),
      );
      output({ ok: true, token_path: resolveFromRoot(config.youtube.token_path) });
    } catch (error) {
      fail("youtube_auth_failed", String(error));
    }
  });

await program.parseAsync(process.argv);
