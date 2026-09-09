import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.ts";

import type { ChatComment } from "./chat.ts";
import type { DirectorSessionInfo } from "../shared/protocol.ts";

export type { ChatComment };

export type EventName =
  | "new_comment"
  | "queue_low"
  | "session_ending"
  | "session_ended"
  | "queue_empty"
  | "error";

/** Director セッションの状態。`ended` はセッションが死んでいて speak / direct を受け付けない。 */
export type SessionState = "idle" | "opening" | "live" | "failed" | "closed" | "ended";

/**
 * `chunk` がこの秒数以上届かなければセッションが死んだとみなす。
 * （compositor の data channel が黙って閉じても `session_state` は live のままだったため。）
 */
export const CHUNK_STALL_SEC = 60;

/**
 * `session_info.max_session_seconds` が設定値のこの割合を下回ったら警告を出す。
 * 実測の正常値は約 372 秒（設定 360 秒とほぼ同じ）。fal の残高が少ないと 183 秒などになる。
 */
const SHORT_SESSION_RATIO = 0.75;

export interface StreamEvent {
  event: EventName;
  elapsed_sec: number;
  queue_remaining_sec: number;
  comments_pending: number;
  session_remaining_sec: number;
  message?: string;
  [key: string]: unknown;
}

export interface SpeakTiming {
  /** 音声の長さ（秒）。 */
  duration_sec: number;
  /** 送信時点から何秒後にオンエアに乗るか。 */
  on_air_in_sec: number;
  /** 絶対時刻（ms epoch）。オーバーレイの切替に使う。 */
  on_air_at_ms: number;
  /** この発話を積んだ後のキュー残（秒）。 */
  queue_remaining_sec: number;
  /** この発話が終わる絶対時刻（ms epoch）。 */
  queue_end_at_ms: number;
}

/**
 * SPEC §5.1 のタイミングモデル。純関数にして単体テストできるようにしてある。
 *
 * - `audio_behavior: "queue"` の音声は積まれている音声が終わってから流れるので、
 *   新しい発話のオンエア開始は「今のキュー残 + 生成先行分」後になる。
 * - `generationLeadSec` は session_metrics / chunk から推定した生成先行分。
 */
export function computeSpeakTiming(
  nowMs: number,
  queueEndAtMs: number,
  durationSec: number,
  generationLeadSec: number,
): SpeakTiming {
  const queueRemainingBeforeSec = Math.max(0, (queueEndAtMs - nowMs) / 1000);
  const onAirInSec = queueRemainingBeforeSec + Math.max(0, generationLeadSec);
  const queueRemainingSec = queueRemainingBeforeSec + durationSec;
  return {
    duration_sec: round1(durationSec),
    on_air_in_sec: round1(onAirInSec),
    on_air_at_ms: nowMs + onAirInSec * 1000,
    queue_remaining_sec: round1(queueRemainingSec),
    queue_end_at_ms: nowMs + queueRemainingSec * 1000,
  };
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface ChunkInfo {
  chunk_index?: number;
  /** このチャンクが再生に足す秒数（累積位置ではない）。実測 8.5。 */
  playback_seconds?: number;
  /** 生成を頼んだ長さ（既定 10）。重なり分を引いたものが playback_seconds。 */
  requested_duration_seconds?: number;
  /** 生成にかかった実時間。 */
  generation_seconds?: number;
  /** 生成済みでまだ流れていない秒数 ＝ 生成先行分。実測 0〜2 秒。 */
  buffer_depth_seconds?: number;
  buffer_depth_chunks?: number;
  scheduling_lead_ms?: number;
  scheduling_slack_ms?: number;
  next_generation_estimate_seconds?: number;
  generated_frame_count?: number;
}

/**
 * 生成先行分（＝いま送った prompt が画に出るまでの秒数）の推定。
 *
 * 実測（docs/SPEC.md §0）で分かったこと：
 * - `playback_seconds` は累積の再生位置ではなく **そのチャンクが再生に足す秒数**（8.5）。
 *   なので「生成済み位置 − 経過秒」では先行分を測れない。
 * - 実際の先行分は `buffer_depth_seconds`（生成済みでまだ流れていない秒数、0〜2 秒）。
 *   モデルは再生ぎりぎりで生成している。
 * - prompt は生成中のチャンクには効かず **次に生成されるチャンク**から反映されるので、
 *   画に出るまでは「バッファ残 + 1 チャンクの再生尺（8.5 秒）」かかる。
 *
 * よって観測値 = `buffer_depth_seconds + playback_seconds`。ノイズが乗るので EMA で均し、
 * [0, 60] にクランプする。
 */
export function estimateGenerationLead(
  previousLeadSec: number,
  chunk: ChunkInfo,
  fallbackPlaybackSec: number,
  smoothing = 0.3,
): number {
  const playback = chunk.playback_seconds ?? fallbackPlaybackSec;
  const observed = (chunk.buffer_depth_seconds ?? 0) + playback;
  if (!Number.isFinite(observed)) return previousLeadSec;
  const clamped = Math.min(60, Math.max(0, observed));
  return round1(previousLeadSec * (1 - smoothing) + clamped * smoothing);
}

/**
 * デーモン起動より前に投稿されたコメントか。
 *
 * YouTube の `liveChatMessages.list` は初回ポーリングで過去のコメントを全部返すので、
 * 起動前のものは未使用バッファに入れずに捨てる（SPEC §7）。
 * `publishedAt` が壊れていて時刻として読めないものは捨てない（新しい扱い）。
 */
export function isCommentBeforeStart(publishedAt: string, startedAtMs: number): boolean {
  const publishedMs = Date.parse(publishedAt);
  if (!Number.isFinite(publishedMs)) return false;
  return publishedMs < startedAtMs;
}

interface Waiter {
  resolve: (event: StreamEvent | null) => void;
  timer: NodeJS.Timeout;
}

export interface LastSpeech {
  text: string;
  direction: string | null;
  emotion: string | null;
  comment_id: string | null;
  duration_sec: number;
  on_air_at_ms: number;
  sent_at_ms: number;
}

export interface StateOptions {
  chunkSeconds: number;
  queueLowSec: number;
  sessionMaxMin: number;
  restartWarnMin: number;
  stateDir?: string;
}

/**
 * デーモンの全状態。CLI からは api.ts 経由でしか触らない。
 */
export class StreamState {
  readonly startedAtMs = Date.now();
  readonly opts: StateOptions;
  readonly stateDir: string;
  private readonly usedCommentsPath: string;
  private readonly logPath: string;
  private readonly directorRawPath: string;

  /** 音声キューが尽きる推定時刻。過去なら残 0。 */
  queueEndAtMs = Date.now();
  /** 生成先行分（秒）。chunk 受信で更新。 */
  generationLeadSec = 0;
  /** 接続直後に届く session_info。セッションの実際の上限や音声要件はここに入っている。 */
  sessionInfo: DirectorSessionInfo | null = null;
  /** 現在の Director セッションの開始時刻。 */
  sessionStartedAtMs: number | null = null;
  sessionSeq = 0;
  sessionState: SessionState = "idle";
  /** `sessionState === "ended"` のときの理由（`h3 wait` の session_ended と speak のエラーに載せる）。 */
  sessionEndedReason: string | null = null;
  /** 直近に chunk が届いた時刻。届かなくなったらセッションが死んだとみなす。 */
  lastChunkAtMs: number | null = null;
  lastDirectorMessage: { type: string; at: string; body: unknown } | null = null;
  lastSpeech: LastSpeech | null = null;
  viewers: number | null = null;
  /** 起動前に投稿されていたので捨てたコメントの件数（本文はログに出さない）。 */
  staleCommentsDropped = 0;
  errors: { at: string; message: string }[] = [];

  private usedCommentIds = new Set<string>();
  private pendingComments: ChatComment[] = [];
  private eventQueue: StreamEvent[] = [];
  private waiters: Waiter[] = [];
  private queueLowFired = false;
  private queueEmptyFired = true;
  private sessionEndingFired = false;
  /** 一度積んだ error はもう積まない（同じ内容が何度も返るのを防ぐ）。 */
  private readonly pushedErrorMessages = new Set<string>();

  constructor(opts: StateOptions) {
    this.opts = opts;
    this.stateDir = opts.stateDir ?? join(ROOT, "state");
    mkdirSync(join(this.stateDir, "log"), { recursive: true });
    this.usedCommentsPath = join(this.stateDir, "used_comments.json");
    this.logPath = join(this.stateDir, "log", "daemon.log");
    this.directorRawPath = join(this.stateDir, "log", "director-raw.jsonl");
    this.loadUsedComments();
  }

  // ---------- タイミング ----------

  elapsedSec(now = Date.now()): number {
    return round1((now - this.startedAtMs) / 1000);
  }

  queueRemainingSec(now = Date.now()): number {
    return round1(Math.max(0, (this.queueEndAtMs - now) / 1000));
  }

  /**
   * セッションの上限秒数。`session_info.max_session_seconds` が届いていればそれを優先する。
   *
   * SPEC は 15 分としていたが、実測では `max_session_seconds` は 372 秒（約 6.2 分）だった。
   * 設定値（`session_max_min`）と実測のうち**短い方**を上限として扱う。
   */
  sessionMaxSec(): number {
    const configured = this.opts.sessionMaxMin * 60;
    const reported = this.sessionInfo?.max_session_seconds;
    if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
      return Math.min(configured, reported);
    }
    return configured;
  }

  /**
   * `session_ending` を出す残り秒数。
   *
   * `restart_warn_min` は設定上の目安（既定 1 分）だが、セッション上限そのものが
   * 短いとき（fal の残高不足で 183 秒など）は開始直後に警告が出てしまう。
   * 上限の 30% と設定値の**小さい方**を使う。
   */
  sessionEndingThresholdSec(): number {
    return Math.min(this.opts.restartWarnMin * 60, this.sessionMaxSec() * 0.3);
  }

  /**
   * `h3 status` / `h3 daemon start` に出す警告。
   *
   * Director が返す `max_session_seconds` が設定値より大幅に短いときは、
   * fal のクレジットが少ない可能性が高い（実測の正常値は約 372 秒）。
   */
  warnings(): string[] {
    const out: string[] = [];
    const reported = this.sessionInfo?.max_session_seconds;
    const configured = this.opts.sessionMaxMin * 60;
    if (
      typeof reported === "number" &&
      Number.isFinite(reported) &&
      reported > 0 &&
      reported < configured * SHORT_SESSION_RATIO
    ) {
      out.push(`director session limit is ${Math.round(reported)}s (fal credit may be low)`);
    }
    return out;
  }

  sessionRemainingSec(now = Date.now()): number {
    if (this.sessionStartedAtMs === null) return 0;
    return round1(Math.max(0, this.sessionMaxSec() - (now - this.sessionStartedAtMs) / 1000));
  }

  /** 接続直後の session_info を取り込む。以後の上限・チャンク尺の判断はこれを使う。 */
  onSessionInfo(info: DirectorSessionInfo): void {
    this.sessionInfo = info;
    this.sessionEndingFired = false;
    for (const warning of this.warnings()) this.log("warn", warning);
  }

  /** 1 チャンクが再生に足す秒数。session_info があればその実測値。 */
  chunkPlaybackSec(): number {
    const reported = this.sessionInfo?.continuation_playback_seconds;
    return typeof reported === "number" && reported > 0 ? reported : this.opts.chunkSeconds;
  }

  /** speak が音声を積むときに呼ぶ。返り値をそのまま CLI に返す。 */
  enqueueAudio(durationSec: number, now = Date.now()): SpeakTiming {
    const timing = computeSpeakTiming(now, this.queueEndAtMs, durationSec, this.generationLeadSec);
    this.queueEndAtMs = timing.queue_end_at_ms;
    this.rearmQueueEvents(now);
    return timing;
  }

  /**
   * Director の `audio_applied` に載っている実測のキュー残で推定を上書きする。
   *
   * ```json
   * {"type":"audio_applied","prompt_version":2,"behavior":"queue",
   *  "source":"https://…wav","duration_seconds":6.72,"transcribed":false,
   *  "queued_sources":0,"remaining_seconds":6.72}
   * ```
   * `remaining_seconds` は積まれている音声の残り全部なので、これが来たら推定を捨てて実測に合わせる。
   */
  syncAudioQueue(remainingSec: number, now = Date.now()): void {
    if (!Number.isFinite(remainingSec) || remainingSec < 0) return;
    this.queueEndAtMs = now + remainingSec * 1000;
    this.rearmQueueEvents(now);
  }

  /**
   * キュー系イベントの再武装。**閾値を上回ったときだけ**次の発火を許す。
   *
   * `queue_low` は閾値を下回った瞬間に 1 回だけ積み、閾値を上回るまで積み直さない
   * （音声を積むたびに積み直すと、閾値未満のまま同じイベントが溜まる）。
   */
  private rearmQueueEvents(now = Date.now()): void {
    const remaining = this.queueRemainingSec(now);
    if (remaining >= this.opts.queueLowSec) {
      this.queueLowFired = false;
      this.queueEmptyFired = false;
    } else if (remaining > 0) {
      this.queueEmptyFired = false;
    }
  }

  /** セッション張り直し時。積んだ音声は失われる。 */
  resetAudioQueue(now = Date.now()): void {
    this.queueEndAtMs = now;
    // 空になったので queue_empty は次の tick で 1 回だけ出す。
    this.queueEmptyFired = false;
    this.queueLowFired = false;
  }

  startSession(now = Date.now()): void {
    this.sessionSeq += 1;
    this.sessionStartedAtMs = now;
    this.sessionState = "opening";
    this.sessionEndedReason = null;
    this.sessionEndingFired = false;
    this.sessionInfo = null;
    this.generationLeadSec = 0;
    this.lastChunkAtMs = null;
    this.resetAudioQueue(now);
  }

  /**
   * セッションが死んだ（もう映像も音声も出ない）ことを記録する。
   *
   * 実測（初回配信）では compositor の control data channel が閉じても
   * `session_state` は `live` のままで、`h3 speak` が成功し続けて音声だけが捨てられた。
   * ここに来たら `h3 speak` / `h3 direct` は受け付けず、`h3 wait` に `session_ended` を出す。
   * 復帰は `h3 session restart` / `h3 reset`。
   */
  endSession(reason: string): void {
    if (this.sessionState === "ended") return;
    this.sessionState = "ended";
    this.sessionEndedReason = reason;
    this.log("error", `director session ended: ${reason}`);
    this.pushEvent({ event: "session_ended", reason, message: `director session ended: ${reason}` });
  }

  /** セッションが生きていて speak / direct を受け付けられるか。 */
  isSessionEnded(): boolean {
    return this.sessionState === "ended";
  }

  onChunk(chunk: ChunkInfo, now = Date.now()): void {
    this.lastChunkAtMs = now;
    this.generationLeadSec = estimateGenerationLead(
      this.generationLeadSec,
      chunk,
      this.chunkPlaybackSec(),
    );
  }

  // ---------- コメント ----------

  private loadUsedComments(): void {
    if (!existsSync(this.usedCommentsPath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.usedCommentsPath, "utf8"));
      if (Array.isArray(parsed)) this.usedCommentIds = new Set(parsed.map(String));
    } catch (error) {
      this.log("warn", `used_comments.json を読めなかった: ${String(error)}`);
    }
  }

  private saveUsedComments(): void {
    writeFileSync(this.usedCommentsPath, JSON.stringify([...this.usedCommentIds], null, 2));
  }

  isCommentUsed(id: string): boolean {
    return this.usedCommentIds.has(id);
  }

  markCommentUsed(id: string): void {
    this.usedCommentIds.add(id);
    this.pendingComments = this.pendingComments.filter((c) => c.id !== id);
    this.saveUsedComments();
  }

  addComment(comment: ChatComment): void {
    if (this.usedCommentIds.has(comment.id)) return;
    if (this.pendingComments.some((c) => c.id === comment.id)) return;
    this.pendingComments.unshift(comment);
    if (this.pendingComments.length > 200) this.pendingComments.length = 200;
    this.log("info", `comment ${comment.id} @${comment.author}: ${comment.text}`);
    this.pushEvent({ event: "new_comment" });
  }

  /** 未使用コメントを新しい順に返す。取得しても使用済みにはならない。 */
  comments(limit = 20): ChatComment[] {
    return this.pendingComments.slice(0, limit);
  }

  findComment(id: string): ChatComment | undefined {
    return this.pendingComments.find((c) => c.id === id);
  }

  pendingCount(): number {
    return this.pendingComments.length;
  }

  // ---------- イベント ----------

  /**
   * イベントを積む。**一度返したイベントは消える**（`h3 wait` はキューから 1 件取り出す）。
   *
   * 同じ内容の `error` は 1 回しか積まない。初回配信では起動直後のチャット 404 が
   * 何度も積まれ、`h3 wait` が古いエラーを返し続けた。
   */
  pushEvent(event: Partial<StreamEvent> & { event: EventName }): void {
    const now = Date.now();
    if (event.event === "error") {
      const key = String(event.message ?? "");
      if (this.pushedErrorMessages.has(key)) return;
      this.pushedErrorMessages.add(key);
      if (this.pushedErrorMessages.size > 200) {
        this.pushedErrorMessages.delete(this.pushedErrorMessages.values().next().value as string);
      }
    }
    const full: StreamEvent = {
      elapsed_sec: this.elapsedSec(now),
      queue_remaining_sec: this.queueRemainingSec(now),
      comments_pending: this.pendingCount(),
      session_remaining_sec: this.sessionRemainingSec(now),
      ...event,
    };
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(full);
      return;
    }
    this.eventQueue.push(full);
    if (this.eventQueue.length > 100) this.eventQueue.shift();
  }

  /**
   * 積んだときの時刻ではなく**返すときの**時刻で数値を入れ直す。
   * `elapsed_sec` は「待った秒数」ではなくデーモンの経過秒に統一する。
   */
  private refreshEvent(event: StreamEvent, now = Date.now()): StreamEvent {
    return {
      ...event,
      elapsed_sec: this.elapsedSec(now),
      queue_remaining_sec: this.queueRemainingSec(now),
      comments_pending: this.pendingCount(),
      session_remaining_sec: this.sessionRemainingSec(now),
    };
  }

  /** 積まれているイベントの件数（テスト・デバッグ用）。 */
  queuedEventCount(): number {
    return this.eventQueue.length;
  }

  /** `h3 wait` のロングポーリング。timeout でイベントが無ければ null。 */
  waitForEvent(timeoutMs: number): Promise<StreamEvent | null> {
    const queued = this.eventQueue.shift();
    if (queued) return Promise.resolve(this.refreshEvent(queued));
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(null);
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** 待っている全員を起こす（デーモン停止時）。 */
  releaseWaiters(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.waiters = [];
  }

  /**
   * 1 秒ごとに呼ぶ。閾値をまたいだときだけイベントを出す（エッジトリガ）。
   */
  tick(now = Date.now()): void {
    const remaining = this.queueRemainingSec(now);
    if (remaining <= 0) {
      if (!this.queueEmptyFired) {
        this.queueEmptyFired = true;
        this.queueLowFired = true;
        this.pushEvent({ event: "queue_empty" });
      }
    } else if (remaining < this.opts.queueLowSec) {
      if (!this.queueLowFired) {
        this.queueLowFired = true;
        this.pushEvent({ event: "queue_low" });
      }
    } else {
      this.queueLowFired = false;
      this.queueEmptyFired = false;
    }

    if (this.sessionStartedAtMs !== null && !this.sessionEndingFired && !this.isSessionEnded()) {
      if (this.sessionRemainingSec(now) <= this.sessionEndingThresholdSec()) {
        this.sessionEndingFired = true;
        this.pushEvent({ event: "session_ending" });
      }
    }

    // chunk が途切れたらセッションが死んでいる（data channel が黙って閉じても気付けるように）。
    if (
      this.sessionState === "live" &&
      this.lastChunkAtMs !== null &&
      now - this.lastChunkAtMs > CHUNK_STALL_SEC * 1000
    ) {
      this.endSession(`no chunk for ${CHUNK_STALL_SEC}s`);
    }
  }

  // ---------- エラー・ログ ----------

  recordError(message: string): void {
    const at = new Date().toISOString();
    this.errors.push({ at, message });
    if (this.errors.length > 50) this.errors.shift();
    this.log("error", message);
    this.pushEvent({ event: "error", message });
  }

  log(level: "info" | "warn" | "error", message: string): void {
    const line = `${new Date().toISOString()} [${level}] ${message}\n`;
    try {
      appendFileSync(this.logPath, line);
    } catch {
      // ログが書けなくても配信は続ける
    }
    if (level === "error") process.stderr.write(line);
  }

  /**
   * Director と往復した生メッセージを `state/log/director-raw.jsonl` にそのまま残す。
   *
   * daemon.log は要約しか持たないので、実際に届く `type` とフィールドを後から
   * 確かめられるよう、加工しない JSON 文字列を 1 行 1 件で追記する。
   * `dir` は "in"（Director → デーモン）か "out"（デーモン → Director）。
   */
  logDirectorRaw(dir: "in" | "out", raw: string, sessionSeq = this.sessionSeq): void {
    const line = `${JSON.stringify({ at: new Date().toISOString(), dir, session_seq: sessionSeq, raw })}\n`;
    try {
      appendFileSync(this.directorRawPath, line);
    } catch {
      // 記録できなくても配信は続ける
    }
  }

  tailLog(lines: number): string[] {
    if (!existsSync(this.logPath)) return [];
    const all = readFileSync(this.logPath, "utf8").split("\n").filter((l) => l.length > 0);
    return all.slice(-lines);
  }
}
