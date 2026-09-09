/**
 * デーモンとの WebSocket 接続。切断したら自動で繋ぎ直す。
 *
 * ビューワー（`/ws/viewer`）とオーバーレイ（`/ws/overlay`）で受送信するメッセージ型が
 * 違うだけなので、型引数で分けて 1 つの実装を共有する。
 * 後から足す compositor ページも同じものを使う。
 */
export interface DaemonSocketHandlers<Incoming> {
  onMessage(message: Incoming): void;
  onOpen?(): void;
  onClose?(): void;
}

export class DaemonSocket<Incoming, Outgoing = never> {
  private socket: WebSocket | null = null;
  private closedByUser = false;

  constructor(
    private readonly path: string,
    private readonly handlers: DaemonSocketHandlers<Incoming>,
    private readonly retryMs = 2000,
  ) {}

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.closedByUser = false;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}${this.path}`);
    this.socket = socket;
    socket.onopen = () => this.handlers.onOpen?.();
    socket.onmessage = (event: MessageEvent<string>) => {
      this.handlers.onMessage(JSON.parse(event.data) as Incoming);
    };
    socket.onclose = () => {
      this.socket = null;
      this.handlers.onClose?.();
      if (!this.closedByUser) setTimeout(() => this.connect(), this.retryMs);
    };
  }

  send(message: Outgoing): void {
    if (this.connected) this.socket?.send(JSON.stringify(message));
  }

  close(): void {
    this.closedByUser = true;
    this.socket?.close();
    this.socket = null;
  }
}
