import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { StreamConfig } from "./config.ts";
import type { CharacterConfig } from "./config.ts";
import { buildConfigurePrompt } from "./prompt.ts";
import type { StreamState } from "./state.ts";
import {
  describeDirectorError,
  type AudioSetup,
  type PlayAudioMessage,
  type DirectorConfigure,
  type DirectorPrompt,
  type DirectorPromptRequest,
  type DirectorServerMessage,
  type DirectorSessionInfo,
  type FromViewerMessage,
  type ToViewerMessage,
} from "../shared/protocol.ts";

export class DirectorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "DirectorError";
  }
}

/**
 * セッションが死んでいるのに `h3 speak` が成功し続けるのを防ぐためのエラー。
 * `h3 session restart` / `h3 reset` で復帰する。
 */
export class SessionEndedError extends DirectorError {
  readonly reason: string;
  constructor(reason: string) {
    super(
      "session_ended",
      `Director セッションが終了している（${reason}）。h3 session restart で張り直す。`,
    );
    this.reason = reason;
    this.name = "SessionEndedError";
  }
}

/**
 * compositor / ビューワーから届いたエラー文が「セッションが死んだ」ことを示すか。
 *
 * 実測（初回配信）：
 * `control data channel closed or errored — SCTP died while ICE may still say connected`
 * が出た時点で映像は止まっていたが、デーモンは `session_state: live` のままだった。
 */
const SESSION_ENDED_PATTERNS = [
  /data channel (?:closed|errored)/i,
  /data channel closed or errored/i,
  /sctp died/i,
  /peer ?connection (?:closed|failed)/i,
  /ice (?:connection )?failed/i,
];

export function isSessionEndedMessage(text: string): boolean {
  return SESSION_ENDED_PATTERNS.some((pattern) => pattern.test(text));
}

interface FrameRequest {
  resolve: (dataUrl: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * ビューワーページ（`/viewer`）が保持する fal Director セッションの制御。
 *
 * Director は WebRTC(WMA) 前提なので、RTCPeerConnection を持てるブラウザ側が
 * セッションの実体を持つ。デーモンは configure / prompt を WS で送り、
 * ページから返ってくるサーバーメッセージを state に反映するだけ。
 */
export class DirectorController {
  private socket: WebSocket | null = null;
  private readonly frameRequests = new Map<string, FrameRequest>();
  /** 画像を fal storage に上げた URL。セッション張り直しでも同じものを使う。 */
  imageUrl: string | null = null;
  /**
   * セッション内の prompt 版番号。configure が 1、以後 prompt ごとに +1。
   *
   * 同じ番号で送ると Director が `stale_prompt_version`（"prompt_version must increase"）
   * を返してプロンプトを丸ごと捨てる（実測）。採番はここに閉じ込め、呼び出し側は触らない。
   */
  private promptVersion = 1;
  /**
   * `audio_applied`（Director が音声をキューに載せた実測）を受けたときのフック。
   * デーモンが `tts_direct` の再生時刻を実測に合わせて撃ち直すために使う。
   */
  onAudioApplied: ((message: DirectorServerMessage) => void) | null = null;
  /**
   * compositor が実際に TTS を鳴らし始めたときのフック（`audio_started`）。
   * デーモンは推定との差を `tts-schedule-<run>.jsonl` と `h3 status` に残す。
   */
  onAudioStarted: ((message: Extract<FromViewerMessage, { type: "audio_started" }>) => void) | null = null;

  constructor(
    private readonly config: StreamConfig,
    private readonly character: CharacterConfig,
    private readonly state: StreamState,
  ) {}

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === 1;
  }

  /** compositor に渡す音声設定（SPEC §5.1）。ページ側はこれだけを見る。 */
  get audioSetup(): AudioSetup {
    return {
      source: this.config.audio_source,
      record_director_audio: this.config.broadcast.record_director_audio,
      sync: this.config.audio_sync,
      onset_threshold_db: this.config.onset_threshold_db,
      onset_fallback_sec: this.config.onset_fallback_sec,
      tts_gain_db: this.config.tts_gain_db,
    };
  }

  attach(socket: WebSocket): void {
    if (this.socket && this.socket !== socket) {
      // ビューワーは 1 枚だけ。後から来たものを採用する。
      try {
        this.socket.close(4000, "replaced by a newer viewer");
      } catch {
        /* noop */
      }
    }
    this.socket = socket;
    this.state.log("info", "viewer connected");
    this.send({ type: "hello", endpoint: this.config.endpoint, audio: this.audioSetup });

    socket.on("message", (data) => {
      let parsed: FromViewerMessage;
      try {
        parsed = JSON.parse(String(data)) as FromViewerMessage;
      } catch {
        return;
      }
      this.handleViewerMessage(parsed);
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
        // セッションの実体はページ側なので、ページが消えたらセッションも無い。
        if (!this.state.isSessionEnded()) this.state.sessionState = "closed";
        this.state.log("warn", "viewer disconnected");
      }
    });
  }

  private send(message: ToViewerMessage): void {
    if (!this.connected) {
      throw new DirectorError(
        "viewer_not_connected",
        `ビューワーページが繋がっていない。ブラウザで http://${this.config.ports.host}:${this.config.ports.api}/viewer を開く。`,
      );
    }
    this.socket?.send(JSON.stringify(message));
  }

  private handleViewerMessage(message: FromViewerMessage): void {
    switch (message.type) {
      case "ready":
        this.state.log("info", "viewer ready");
        break;
      case "session_state":
        this.state.log("info", `director session ${message.sessionSeq}: ${message.state}`);
        if (message.state === "failed") {
          this.state.recordError(`director session ${message.sessionSeq} failed`);
          this.state.endSession(`session ${message.sessionSeq} failed`);
          break;
        }
        // 終了済みのセッションは張り直す（startSession）まで状態を戻さない。
        if (this.state.isSessionEnded()) break;
        this.state.sessionState = message.state;
        break;
      case "director_message":
        this.handleDirectorMessage(message.raw);
        break;
      case "diagnostic":
        this.state.log(message.kind === "failure" ? "error" : "info", `wma: ${message.message}`);
        break;
      case "viewer_error":
        this.state.recordError(`viewer: ${message.message}`);
        // data channel が閉じた＝セッションはもう生きていない。
        if (isSessionEndedMessage(message.message)) {
          this.state.endSession(`control channel closed: ${message.message}`);
        }
        break;
      case "audio_scheduled":
        // tts_direct の実際の再生時刻。指定との差はここでしか分からないので必ず残す。
        this.state.log(
          "info",
          `audio_scheduled ${message.id}: at=${message.at_ms} starts=${message.starts_at_ms} ` +
            `(${message.starts_at_ms - message.at_ms}ms) skipped=${message.skipped_sec}s`,
        );
        break;
      case "audio_started":
        // 口パク（Director 音声のオンセット）に合わせて鳴らした実測。次回の計測用に必ず残す。
        this.state.log(
          "info",
          `audio_started ${message.id} (${message.trigger}): started=${message.started_at_ms} ` +
            `at=${message.at_ms} 差=${message.started_at_ms - message.at_ms}ms`,
        );
        this.onAudioStarted?.(message);
        break;
      case "audio_error":
        this.state.recordError(`compositor audio ${message.id}: ${message.message}`);
        break;
      case "frame": {
        const pending = this.frameRequests.get(message.requestId);
        if (!pending) break;
        this.frameRequests.delete(message.requestId);
        clearTimeout(pending.timer);
        if (message.dataUrl) pending.resolve(message.dataUrl);
        else pending.reject(new DirectorError("frame_failed", message.error ?? "frame capture failed"));
        break;
      }
    }
  }

  /** ページから中継された Director のサーバーメッセージを state に反映する。 */
  private handleDirectorMessage(raw: string): void {
    // 加工前に必ず残す（何が届くかを後から生のまま確認できるようにする）。
    this.state.logDirectorRaw("in", raw);
    let message: DirectorServerMessage;
    try {
      message = JSON.parse(raw) as DirectorServerMessage;
    } catch {
      this.state.log("warn", `director message was not JSON: ${raw.slice(0, 200)}`);
      return;
    }
    this.state.lastDirectorMessage = {
      type: message.type,
      at: new Date().toISOString(),
      body: message,
    };
    switch (message.type) {
      case "chunk":
        this.state.onChunk(message);
        break;
      case "session_info":
        // 能力表（チャンク尺・セッション上限・音声要件）。上限は設定値より優先する。
        this.state.onSessionInfo(message as DirectorSessionInfo);
        this.state.log(
          "info",
          `director session_info: max_session_sec=${String(message.max_session_seconds)} ` +
            `chunk=${String(message.default_chunk_duration)}s playback=${String(message.continuation_playback_seconds)}s ` +
            `fps=${String(message.fps)} conditioning_audio_hz=${String(message.conditioning_audio_sample_rate)}`,
        );
        break;
      case "configured":
        if (this.state.isSessionEnded()) break;
        this.state.sessionState = "live";
        this.state.log("info", "director configured");
        break;
      case "prompt_pending":
      case "prompt_applied":
      case "audio_pending":
        this.state.log("info", `director ${message.type} (prompt_version=${String(message.prompt_version)})`);
        break;
      case "audio_applied": {
        // 実測のキュー残（remaining_seconds）が載っているので、推定をこれに合わせる。
        const remaining = message.remaining_seconds;
        if (typeof remaining === "number") this.state.syncAudioQueue(remaining);
        // キュー残の実測が入ったので、tts_direct の再生時刻を撃ち直せるようにする。
        this.onAudioApplied?.(message);
        this.state.log(
          "info",
          `director audio_applied (prompt_version=${String(message.prompt_version)}, ` +
            `duration=${String(message.duration_seconds)}s, remaining=${String(remaining)}s, ` +
            `queued_sources=${String(message.queued_sources)})`,
        );
        break;
      }
      case "prompt_rejected":
      case "audio_rejected":
        // 送ったプロンプト・音声が採用されなかった。黙って消えると原因が分からないので必ず残す。
        this.state.recordError(`director ${message.type}: ${describeDirectorError(message)}`);
        break;
      case "audio_exhausted":
        // 積んだ音声を全部流し切った。キュー残の推定を実測に合わせる。
        this.state.resetAudioQueue();
        this.state.log("info", "director audio_exhausted");
        this.state.pushEvent({ event: "queue_empty", message: "director audio_exhausted" });
        break;
      case "deadline_missed":
        // 生成が再生に間に合わなかった（映像が固まり音が切れる）。頻発したら要調査。
        this.state.log(
          "warn",
          `director deadline_missed: chunk=${String(message.chunk_index)} late_by=${String(message.late_by_seconds)}s`,
        );
        break;
      case "stream_exhausted":
        // セッションの生成上限に達した。これ以上 prompt を送っても何も出ない。
        this.state.recordError(`director stream_exhausted: ${JSON.stringify(message).slice(0, 300)}`);
        this.state.endSession("stream_exhausted");
        break;
      case "chunk_metrics":
      case "session_metrics":
      case "pong":
        // 詳細は state/log/director-raw.jsonl に生のまま残っているので daemon.log には出さない。
        break;
      case "error":
        this.state.recordError(`director: ${describeDirectorError(message)}`);
        break;
      default:
        this.state.log("info", `director ${message.type}`);
    }
  }

  /** 初期画像を fal storage に上げる（初回のみ）。 */
  async ensureImageUrl(upload: (path: string) => Promise<string>): Promise<string> {
    this.imageUrl ??= await upload(this.character.imagePath);
    return this.imageUrl;
  }

  /** セッションを開き configure を送る。 */
  configure(imageUrl: string, audioUrl?: string): DirectorConfigure {
    this.state.startSession();
    // 版番号はセッションごとに 1 から振り直す。
    this.promptVersion = 1;
    const payload: DirectorConfigure = {
      type: "configure",
      protocol_version: 1,
      prompt_version: this.promptVersion,
      prompt: buildConfigurePrompt(this.character.visual),
      image_url: imageUrl,
      aspect_ratio: this.config.aspect_ratio,
      resolution: this.config.resolution,
      memory: this.config.memory,
      ...(audioUrl ? { audio_url: audioUrl } : {}),
    };
    this.send({ type: "open_session", sessionSeq: this.state.sessionSeq, endpoint: this.config.endpoint });
    this.send({ type: "control", sessionSeq: this.state.sessionSeq, payload });
    this.state.logDirectorRaw("out", JSON.stringify(payload));
    return payload;
  }

  /**
   * prompt を送る（speak / direct 共通）。版番号はここで採番する。
   *
   * Director は `prompt_version` が前回以下だとプロンプトを捨てるので、
   * 呼び出し側が番号を持たなくて済むようにしてある。
   */
  prompt(request: DirectorPromptRequest): DirectorPrompt {
    this.promptVersion += 1;
    const payload: DirectorPrompt = { ...request, prompt_version: this.promptVersion };
    this.send({ type: "control", sessionSeq: this.state.sessionSeq, payload });
    this.state.logDirectorRaw("out", JSON.stringify(payload));
    return payload;
  }

  /**
   * `tts_direct`：compositor に「この wav をこの時刻に鳴らせ」と伝える（SPEC §5.1）。
   *
   * 同じ `id` を送り直すと置き換わる。ページが繋がっていない間は鳴らしようが
   * ないので、例外にはせず false を返す（発話そのものは Director に届いている）。
   */
  playAudio(message: Omit<PlayAudioMessage, "type">): boolean {
    if (!this.connected) return false;
    this.socket?.send(JSON.stringify({ type: "play_audio", ...message } satisfies PlayAudioMessage));
    return true;
  }

  /** 予約済みの再生を捨てる（`id` 省略で全部）。session restart / reset で使う。 */
  cancelAudio(id?: string): boolean {
    if (!this.connected) return false;
    this.socket?.send(JSON.stringify({ type: "cancel_audio", ...(id ? { id } : {}) } satisfies ToViewerMessage));
    return true;
  }

  closeSession(): void {
    if (!this.connected) return;
    // Director 側にも終わりを伝えてから WebRTC を閉じる（session_info.client_message_types に stop がある）。
    if (this.state.sessionState === "live" || this.state.sessionState === "opening") {
      try {
        this.send({ type: "control", sessionSeq: this.state.sessionSeq, payload: { type: "stop" } });
        this.state.logDirectorRaw("out", JSON.stringify({ type: "stop" }));
      } catch {
        /* ページが既に居ないなら諦める */
      }
    }
    this.socket?.send(
      JSON.stringify({ type: "close_session", sessionSeq: this.state.sessionSeq } satisfies ToViewerMessage),
    );
    this.state.sessionState = "closed";
  }

  /** ページに canvas キャプチャを頼む。返り値は data URL。 */
  captureFrame(timeoutMs = 10_000): Promise<string> {
    const requestId = randomUUID();
    const promise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.frameRequests.delete(requestId);
        reject(new DirectorError("frame_timeout", "viewer did not return a frame in time"));
      }, timeoutMs);
      this.frameRequests.set(requestId, { resolve, reject, timer });
    });
    this.send({ type: "capture_frame", requestId });
    return promise;
  }
}
