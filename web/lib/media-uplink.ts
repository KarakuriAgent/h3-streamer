/**
 * 合成した映像・音声を MediaRecorder で webm にして、バイナリ WebSocket
 * （`/ws/media`）でデーモンへ流す（SPEC §8）。デーモン側は受けたチャンクを
 * そのまま ffmpeg の stdin に書き、ffmpeg が RTMP へ送出する。
 *
 * webm は先頭チャンクにヘッダ（EBML / Segment）があり、以降はそれに続く
 * クラスタなので、**途中から繋いだ ffmpeg は読めない**。そのため
 *   - WS が繋がってから録画を始める
 *   - WS が切れたら録画を止め、繋ぎ直してから新しいヘッダで録り直す
 * という順序を必ず守る。デーモン側も接続ごとに ffmpeg を起動し直す。
 */
export interface MediaUplinkOptions {
  /** WebSocket のパス（既定 `/ws/media`）。 */
  path?: string;
  /** `MediaRecorder` に渡す MIME。 */
  mimeType?: string;
  /** `ondataavailable` の間隔（ms）。 */
  timesliceMs?: number;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
  retryMs?: number;
  onLog?(message: string): void;
}

export interface MediaUplinkStats {
  connected: boolean;
  recording: boolean;
  chunks: number;
  bytes: number;
  /** 直近チャンクの到着間隔（ms）。実測値。 */
  lastIntervalMs: number;
  /** チャンク間隔の移動平均（ms）。 */
  averageIntervalMs: number;
  bufferedAmount: number;
}

const DEFAULTS = {
  path: "/ws/media",
  mimeType: "video/webm;codecs=vp8,opus",
  timesliceMs: 500,
  videoBitsPerSecond: 6_000_000,
  audioBitsPerSecond: 160_000,
  retryMs: 2000,
};

/** これを超えて送信バッファが溜まったら、詰まっているとみなして警告する。 */
const BACKPRESSURE_BYTES = 8 * 1024 * 1024;

export class MediaUplink {
  private readonly options: Required<Omit<MediaUplinkOptions, "onLog">> & { onLog: (m: string) => void };
  private socket: WebSocket | null = null;
  private recorder: MediaRecorder | null = null;
  private retryTimer: number | null = null;
  private stopped = true;
  /** Blob → ArrayBuffer は非同期なので、送信順が入れ替わらないよう直列化する。 */
  private sendChain: Promise<void> = Promise.resolve();

  private chunks = 0;
  private bytes = 0;
  private lastChunkAtMs = 0;
  private lastIntervalMs = 0;
  private averageIntervalMs = 0;

  constructor(
    private readonly stream: MediaStream,
    options: MediaUplinkOptions = {},
  ) {
    this.options = {
      path: options.path ?? DEFAULTS.path,
      mimeType: options.mimeType ?? DEFAULTS.mimeType,
      timesliceMs: options.timesliceMs ?? DEFAULTS.timesliceMs,
      videoBitsPerSecond: options.videoBitsPerSecond ?? DEFAULTS.videoBitsPerSecond,
      audioBitsPerSecond: options.audioBitsPerSecond ?? DEFAULTS.audioBitsPerSecond,
      retryMs: options.retryMs ?? DEFAULTS.retryMs,
      onLog: options.onLog ?? (() => undefined),
    };
  }

  get stats(): MediaUplinkStats {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      recording: this.recorder?.state === "recording",
      chunks: this.chunks,
      bytes: this.bytes,
      lastIntervalMs: this.lastIntervalMs,
      averageIntervalMs: Math.round(this.averageIntervalMs),
      bufferedAmount: this.socket?.bufferedAmount ?? 0,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.stopRecording();
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}${this.options.path}`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.onopen = () => {
      this.options.onLog("media uplink connected");
      this.startRecording();
    };
    socket.onclose = (event) => {
      this.options.onLog(`media uplink closed (${event.code} ${event.reason})`);
      this.stopRecording();
      if (this.socket === socket) this.socket = null;
      this.scheduleRetry();
    };
    socket.onerror = () => this.options.onLog("media uplink socket error");
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer !== null) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.options.retryMs);
  }

  private startRecording(): void {
    if (this.recorder) return;
    const { mimeType } = this.options;
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      this.options.onLog(`mimeType not supported: ${mimeType}`);
      return;
    }
    const recorder = new MediaRecorder(this.stream, {
      mimeType,
      videoBitsPerSecond: this.options.videoBitsPerSecond,
      audioBitsPerSecond: this.options.audioBitsPerSecond,
    });
    recorder.ondataavailable = (event) => this.push(event.data);
    recorder.onerror = (event) => this.options.onLog(`recorder error: ${String(event)}`);
    recorder.start(this.options.timesliceMs);
    this.recorder = recorder;
    this.lastChunkAtMs = 0;
    this.options.onLog(`recording started (${mimeType}, ${this.options.timesliceMs}ms)`);
  }

  private stopRecording(): void {
    const recorder = this.recorder;
    this.recorder = null;
    if (!recorder || recorder.state === "inactive") return;
    recorder.ondataavailable = null;
    try {
      recorder.stop();
    } catch {
      /* すでに止まっていれば何もしない */
    }
  }

  private push(blob: Blob): void {
    if (blob.size === 0) return;
    const now = performance.now();
    if (this.lastChunkAtMs > 0) {
      this.lastIntervalMs = Math.round(now - this.lastChunkAtMs);
      this.averageIntervalMs =
        this.averageIntervalMs === 0
          ? this.lastIntervalMs
          : this.averageIntervalMs * 0.8 + this.lastIntervalMs * 0.2;
    }
    this.lastChunkAtMs = now;
    this.chunks += 1;
    this.bytes += blob.size;

    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > BACKPRESSURE_BYTES) {
      this.options.onLog(`uplink backpressure: ${socket.bufferedAmount} bytes buffered`);
    }
    this.sendChain = this.sendChain.then(async () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(await blob.arrayBuffer());
    });
  }
}
