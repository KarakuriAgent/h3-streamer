import type { WebSocket } from "ws";
import type { OverlayComment, OverlayState, ToOverlayMessage } from "../shared/protocol.ts";
import type { ChatComment } from "./state.ts";

interface ScheduledSwitch {
  timer: NodeJS.Timeout;
  at: number;
}

/**
 * オーバーレイページ（`/overlay`）への配信。
 *
 * SPEC §5.1：強調・字幕は送信時ではなく `on_air_at` に切り替える。
 * `h3 speak` はスケジュールを積むだけで、実際の切替はここのタイマーが行う。
 */
export class OverlayServer {
  private readonly sockets = new Set<WebSocket>();
  private readonly scheduled: ScheduledSwitch[] = [];
  /** false のとき自動字幕（speak 由来）を出さない。手動の --subtitle は影響しない。 */
  subtitlesEnabled = true;
  private state: OverlayState = {
    comments: [],
    highlight: null,
    subtitle: null,
    commentsVisible: true,
  };

  attach(socket: WebSocket): void {
    this.sockets.add(socket);
    socket.send(JSON.stringify({ type: "snapshot", state: this.state } satisfies ToOverlayMessage));
    socket.on("close", () => this.sockets.delete(socket));
  }

  private broadcast(message: ToOverlayMessage): void {
    const raw = JSON.stringify(message);
    for (const socket of this.sockets) {
      if (socket.readyState === 1) socket.send(raw);
    }
  }

  get snapshot(): OverlayState {
    return this.state;
  }

  get clientCount(): number {
    return this.sockets.size;
  }

  setComments(comments: ChatComment[]): void {
    const mapped: OverlayComment[] = comments.map((c) => ({
      id: c.id,
      author: c.author,
      text: c.text,
      published_at: c.publishedAt,
    }));
    this.state = { ...this.state, comments: mapped };
    this.broadcast({ type: "comments", comments: mapped });
  }

  setHighlight(commentId: string | null): void {
    this.state = { ...this.state, highlight: commentId };
    this.broadcast({ type: "highlight", commentId });
  }

  setSubtitle(text: string | null): void {
    this.state = { ...this.state, subtitle: text };
    this.broadcast({ type: "subtitle", text });
  }

  setCommentsVisible(visible: boolean): void {
    this.state = { ...this.state, commentsVisible: visible };
    this.broadcast({ type: "visible", comments: visible });
  }

  /**
   * **いま**強調と字幕を切り替え、`durationMs` 経過後に字幕を消す。
   *
   * `audio_sync: director_onset`（SPEC §5.1）では、切替の時刻を決めるのは
   * compositor が検知した Director のオンセット（＝実際の発話開始）なので、
   * デーモンは予約を積まずに `audio_started` を受けた瞬間にこれを呼ぶ。
   */
  showNow(commentId: string | null, subtitle: string | null, durationMs: number): void {
    if (commentId !== null) this.setHighlight(commentId);
    this.setSubtitle(subtitle);
    this.push(
      setTimeout(() => {
        // 後続の発話が既に字幕を差し替えていたら触らない。
        if (this.state.subtitle === subtitle) this.setSubtitle(null);
      }, Math.max(0, durationMs)),
      Date.now() + durationMs,
    );
  }

  /**
   * `on_air_at`（絶対時刻 ms）に強調と字幕を切り替える予約。
   * `durationMs` 経過後に字幕を消す。
   */
  schedule(atMs: number, commentId: string | null, subtitle: string | null, durationMs: number): void {
    const delay = Math.max(0, atMs - Date.now());
    this.push(
      setTimeout(() => {
        if (commentId !== null) this.setHighlight(commentId);
        this.setSubtitle(subtitle);
      }, delay),
      atMs,
    );
    this.push(
      setTimeout(
        () => {
          // 後続の発話が既に字幕を差し替えていたら触らない。
          if (this.state.subtitle === subtitle) this.setSubtitle(null);
        },
        delay + durationMs,
      ),
      atMs + durationMs,
    );
  }

  private push(timer: NodeJS.Timeout, at: number): void {
    this.scheduled.push({ timer, at });
    if (this.scheduled.length > 200) {
      const oldest = this.scheduled.shift();
      if (oldest) clearTimeout(oldest.timer);
    }
  }

  /** セッション張り直しなどで予約を捨てる。 */
  clearSchedule(): void {
    for (const entry of this.scheduled) clearTimeout(entry.timer);
    this.scheduled.length = 0;
    this.setSubtitle(null);
  }

  close(): void {
    this.clearSchedule();
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
  }
}
