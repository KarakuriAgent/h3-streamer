import type { ToOverlayMessage } from "../src/shared/protocol.ts";
import { DaemonSocket } from "./lib/daemon-socket.ts";
import { OverlayView } from "./lib/overlay-view.ts";

/**
 * オーバーレイページ。背景は透過で、自前合成（SPEC §8-B）でも
 * OBS のブラウザソースでもそのまま重ねられる。
 * 描画は OverlayView、通信は DaemonSocket に分けてある。
 */
const view = new OverlayView({
  list: document.getElementById("comments") as HTMLElement,
  subtitle: document.getElementById("subtitle") as HTMLElement,
});
view.render();

const socket = new DaemonSocket<ToOverlayMessage>("/ws/overlay", {
  onMessage: (message) => view.apply(message),
});
socket.connect();
