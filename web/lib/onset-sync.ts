import type { PlayTrigger } from "../../src/shared/protocol.ts";

/**
 * `audio_sync: director_onset`（SPEC §5.1）の判定ロジック。
 *
 * デーモンが推定する `on_air_at` は、Director がそのセリフの口パクを始める時刻とは
 * 実測で −0.1〜+9.8 秒ずれる（プロンプトは次のチャンク境界でしか適用されないので、
 * 送った側からは何秒後に反映されるか分からない）。そこで **Director が返す音声トラックの
 * 立ち上がりを口パクの開始の合図として使い**、その瞬間に TTS の wav を鳴らす。
 *
 * ここには WebAudio に触らない純粋な判定だけを置く（`web/lib/audio-mix.ts` が
 * `AnalyserNode` の RMS を食わせる）。単体テストできるようにするため。
 *
 * ```
 *  Director 音声の RMS ─▶ OnsetDetector ─(オンセット)─▶ OnsetPlayQueue ─▶ 先頭を即時再生
 *  play_audio ────────────────────────────────────────▶ FIFO で積むだけ
 * ```
 */

/** オンセットと認めるのに必要な、直前の静かな時間（秒）。 */
export const ONSET_QUIET_SEC = 0.3;
/** 再生中の TTS の残りがこれ未満なら「次を鳴らしてよい」とみなす（秒）。 */
export const TAIL_SEC = 0.3;
/** `at_ms` よりこれ以上早いオンセットは前の発話の続き・ノイズとみなして無視する（秒）。 */
export const EARLY_IGNORE_SEC = 3;

/** 振幅（0〜1）を dBFS にする。0 は −Infinity。 */
export function amplitudeToDb(amplitude: number): number {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : Number.NEGATIVE_INFINITY;
}

/** dB を線形ゲインにする。`tts_gain_db: -6` → 0.501。 */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/** 時間領域のサンプル列（-1〜1）から RMS を出す。 */
export function rms(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  return samples.length > 0 ? Math.sqrt(sum / samples.length) : 0;
}

/**
 * RMS の系列からオンセット（無音 → 音の立ち上がり）を拾う。
 *
 * 「直前 `quietSec` が閾値未満で、いま閾値を超えた」瞬間だけ `push` が true を返す。
 * 発話の途中（ずっと閾値を超えている）は false のままなので、1 発話につき 1 回だけ鳴る。
 */
export class OnsetDetector {
  /** 最後に閾値を超えていた時刻（秒）。まだ一度も超えていなければ −Infinity。 */
  private lastLoudAtSec = Number.NEGATIVE_INFINITY;

  constructor(
    public thresholdDb: number,
    private readonly quietSec: number = ONSET_QUIET_SEC,
  ) {}

  /** RMS を 1 点食わせる。オンセットなら true。`atSec` は単調増加する時刻。 */
  push(rmsDb: number, atSec: number): boolean {
    if (!(rmsDb >= this.thresholdDb)) return false; // NaN / -Infinity もここで落ちる
    const isOnset = atSec - this.lastLoudAtSec >= this.quietSec;
    this.lastLoudAtSec = atSec;
    return isOnset;
  }

  /** 直近 `gapSec` 以内にエネルギーがあったか（＝発話が切れずに続いている）。 */
  isActive(atSec: number, gapSec: number = ONSET_QUIET_SEC): boolean {
    return atSec - this.lastLoudAtSec < gapSec;
  }

  reset(): void {
    this.lastLoudAtSec = Number.NEGATIVE_INFINITY;
  }
}

/** キューに積んだ 1 発話。`ready` はデコードが終わって鳴らせる状態か。 */
export interface OnsetQueueItem {
  id: string;
  /** デーモンが推定した再生時刻（`Date.now()` 基準）。順番の目安と締切にだけ使う。 */
  atMs: number;
  durationSec: number;
  ready: boolean;
}

export interface OnsetQueueDecision {
  item: OnsetQueueItem;
  trigger: Exclude<PlayTrigger, "scheduled">;
}

export interface OnsetPlayQueueOptions {
  /** `at_ms` からこの秒数を過ぎてもオンセットが来なければ諦めて鳴らす。 */
  fallbackSec: number;
  tailSec?: number;
  earlyIgnoreSec?: number;
}

/**
 * `play_audio` の FIFO キュー。オンセット（またはフォールバック）で先頭を 1 本ずつ出す。
 *
 * - 再生中の TTS が無い、または残りが `tailSec` 未満のときだけ次を出す（重ならない）。
 * - `at_ms` より `earlyIgnoreSec` 以上早いオンセットは無視する
 *   （前の発話の続きや Director 側のノイズで先走らないため）。
 * - オンセットが来なくても、前の再生の終わり際に Director 音声のエネルギーが続いていれば
 *   次を出す（連続発話は Director 側で切れ目が無く、立ち上がりが検知できないため）。
 */
export class OnsetPlayQueue {
  private items: OnsetQueueItem[] = [];
  /** いま鳴らしている TTS の終了予定時刻。まだ何も鳴らしていなければ null。 */
  private currentEndsAtMs: number | null = null;
  private readonly fallbackMs: number;
  private readonly tailMs: number;
  private readonly earlyMs: number;

  constructor(options: OnsetPlayQueueOptions) {
    this.fallbackMs = options.fallbackSec * 1000;
    this.tailMs = (options.tailSec ?? TAIL_SEC) * 1000;
    this.earlyMs = (options.earlyIgnoreSec ?? EARLY_IGNORE_SEC) * 1000;
  }

  get pending(): number {
    return this.items.length;
  }

  get queued(): readonly OnsetQueueItem[] {
    return this.items;
  }

  /**
   * 積む。同じ id が既にあれば **順番はそのままで中身を置き換える**
   * （`audio_applied` を受けた撃ち直しで `at_ms` だけが動くため）。
   */
  push(item: OnsetQueueItem): OnsetQueueItem {
    const found = this.items.find((queued) => queued.id === item.id);
    if (found) {
      found.atMs = item.atMs;
      found.durationSec = item.durationSec;
      found.ready = found.ready || item.ready;
      return found;
    }
    this.items.push(item);
    return item;
  }

  /** デコードが終わって鳴らせるようになった。長さも実測で置き換える。 */
  markReady(id: string, durationSec?: number): void {
    const found = this.items.find((item) => item.id === id);
    if (!found) return;
    found.ready = true;
    if (durationSec !== undefined && durationSec > 0) found.durationSec = durationSec;
  }

  /** 捨てる（`id` 省略で全部）。返り値は捨てた件数。 */
  cancel(id?: string): number {
    if (id === undefined) {
      const count = this.items.length;
      this.items = [];
      this.currentEndsAtMs = null;
      return count;
    }
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    return before - this.items.length;
  }

  /** Director 音声の立ち上がりを検知した。鳴らすべきものがあれば返す。 */
  onOnset(nowMs: number): OnsetQueueDecision | null {
    const head = this.readyHead();
    if (!head || !this.free(nowMs) || this.tooEarly(head, nowMs)) return null;
    return this.take(head, nowMs, "onset");
  }

  /**
   * 監視ループから毎回呼ぶ。`active` は Director 音声にエネルギーが続いているか。
   *
   * - 連続発話：前の再生の終わり際（−`tailSec`）にエネルギーが続いていれば次を鳴らす。
   * - フォールバック：`at_ms + fallbackSec` を過ぎたら、オンセットが無くても鳴らす。
   */
  tick(nowMs: number, active: boolean): OnsetQueueDecision | null {
    const head = this.readyHead();
    if (!head || !this.free(nowMs)) return null;
    if (active && this.currentEndsAtMs !== null && !this.tooEarly(head, nowMs)) {
      return this.take(head, nowMs, "onset");
    }
    if (nowMs >= head.atMs + this.fallbackMs) return this.take(head, nowMs, "fallback");
    return null;
  }

  /** 鳴らし始めた（`scheduled` など、キュー外から鳴らしたときにも使う）。 */
  markStarted(nowMs: number, durationSec: number): void {
    this.currentEndsAtMs = nowMs + durationSec * 1000;
  }

  private readyHead(): OnsetQueueItem | null {
    const head = this.items[0];
    return head && head.ready ? head : null;
  }

  /** 再生中の TTS が無い、または残りが `tailSec` 未満。 */
  private free(nowMs: number): boolean {
    return this.currentEndsAtMs === null || this.currentEndsAtMs - nowMs < this.tailMs;
  }

  private tooEarly(item: OnsetQueueItem, nowMs: number): boolean {
    return nowMs < item.atMs - this.earlyMs;
  }

  private take(item: OnsetQueueItem, nowMs: number, trigger: "onset" | "fallback"): OnsetQueueDecision {
    this.items.shift();
    this.markStarted(nowMs, item.durationSec);
    return { item, trigger };
  }
}
