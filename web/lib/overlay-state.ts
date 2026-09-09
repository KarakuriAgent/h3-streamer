import type { OverlayState, ToOverlayMessage } from "../../src/shared/protocol.ts";

/**
 * デーモンから届くオーバーレイメッセージを 1 つの状態に畳み込む。
 *
 * DOM で描く `/overlay`（OBS ブラウザソース用）と canvas に描く `/compositor` の
 * 両方が同じ状態を持つので、畳み込みだけをここに置く。描画は各ページの責務。
 */
export const EMPTY_OVERLAY_STATE: OverlayState = {
  comments: [],
  highlight: null,
  subtitle: null,
  commentsVisible: true,
};

export function applyOverlayMessage(state: OverlayState, message: ToOverlayMessage): OverlayState {
  switch (message.type) {
    case "snapshot":
      return message.state;
    case "comments":
      return { ...state, comments: message.comments };
    case "highlight":
      return { ...state, highlight: message.commentId };
    case "subtitle":
      return { ...state, subtitle: message.text };
    case "visible":
      return { ...state, commentsVisible: message.comments };
  }
}
