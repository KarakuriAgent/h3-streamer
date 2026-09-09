import type { FalClient } from "@fal-ai/client";
import { wma } from "@fal-ai/client/realtime";
import type { ManagedRealtimeSession, RealtimeState } from "@fal-ai/client/realtime";
import type { WmaRealtimeSession } from "@fal-ai/client/realtime/wma";
import type { DirectorControlMessage } from "../../src/shared/protocol.ts";

/**
 * fal Director（`minimax/h3-max/director`）の WMA セッションを 1 つ保持する。
 *
 * Director は WebRTC 前提なので RTCPeerConnection を持てるブラウザ側にセッションを置く。
 * FAL_KEY はここには無く、fal へのリクエストは全て `createFalClient({ proxyUrl })` が
 * デーモンの `/api/fal/proxy` に向ける（元の URL は `x-fal-target-url` ヘッダで渡る）。
 *
 * ページ（ビューワー / compositor）に依存する処理は全てハンドラに出してある。
 */
export interface DirectorSessionHandlers {
  /** モデルから届いた映像・音声トラック。 */
  onMedia(stream: MediaStream): void;
  /** Director のサーバーメッセージ（生の JSON 文字列）。 */
  onData(raw: string): void;
  onState(state: RealtimeState): void;
  onError(message: string): void;
  onDiagnostic(kind: string, message: string): void;
}

export class DirectorSession {
  private handle: ManagedRealtimeSession<WmaRealtimeSession> | null = null;

  constructor(
    private readonly client: FalClient,
    private readonly handlers: DirectorSessionHandlers,
  ) {}

  get isOpen(): boolean {
    return this.handle !== null;
  }

  get state(): RealtimeState | null {
    return this.handle?.state ?? null;
  }

  open(endpoint: string): void {
    this.close();
    this.handle = this.client.realtime.open(wma(endpoint), {
      // 出力だけを受ける。WebRTC の answer は offer に無い m= セクションを足せないので、
      // video / audio の受信スロットは offer 生成前に宣言しておく必要がある。
      receive: ["video", "audio"],
      onMedia: (stream: MediaStream) => this.handlers.onMedia(stream),
      onData: (raw: string) => this.handlers.onData(raw),
      onState: (state) => this.handlers.onState(state),
      onError: (error: unknown) =>
        this.handlers.onError(error instanceof Error ? error.message : String(error)),
      onDiagnostic: (event) =>
        this.handlers.onDiagnostic(event.kind, event.kind === "progress" ? event.phase : event.message),
    });
  }

  /** configure / prompt を送る。セッションが opening の間はクライアントが順序を保って queue する。 */
  send(payload: DirectorControlMessage): void {
    this.handle?.send(payload);
  }

  close(): void {
    if (!this.handle) return;
    void this.handle.close().catch(() => undefined);
    this.handle = null;
  }
}
