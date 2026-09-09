import { createFalClient } from "@fal-ai/client";
import type { FromViewerMessage, ToViewerMessage } from "../src/shared/protocol.ts";
import { DaemonSocket } from "./lib/daemon-socket.ts";
import { DirectorSession } from "./lib/director-session.ts";
import { MediaStage } from "./lib/media-stage.ts";

/**
 * ビューワーページ。
 *
 * 役割は 3 つで、それぞれ web/lib に分けてある：
 *   - DirectorSession … fal の WMA セッションを保持する
 *   - MediaStage      … 届いたトラックを 1 本にまとめて `<video>` に流す（合成の入力）
 *   - DaemonSocket    … デーモンの制御メッセージを中継する
 * 送出は自前合成（SPEC §8-B）にするので、compositor ページはこの 3 つを使い回し、
 * MediaStage の上に canvas 合成と MediaRecorder を足す形で作る。
 */
const stage = new MediaStage(document.getElementById("stage") as HTMLVideoElement);
const statusEl = document.getElementById("status") as HTMLElement;
const logEl = document.getElementById("log") as HTMLElement;
const startButton = document.getElementById("start") as HTMLButtonElement;

const client = createFalClient({ proxyUrl: "/api/fal/proxy" });

/** 今デーモンが有効だと思っているセッション番号。古い control は捨てる。 */
let currentSeq = 0;

function log(message: string): void {
  const time = new Date().toLocaleTimeString();
  logEl.textContent = `${time}  ${message}\n${logEl.textContent}`.slice(0, 8000);
}

const socket = new DaemonSocket<ToViewerMessage, FromViewerMessage>("/ws/viewer", {
  onOpen: () => {
    statusEl.textContent = "daemon connected";
    socket.send({ type: "ready" });
  },
  onClose: () => {
    statusEl.textContent = "daemon disconnected — retrying";
  },
  onMessage: (message) => handleDaemonMessage(message),
});

const session = new DirectorSession(client, {
  onMedia: (incoming) => {
    const kinds = stage.addTracks(incoming);
    void stage.play().catch((error: unknown) => log(`autoplay blocked: ${String(error)}`));
    log(`media: ${kinds.join("+")}`);
  },
  onData: (raw) => socket.send({ type: "director_message", sessionSeq: currentSeq, raw }),
  onState: (state) => {
    statusEl.textContent = `session ${currentSeq}: ${state}`;
    socket.send({ type: "session_state", sessionSeq: currentSeq, state });
    log(`state: ${state}`);
  },
  onError: (message) => {
    log(`error: ${message}`);
    socket.send({ type: "viewer_error", message });
  },
  onDiagnostic: (kind, message) => socket.send({ type: "diagnostic", kind, message }),
});

function closeSession(): void {
  session.close();
  stage.clear();
}

function handleDaemonMessage(message: ToViewerMessage): void {
  switch (message.type) {
    case "hello":
      log(`daemon endpoint: ${message.endpoint}`);
      break;
    case "open_session":
      closeSession();
      currentSeq = message.sessionSeq;
      log(`opening wma session on ${message.endpoint}`);
      socket.send({ type: "session_state", sessionSeq: currentSeq, state: "opening" });
      session.open(message.endpoint);
      break;
    case "close_session":
      log(`closing session ${message.sessionSeq}`);
      closeSession();
      socket.send({ type: "session_state", sessionSeq: message.sessionSeq, state: "closed" });
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
      try {
        socket.send({ type: "frame", requestId: message.requestId, dataUrl: stage.captureFrame() });
      } catch (error) {
        socket.send({ type: "frame", requestId: message.requestId, error: String(error) });
      }
      break;
  }
}

// 音声の自動再生にはユーザー操作を要求するブラウザがあるので明示ボタンを置く。
startButton.addEventListener("click", () => {
  stage.element.muted = false;
  void stage.play();
  startButton.disabled = true;
  startButton.textContent = "再生中";
});

socket.connect();
