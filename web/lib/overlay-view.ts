import type { OverlayComment, OverlayState, ToOverlayMessage } from "../../src/shared/protocol.ts";
import { applyOverlayMessage, EMPTY_OVERLAY_STATE } from "./overlay-state.ts";

/**
 * コメント欄・強調・字幕の描画。
 *
 * デーモンから届いたメッセージを状態に畳み込んで DOM に反映するだけで、
 * WebSocket も DOM の生成も知らない。オーバーレイページが使う。
 * compositor ページは DOM ではなく canvas に描くので、状態の畳み込み
 * （`overlay-state.ts`）だけを共有し、描画は `overlay-draw.ts` が持つ。
 */
export interface OverlayElements {
  list: HTMLElement;
  subtitle: HTMLElement;
}

export class OverlayView {
  private current: OverlayState = EMPTY_OVERLAY_STATE;

  constructor(private readonly elements: OverlayElements) {}

  get state(): OverlayState {
    return this.current;
  }

  /** デーモンからの 1 メッセージを畳み込んで再描画する。 */
  apply(message: ToOverlayMessage): void {
    this.current = applyOverlayMessage(this.current, message);
    this.render();
  }

  render(): void {
    const { list, subtitle } = this.elements;
    list.style.display = this.current.commentsVisible ? "flex" : "none";
    list.replaceChildren(...this.current.comments.map((comment) => this.renderComment(comment)));
    subtitle.textContent = this.current.subtitle ?? "";
    subtitle.style.opacity = this.current.subtitle ? "1" : "0";
  }

  private renderComment(comment: OverlayComment): HTMLElement {
    const item = document.createElement("div");
    item.className = comment.id === this.current.highlight ? "comment highlight" : "comment";
    const author = document.createElement("span");
    author.className = "author";
    author.textContent = comment.author;
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = comment.text;
    item.append(author, text);
    return item;
  }
}
