import { createFalClient } from "@fal-ai/client";
import type {
  AudioSetup,
  FromViewerMessage,
  OverlayState,
  PlayAudioMessage,
  ToOverlayMessage,
  ToViewerMessage,
} from "../src/shared/protocol.ts";
import { AudioMix } from "./lib/audio-mix.ts";
import { DaemonSocket } from "./lib/daemon-socket.ts";
import { DirectorSession } from "./lib/director-session.ts";
import { MediaStage } from "./lib/media-stage.ts";
import { MediaUplink } from "./lib/media-uplink.ts";
import { OverlayRenderer } from "./lib/overlay-draw.ts";
import { applyOverlayMessage, EMPTY_OVERLAY_STATE } from "./lib/overlay-state.ts";

/**
 * 合成ページ（SPEC §8）。
 *
 * ビューワー（`/viewer`）と同じ制御プロトコルで Director セッションを保持しつつ、
 * その映像とオーバーレイを 1 枚の canvas に合成し、`canvas.captureStream()` と
 * WebAudio でまとめた音声を MediaRecorder で webm にして、デーモン（`/ws/media`）
 * へ流す。デーモンは受けたチャンクを ffmpeg に渡して RTMP へ送出する。
 *
 * broadcaster.ts が headless Chromium でこのページを開く。人が普通のブラウザで
 * 開けば同じ画をそのまま目視できる（`?record=0` を付ければ送出しない）。
 *
 * 注意：ページを 2 枚開くとデーモンは新しい方だけをビューワーとして扱う
 * （`DirectorController.attach`）。`/viewer` と併用しないこと。
 */

const params = new URLSearchParams(location.search);
const numberParam = (name: string, fallback: number): number => {
  const value = Number(params.get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const WIDTH = numberParam("w", 1280);
const HEIGHT = numberParam("h", 720);
const FPS = numberParam("fps", 30);
const VIDEO_BITRATE = numberParam("vb", 6_000_000);
const RECORD = params.get("record") !== "0";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
canvas.width = WIDTH;
canvas.height = HEIGHT;
const context = ((): CanvasRenderingContext2D => {
  const found = canvas.getContext("2d", { alpha: false });
  if (!found) throw new Error("2d context unavailable");
  return found;
})();

const video = document.getElementById("source") as HTMLVideoElement;
const statusEl = document.getElementById("status") as HTMLElement;
const logEl = document.getElementById("log") as HTMLElement;

const stage = new MediaStage(video);
const overlay = new OverlayRenderer();
const audio = new AudioMix();
let overlayState: OverlayState = EMPTY_OVERLAY_STATE;
/**
 * 音声設定（SPEC §5.1）。デーモンの `hello` で上書きされるまでは
 * `config/stream.yaml` の既定（tts_direct・別録りなし）と同じ扱いにする。
 */
let audioSetup: AudioSetup = { source: "tts_direct", record_director_audio: false };
/** Director 音声だけの別録り（解析用）。record_director_audio のときだけ動かす。 */
let directorAudioUplink: MediaUplink | null = null;
/** 今デーモンが有効だと思っているセッション番号。古い control は捨てる。 */
let currentSeq = 0;
let frames = 0;
let fpsMeasured = 0;

function log(message: string): void {
  const time = new Date().toLocaleTimeString();
  // headless で動くので、ページの表示だけでなく console にも出す（broadcaster が拾う）。
  console.log(`[compositor] ${message}`);
  logEl.textContent = `${time}  ${message}\n${logEl.textContent}`.slice(0, 8000);
}

// ---------- 合成ループ ----------

/** `<video>` を canvas いっぱいに（アスペクト比を保って cover で）描く。 */
function drawVideo(): void {
  const sourceWidth = stage.width;
  const sourceHeight = stage.height;
  if (sourceWidth === 0 || sourceHeight === 0 || video.readyState < 2) return;
  const scale = Math.max(WIDTH / sourceWidth, HEIGHT / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(video, (WIDTH - drawWidth) / 2, (HEIGHT - drawHeight) / 2, drawWidth, drawHeight);
}

let lastFrameAtMs = performance.now();
function renderFrame(now: number): void {
  const deltaMs = Math.min(100, now - lastFrameAtMs);
  lastFrameAtMs = now;
  frames += 1;

  context.fillStyle = "#000000";
  context.fillRect(0, 0, WIDTH, HEIGHT);
  drawVideo();
  overlay.draw(context, overlayState, WIDTH, HEIGHT, deltaMs);

  requestAnimationFrame(renderFrame);
}
requestAnimationFrame(renderFrame);

// ---------- 送出 ----------

const outgoing = new MediaStream();
for (const track of canvas.captureStream(FPS).getVideoTracks()) outgoing.addTrack(track);
outgoing.addTrack(audio.track);

const uplink = new MediaUplink(outgoing, {
  timesliceMs: numberParam("timeslice", 500),
  videoBitsPerSecond: VIDEO_BITRATE,
  onLog: log,
});
if (RECORD) uplink.start();
else log("record=0: 合成だけ行い、送出はしない");

// ---------- Director（`/viewer` と同じプロトコル） ----------

const client = createFalClient({ proxyUrl: "/api/fal/proxy" });

const daemon = new DaemonSocket<ToViewerMessage, FromViewerMessage>("/ws/viewer", {
  onOpen: () => {
    log("daemon connected");
    daemon.send({ type: "ready" });
  },
  onClose: () => log("daemon disconnected — retrying"),
  onMessage: (message) => handleDaemonMessage(message),
});

const session = new DirectorSession(client, {
  onMedia: (incoming) => {
    const kinds = stage.addTracks(incoming);
    audio.addStream(incoming);
    void audio.resume();
    // 映像は canvas に描くだけなので `<video>` は無音で再生する（音は WebAudio 側）。
    void stage.play().catch((error: unknown) => log(`play blocked: ${String(error)}`));
    log(`media: ${kinds.join("+")}`);
  },
  onData: (raw) => daemon.send({ type: "director_message", sessionSeq: currentSeq, raw }),
  onState: (state) => {
    daemon.send({ type: "session_state", sessionSeq: currentSeq, state });
    log(`state: ${state}`);
  },
  onError: (message) => {
    log(`error: ${message}`);
    daemon.send({ type: "viewer_error", message });
  },
  onDiagnostic: (kind, message) => daemon.send({ type: "diagnostic", kind, message }),
});

function closeSession(): void {
  session.close();
  stage.clear();
  audio.clear();
}

/**
 * `hello` で届いた音声設定を反映する。
 * `tts_direct` では Director の音声トラックのゲインを 0 にし（口パクの条件付け専用）、
 * 配信音声は `play_audio` で届く TTS wav の直接再生だけにする。
 */
function applyAudioSetup(setup: AudioSetup): void {
  audioSetup = setup;
  audio.setSource(setup.source);
  log(`audio source: ${setup.source}${setup.record_director_audio ? " (director 音声を別録り)" : ""}`);
  if (setup.record_director_audio && !directorAudioUplink) {
    // 送出用のゲインより手前から取るので、tts_direct でも Director の声がそのまま録れる。
    directorAudioUplink = new MediaUplink(audio.directorOnlyStream(), {
      path: "/ws/director-audio",
      mimeType: "audio/webm;codecs=opus",
      timesliceMs: 1000,
      onLog: (text) => log(`director-audio: ${text}`),
    });
    directorAudioUplink.start();
  }
}

/** `play_audio`：指定時刻に wav を鳴らし、実際の時刻をデーモンへ返す。 */
function playAudio(message: PlayAudioMessage): void {
  void audio
    .play(message.id, message.url, message.at_ms, message.duration_sec)
    .then((scheduled) => {
      if (!scheduled) return;
      daemon.send({
        type: "audio_scheduled",
        id: scheduled.id,
        at_ms: message.at_ms,
        starts_at_ms: Math.round(scheduled.startsAtMs),
        skipped_sec: scheduled.skippedSec,
        duration_sec: scheduled.durationSec,
      });
      log(
        `play ${scheduled.id}: ${Math.round(scheduled.startsAtMs - message.at_ms)}ms 差` +
          (scheduled.skippedSec > 0 ? ` / 頭を ${scheduled.skippedSec}s 切った` : ""),
      );
    })
    .catch((error: unknown) => {
      log(`play ${message.id} failed: ${String(error)}`);
      daemon.send({ type: "audio_error", id: message.id, message: String(error) });
    });
}

function handleDaemonMessage(message: ToViewerMessage): void {
  switch (message.type) {
    case "hello":
      log(`daemon endpoint: ${message.endpoint}`);
      applyAudioSetup(message.audio);
      break;
    case "play_audio":
      playAudio(message);
      break;
    case "cancel_audio": {
      const stopped = audio.stop(message.id);
      log(`cancel_audio${message.id ? ` ${message.id}` : ""}: ${stopped} 件止めた`);
      break;
    }
    case "open_session":
      closeSession();
      currentSeq = message.sessionSeq;
      log(`opening wma session on ${message.endpoint}`);
      daemon.send({ type: "session_state", sessionSeq: currentSeq, state: "opening" });
      session.open(message.endpoint);
      break;
    case "close_session":
      log(`closing session ${message.sessionSeq}`);
      closeSession();
      daemon.send({ type: "session_state", sessionSeq: message.sessionSeq, state: "closed" });
      break;
    case "control":
      if (message.sessionSeq !== currentSeq) {
        log(`dropping control for stale session ${message.sessionSeq}`);
        break;
      }
      session.send(message.payload);
      log(`→ ${message.payload.type}`);
      break;
    case "capture_frame":
      // `h3 frame` は合成後の画（オーバーレイ込み）を返す。
      try {
        daemon.send({ type: "frame", requestId: message.requestId, dataUrl: canvas.toDataURL("image/png") });
      } catch (error) {
        daemon.send({ type: "frame", requestId: message.requestId, error: String(error) });
      }
      break;
  }
}

// ---------- オーバーレイ ----------

const overlaySocket = new DaemonSocket<ToOverlayMessage>("/ws/overlay", {
  onMessage: (message) => {
    overlayState = applyOverlayMessage(overlayState, message);
  },
});

// ---------- 状態表示 ----------

setInterval(() => {
  fpsMeasured = frames;
  frames = 0;
  const stats = uplink.stats;
  statusEl.textContent = [
    `${WIDTH}x${HEIGHT}@${FPS}`,
    `draw ${fpsMeasured}fps`,
    `session ${currentSeq}:${session.state ?? "-"}`,
    `audio ${audioSetup.source}${audio.pendingPlays > 0 ? ` +${audio.pendingPlays}` : ""}`,
    RECORD
      ? `uplink ${stats.connected ? "on" : "off"} ${stats.chunks}chunks ${(stats.bytes / 1e6).toFixed(1)}MB avg ${stats.averageIntervalMs}ms`
      : "uplink disabled",
  ].join("  |  ");
}, 1000);

// hello が来るまでは config/stream.yaml の既定と同じ扱いにしておく。
audio.setSource(audioSetup.source);
void audio.resume();
daemon.connect();
overlaySocket.connect();
