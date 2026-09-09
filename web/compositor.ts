import { createFalClient } from "@fal-ai/client";
import type {
  AudioSetup,
  FromViewerMessage,
  OverlayState,
  PlayAudioMessage,
  ToOverlayMessage,
  ToViewerMessage,
} from "../src/shared/protocol.ts";
import { AudioMix, DEFAULT_AUDIO_SETUP } from "./lib/audio-mix.ts";
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
const VIDEO_BITRATE = numberParam("vb", 4_500_000);
/** canvas を描き直す間隔（ms）。`broadcast.fps` を超えて描いても送出には乗らない。 */
const FRAME_INTERVAL_MS = 1000 / FPS;
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
let audioSetup: AudioSetup = DEFAULT_AUDIO_SETUP;
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
/**
 * `broadcast.fps` に間引いて描く。requestAnimationFrame は画面の更新に合わせて
 * 60〜120Hz で回るが、送出は fps でしか取らないので描くだけ無駄で、
 * 主スレッドが詰まると MediaRecorder の音声まで途切れる。
 */
function renderFrame(now: number): void {
  requestAnimationFrame(renderFrame);
  const deltaMs = now - lastFrameAtMs;
  // 1ms の余裕を見ておかないと、フレーム間隔がわずかに足りず 1 回おきに落ちる。
  if (deltaMs < FRAME_INTERVAL_MS - 1) return;
  lastFrameAtMs = now;
  frames += 1;

  context.fillStyle = "#000000";
  context.fillRect(0, 0, WIDTH, HEIGHT);
  drawVideo();
  overlay.draw(context, overlayState, WIDTH, HEIGHT, Math.min(100, deltaMs));
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

/**
 * `play_audio` に載ってきた字幕・強調。**その発話が実際に鳴り始めた瞬間**に反映する。
 *
 * 推定 `on_air_at` は Director が口パクを始める時刻と −0.1〜+9.8 秒ずれるので、
 * デーモンのタイマーで切り替えると字幕だけが先に出てしまう（SPEC §5.1）。
 */
interface PendingOverlay {
  subtitle: string | null;
  highlight: string | null;
}
const pendingOverlay = new Map<string, PendingOverlay>();
/** いま出している字幕。消すときに「まだ自分のものか」を確かめる。 */
let shownSubtitle: string | null = null;
let subtitleTimer: number | null = null;

/** 発話が終わってから字幕を消すまでの余韻（ms）。 */
const SUBTITLE_TAIL_MS = 500;

function setOverlay(message: ToOverlayMessage): void {
  overlayState = applyOverlayMessage(overlayState, message);
}

/** 鳴り始めた発話の字幕・強調に切り替え、発話長 + 余韻で字幕を消す。 */
function showOverlayFor(id: string, durationSec: number): void {
  const pending = pendingOverlay.get(id);
  if (!pending) return;
  pendingOverlay.delete(id);
  if (pending.highlight !== null) setOverlay({ type: "highlight", commentId: pending.highlight });
  setOverlay({ type: "subtitle", text: pending.subtitle });
  shownSubtitle = pending.subtitle;

  if (subtitleTimer !== null) window.clearTimeout(subtitleTimer);
  subtitleTimer = window.setTimeout(() => {
    subtitleTimer = null;
    // 後続の発話が既に差し替えていたら触らない。
    if (overlayState.subtitle === shownSubtitle) setOverlay({ type: "subtitle", text: null });
  }, durationSec * 1000 + SUBTITLE_TAIL_MS);
}

/** 実際に鳴り始めた時刻をデーモンへ返す（口パクとのずれの実測。SPEC §5.1）。 */
audio.onStarted = (started) => {
  showOverlayFor(started.id, started.durationSec);
  daemon.send({
    type: "audio_started",
    id: started.id,
    started_at_ms: Math.round(started.startedAtMs),
    trigger: started.trigger,
    at_ms: Math.round(started.atMs),
    duration_sec: Math.round(started.durationSec * 1000) / 1000,
  });
  log(
    `started ${started.id} (${started.trigger}): ` +
      `推定との差 ${Math.round(started.startedAtMs - started.atMs)}ms`,
  );
};

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
  audio.configure(setup);
  log(
    `audio source: ${setup.source} / sync: ${setup.sync}` +
      ` (gain ${setup.tts_gain_db}dB, onset ${setup.onset_threshold_db}dB, fallback ${setup.onset_fallback_sec}s)` +
      (setup.record_director_audio ? " / director 音声を別録り" : ""),
  );
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

/**
 * `play_audio`：wav を鳴らす（`director_onset` ではキューに積んで口パクの開始を待つ）。
 * 予定と実際の時刻はどちらもデーモンへ返す（`audio_scheduled` / `audio_started`）。
 */
function playAudio(message: PlayAudioMessage): void {
  // 字幕・強調は鳴り始めるまで持っておく（デーモンが載せてきたときだけ）。
  if (message.subtitle !== undefined || message.highlight_comment_id !== undefined) {
    pendingOverlay.set(message.id, {
      subtitle: message.subtitle ?? null,
      highlight: message.highlight_comment_id ?? null,
    });
  }
  void audio
    .play(message.id, message.url, message.at_ms, message.duration_sec, message.silent === true)
    .then((scheduled) => {
      if (!scheduled) return;
      if (scheduled.queued) {
        log(`queued ${scheduled.id}: Director のオンセット待ち（${scheduled.durationSec.toFixed(2)}s）`);
        return;
      }
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
      if (message.id === undefined) pendingOverlay.clear();
      else pendingOverlay.delete(message.id);
      const stopped = audio.cancel(message.id);
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
    `audio ${audioSetup.source}/${audioSetup.sync}${audio.pendingPlays > 0 ? ` +${audio.pendingPlays}` : ""}` +
      (audioSetup.sync === "director_onset" ? ` dir ${audio.directorLevelDb.toFixed(0)}dB` : ""),
    RECORD
      ? `uplink ${stats.connected ? "on" : "off"} ${stats.chunks}chunks ${(stats.bytes / 1e6).toFixed(1)}MB avg ${stats.averageIntervalMs}ms`
      : "uplink disabled",
  ].join("  |  ");
}, 1000);

// hello が来るまでは config/stream.yaml の既定と同じ扱いにしておく。
audio.configure(audioSetup);
void audio.resume();
daemon.connect();
overlaySocket.connect();
