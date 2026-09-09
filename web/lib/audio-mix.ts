import type { AudioSetup, AudioSource, AudioSync, PlayTrigger } from "../../src/shared/protocol.ts";
import { amplitudeToDb, dbToGain, OnsetDetector, OnsetPlayQueue, rms } from "./onset-sync.ts";

/**
 * 送出用の音声を 1 本にまとめる。
 *
 * Director の音声トラックは配信中に何度も差し替わる（セッション張り直し）が、
 * MediaRecorder は録画開始時のトラック構成をそのまま使い続けるので、
 * 途中でトラックが消えると音声が無いファイルになってしまう。
 * そこで WebAudio のミキサーを 1 つ立て、その出力トラック（常に存在する）だけを
 * MediaRecorder に渡し、Director の音声はミキサーへ繋ぎ替える形にする。
 *
 * 無音ソース（offset 0 の ConstantSourceNode）を常時繋いでおくので、
 * Director が未接続でも音声トラックは無音で流れ続ける。
 *
 * ```
 *  Director tracks ─▶ tap ─┬─▶ analyser ─▶ (無音) ─┐   … オンセット検知
 *                          ├─▶ directorGain ─▶ [limiter] ─┤
 *                          │  (tts_direct=0)              ├─▶ destination ─▶ MediaRecorder（送出）
 *   play_audio の wav ─────┼─▶ ttsGain ─▶ limiter ────────┘
 *                          └─▶ recordDestination ─▶ MediaRecorder（解析用の別録り）
 * ```
 *
 * `audio_source: tts_direct` では Director の音声を 0 に絞り（口パクの条件付けにだけ使う）、
 * TTS の wav をそのまま鳴らす。Director の音声トラックはモデルが再合成したもので、
 * 16kHz 以上が消え元 TTS との波形相関が 0.175 まで落ちる（docs/SPEC.md §5.1）ため、
 * 配信にはこちらを乗せない。
 *
 * **鳴らす時刻**は `audio_sync` で決まる（SPEC §5.1）。
 * - `director_onset`（既定）… `play_audio` は FIFO キューに積むだけで、Director 音声の
 *   立ち上がり（＝口パクの開始）を検知した瞬間に先頭を鳴らす。判定は `./onset-sync.ts`。
 * - `scheduled` … 指示された `at_ms` にそのまま鳴らす（v0.3 までの挙動）。
 *
 * **音量**は `ttsGain`（`tts_gain_db`、既定 -6dB）→ `DynamicsCompressorNode`（リミッター）
 * を通す。TTS の wav はピーク 0 dBFS でクリップ済みサンプルを含み、そのまま Opus に
 * 通すと「プツプツ」「ピークで割れる」になるため。
 */

/** リミッター（DynamicsCompressorNode）の設定。閾値より上をほぼ通さない。 */
const LIMITER = { threshold: -6, knee: 0, ratio: 20, attack: 0.002, release: 0.1 };

/** Director 音声の RMS を見る間隔（ms）。 */
const MONITOR_INTERVAL_MS = 50;

/** 鳴らし終えた id を覚えておく上限（撃ち直しの二重再生よけ）。 */
const PLAYED_HISTORY = 256;

/** compositor が既定にする音声設定（デーモンの `hello` が来るまで）。 */
export const DEFAULT_AUDIO_SETUP: AudioSetup = {
  source: "tts_direct",
  record_director_audio: false,
  sync: "director_onset",
  onset_threshold_db: -40,
  onset_fallback_sec: 12,
  tts_gain_db: -6,
};

/** `play_audio` を受けた結果。デーモンに返してタイミングの実測に使う。 */
export interface ScheduledPlay {
  id: string;
  /** 鳴り始める時刻（`Date.now()` 基準の推定）。`queued` のときは未定なので 0。 */
  startsAtMs: number;
  /** 指定時刻に間に合わず頭を切った秒数（`scheduled` のときだけ 0 以外になる）。 */
  skippedSec: number;
  durationSec: number;
  /** true = まだ鳴っていない（Director のオンセット待ちでキューに積んだ）。 */
  queued: boolean;
}

/** 実際に鳴り始めたことの報告。 */
export interface StartedPlay {
  id: string;
  startedAtMs: number;
  trigger: PlayTrigger;
  /** そのとき指示されていた `at_ms`。推定との差を出すため。 */
  atMs: number;
  durationSec: number;
}

export class AudioMix {
  readonly context: AudioContext;
  private readonly destination: MediaStreamAudioDestinationNode;
  /** Director 音声の合流点。ここから送出用のゲイン・解析用の別録り・オンセット検知に分岐する。 */
  private readonly directorTap: GainNode;
  /** 送出に乗せる Director 音声の音量。`tts_direct` では 0。 */
  private readonly directorGain: GainNode;
  /** `audio_source: director` のときだけ Director 音声を通すリミッター。 */
  private readonly directorLimiter: DynamicsCompressorNode;
  /** 直接再生する TTS の入力ゲイン（`tts_gain_db`）。 */
  private readonly ttsGain: GainNode;
  /** TTS のリミッター。クリップ済みの wav をそのまま Opus に通さないため。 */
  private readonly ttsLimiter: DynamicsCompressorNode;
  /** Director 音声のレベル監視（オンセット検知）。 */
  private readonly analyser: AnalyserNode;
  private readonly analyserBuffer: Float32Array<ArrayBuffer>;
  private recordDestination: MediaStreamAudioDestinationNode | null = null;
  private readonly sources = new Map<string, MediaStreamAudioSourceNode>();
  /** 予約済み・再生中の直接再生。id で置き換え・取り消しができるようにする。 */
  private readonly playing = new Map<string, AudioBufferSourceNode>();
  /** id ごとの世代番号。fetch 中に同じ id が来たら古い方を捨てる。 */
  private readonly tokens = new Map<string, number>();
  private tokenSeq = 0;

  private setup: AudioSetup = DEFAULT_AUDIO_SETUP;
  /** オンセット待ちの FIFO（`director_onset` のときだけ使う）。 */
  private queue: OnsetPlayQueue;
  private readonly detector: OnsetDetector;
  /** デコード済みでまだ鳴らしていないバッファ。 */
  private readonly buffers = new Map<string, AudioBuffer>();
  /** もう鳴らした id。撃ち直し（同じ id の `play_audio`）で二度鳴らさないため。 */
  private readonly played = new Set<string>();
  /**
   * 音を持たない仮想エントリの id（`audio_source: director`）。
   * 字幕・強調を実際の発話開始に合わせるためだけに FIFO へ載せる。
   */
  private readonly silent = new Set<string>();
  private monitorTimer: number | null = null;
  private lastLevelDb = Number.NEGATIVE_INFINITY;

  /** 実際に鳴り始めたときに呼ばれる（compositor が `audio_started` を送る）。 */
  onStarted: ((play: StartedPlay) => void) | null = null;

  constructor(sampleRate = 48_000) {
    this.context = new AudioContext({ sampleRate, latencyHint: "playback" });
    this.destination = this.context.createMediaStreamDestination();

    this.directorTap = this.context.createGain();
    this.directorGain = this.context.createGain();
    this.directorLimiter = this.createLimiter();
    this.ttsGain = this.context.createGain();
    this.ttsLimiter = this.createLimiter();

    this.directorTap.connect(this.directorGain);
    this.directorLimiter.connect(this.destination);
    this.ttsGain.connect(this.ttsLimiter);
    this.ttsLimiter.connect(this.destination);

    // Director 音声のレベル監視。AnalyserNode は素通しだが、確実に回すために
    // ゲイン 0 で destination まで繋いでおく（送出には何も足さない）。
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.analyserBuffer = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    const analyserSink = this.context.createGain();
    analyserSink.gain.value = 0;
    this.directorTap.connect(this.analyser);
    this.analyser.connect(analyserSink);
    analyserSink.connect(this.destination);

    this.detector = new OnsetDetector(this.setup.onset_threshold_db);
    this.queue = new OnsetPlayQueue({ fallbackSec: this.setup.onset_fallback_sec });

    // 無音でもグラフを回し続けるためのソース。これが音声トラックの存在を保証する。
    const silence = this.context.createConstantSource();
    silence.offset.value = 0;
    silence.connect(this.destination);
    silence.start();

    this.applySetup();
  }

  private createLimiter(): DynamicsCompressorNode {
    const node = this.context.createDynamicsCompressor();
    node.threshold.value = LIMITER.threshold;
    node.knee.value = LIMITER.knee;
    node.ratio.value = LIMITER.ratio;
    node.attack.value = LIMITER.attack;
    node.release.value = LIMITER.release;
    return node;
  }

  /** MediaRecorder に渡す音声トラック。Director の有無にかかわらず常に 1 本ある。 */
  get track(): MediaStreamTrack {
    const [track] = this.destination.stream.getAudioTracks();
    if (!track) throw new Error("audio destination has no track");
    return track;
  }

  /**
   * デーモンの `hello` で届いた音声設定を丸ごと反映する（SPEC §5.1）。
   *
   * `hello` は WebSocket を繋ぎ直すたびに来るので、**設定が変わっていなければ
   * キューはそのまま残す**（再接続でオンセット待ちの発話を落とさないため）。
   */
  configure(setup: AudioSetup): void {
    const rebuild = setup.onset_fallback_sec !== this.setup.onset_fallback_sec;
    this.setup = setup;
    this.detector.thresholdDb = setup.onset_threshold_db;
    if (rebuild) {
      this.queue.cancel();
      this.buffers.clear();
      this.silent.clear();
      this.queue = new OnsetPlayQueue({ fallbackSec: setup.onset_fallback_sec });
    }
    this.applySetup();
  }

  /**
   * 配信に乗せる音声の出どころを切り替える（SPEC §5.1）。
   * `tts_direct` では Director の音声トラックは受け続けるがゲインを 0 にする。
   */
  setSource(source: AudioSource): void {
    this.configure({ ...this.setup, source });
  }

  private applySetup(): void {
    const gain = dbToGain(this.setup.tts_gain_db);
    this.ttsGain.gain.value = gain;
    // `director` のときだけ Director 音声も同じゲイン + リミッターを通す。
    this.directorGain.disconnect();
    if (this.setup.source === "director") {
      this.directorGain.gain.value = gain;
      this.directorGain.connect(this.directorLimiter);
    } else {
      this.directorGain.gain.value = 0;
      this.directorGain.connect(this.destination);
    }
    if (this.setup.sync === "director_onset") this.startMonitor();
    else this.stopMonitor();
  }

  get sync(): AudioSync {
    return this.setup.sync;
  }

  /** 直近に測った Director 音声のレベル（dBFS）。状態表示用。 */
  get directorLevelDb(): number {
    return this.lastLevelDb;
  }

  /** 解析用に Director 音声だけを取り出したストリーム（送出のゲインより手前）。 */
  directorOnlyStream(): MediaStream {
    if (!this.recordDestination) {
      this.recordDestination = this.context.createMediaStreamDestination();
      this.directorTap.connect(this.recordDestination);
    }
    return this.recordDestination.stream;
  }

  /** 自動再生制限で suspended のまま始まることがあるので明示的に起こす。 */
  async resume(): Promise<void> {
    if (this.context.state !== "running") await this.context.resume();
  }

  /** Director から届いた MediaStream の音声トラックをミキサーに繋ぐ。 */
  addStream(stream: MediaStream): number {
    const tracks = stream.getAudioTracks();
    for (const track of tracks) {
      if (this.sources.has(track.id)) continue;
      const source = this.context.createMediaStreamSource(new MediaStream([track]));
      source.connect(this.directorTap);
      this.sources.set(track.id, source);
      track.addEventListener("ended", () => this.removeTrack(track.id));
    }
    return tracks.length;
  }

  private removeTrack(id: string): void {
    const source = this.sources.get(id);
    if (!source) return;
    source.disconnect();
    this.sources.delete(id);
  }

  /** セッションを閉じたときに Director 側の入力を全部外す（無音ソースは残る）。 */
  clear(): void {
    for (const id of [...this.sources.keys()]) this.removeTrack(id);
    this.detector.reset();
  }

  // ---------- オンセット監視（director_onset） ----------

  private startMonitor(): void {
    if (this.monitorTimer !== null) return;
    this.monitorTimer = window.setInterval(() => this.monitorTick(), MONITOR_INTERVAL_MS);
  }

  private stopMonitor(): void {
    if (this.monitorTimer === null) return;
    window.clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  /**
   * Director 音声の RMS を 1 点測り、キューの先頭を鳴らすか決める。
   *
   * オンセット（無音 → 音）が出たらそこで鳴らす。オンセットが取れなくても
   * 前の再生の終わり際にエネルギーが続いていれば次を鳴らし（連続発話）、
   * `at_ms + onset_fallback_sec` を過ぎたら諦めて鳴らす（黙り続けない）。
   */
  private monitorTick(): void {
    this.analyser.getFloatTimeDomainData(this.analyserBuffer);
    const levelDb = amplitudeToDb(rms(this.analyserBuffer));
    this.lastLevelDb = levelDb;
    const atSec = this.context.currentTime;
    const nowMs = this.epochNowMs();

    const decision =
      (this.detector.push(levelDb, atSec) ? this.queue.onOnset(nowMs) : null) ??
      this.queue.tick(nowMs, this.detector.isActive(atSec));
    if (decision) {
      this.startNow(decision.item.id, decision.item.atMs, decision.trigger, decision.item.durationSec);
    }
  }

  /**
   * キュー（またはフォールバック）で選ばれた 1 本を即座に鳴らす。
   *
   * 仮想エントリ（`silent`）は音を出さず、`onStarted` だけを返す
   * （compositor が字幕・強調を切り替える）。
   */
  private startNow(id: string, atMs: number, trigger: PlayTrigger, durationSec: number): void {
    const buffer = this.buffers.get(id);
    const isSilent = this.silent.delete(id);
    if (!buffer && !isSilent) return; // 未デコードのまま選ばれた（通常は起きない）
    if (buffer) {
      this.buffers.delete(id);
      void this.resume();
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.ttsGain);
      source.start();
      this.playing.set(id, source);
      source.addEventListener("ended", () => {
        if (this.playing.get(id) === source) this.playing.delete(id);
      });
    }
    this.remember(id);

    this.onStarted?.({
      id,
      startedAtMs: this.epochNowMs(),
      trigger,
      atMs,
      durationSec: buffer?.duration ?? durationSec,
    });
  }

  private remember(id: string): void {
    this.played.add(id);
    while (this.played.size > PLAYED_HISTORY) {
      const oldest = this.played.values().next().value;
      if (oldest === undefined) break;
      this.played.delete(oldest);
    }
  }

  // ---------- 直接再生（tts_direct） ----------

  /**
   * `Date.now()` と同じ基準の現在時刻。`performance` 由来の単調な時計を使う
   * （`Date.now()` は NTP 補正で飛ぶことがあり、`AudioContext.currentTime` との
   * 対応付けがずれるため）。
   */
  private epochNowMs(): number {
    return performance.timeOrigin + performance.now();
  }

  /**
   * `play_audio` を受け取る。
   *
   * - `director_onset` … wav を取ってデコードし、FIFO キューに積む。鳴らすのは
   *   Director 音声の立ち上がりを検知したとき（`monitorTick`）。
   * - `scheduled` … `atMs`（`Date.now()` 基準の絶対時刻）に鳴らす。
   *
   * どちらも同じ `id` を渡すと前の指示を置き換える（`audio_applied` での撃ち直し用）。
   * ただし既に鳴らし終えた id は無視する（二度鳴らさない）。
   */
  async play(
    id: string,
    url: string,
    atMs: number,
    durationSec: number,
    silent = false,
  ): Promise<ScheduledPlay | null> {
    if (this.setup.sync === "director_onset" && this.played.has(id)) return null;
    if (silent) return this.playSilent(id, atMs, durationSec);
    const token = ++this.tokenSeq;
    this.tokens.set(id, token);
    // 先にキューへ席を取る。デコードの終わる順で発話が入れ替わらないようにするため。
    if (this.setup.sync === "director_onset") {
      this.queue.push({ id, atMs, durationSec, ready: this.buffers.has(id) });
    }

    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`fetch ${url} → HTTP ${response.status}`);
    const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
    // fetch/decode の間に同じ id が撃ち直されていたら、こちらは捨てる
    // （キューの席は新しい方が引き継いでいるので触らない）。
    if (this.tokens.get(id) !== token) return null;
    await this.resume();

    if (this.setup.sync === "director_onset") {
      this.buffers.set(id, buffer);
      this.queue.markReady(id, buffer.duration);
      return { id, startsAtMs: 0, skippedSec: 0, durationSec: buffer.duration, queued: true };
    }
    return this.startScheduled(id, buffer, atMs, durationSec);
  }

  /**
   * 音を持たない仮想エントリ（`audio_source: director`）。
   * 字幕・強調を実際の発話開始に合わせるためだけに FIFO に載せる。
   */
  private playSilent(id: string, atMs: number, durationSec: number): ScheduledPlay {
    if (this.setup.sync === "director_onset") {
      this.silent.add(id);
      this.queue.push({ id, atMs, durationSec, ready: true });
      return { id, startsAtMs: 0, skippedSec: 0, durationSec, queued: true };
    }
    // `scheduled` では指定時刻に切り替える（デーモンのタイマーと同じ時刻）。
    window.setTimeout(
      () => {
        this.remember(id);
        this.onStarted?.({ id, startedAtMs: this.epochNowMs(), trigger: "scheduled", atMs, durationSec });
      },
      Math.max(0, atMs - this.epochNowMs()),
    );
    return { id, startsAtMs: atMs, skippedSec: 0, durationSec, queued: false };
  }

  /**
   * `audio_sync: scheduled`：指定時刻ちょうどに鳴らす（v0.3 までの挙動）。
   *
   * fetch / decode に手間取って `atMs` を過ぎていたら、**遅れた分だけ頭を切って**
   * すぐ鳴らす。頭から鳴らすと以降の発話が全部その分ずれていくため。
   * 丸ごと過ぎていたら鳴らさない。
   */
  private startScheduled(id: string, buffer: AudioBuffer, atMs: number, durationSec: number): ScheduledPlay {
    this.stop(id);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ttsGain);

    const deltaSec = (atMs - this.epochNowMs()) / 1000;
    const when = this.context.currentTime + Math.max(0, deltaSec);
    const offsetSec = deltaSec < 0 ? -deltaSec : 0;
    if (offsetSec >= buffer.duration) {
      // 発話まるごと過ぎている。ここで鳴らすと後続とぶつかるだけなので捨てる。
      return { id, startsAtMs: atMs, skippedSec: buffer.duration, durationSec: buffer.duration, queued: false };
    }
    source.start(when, offsetSec);
    this.playing.set(id, source);
    source.addEventListener("ended", () => {
      if (this.playing.get(id) === source) this.playing.delete(id);
    });

    const startsAtMs = this.epochNowMs() + (when - this.context.currentTime) * 1000;
    const played = durationSec > 0 ? durationSec : buffer.duration;
    this.onStarted?.({ id, startedAtMs: Math.round(startsAtMs), trigger: "scheduled", atMs, durationSec: played });
    return {
      id,
      startsAtMs,
      skippedSec: Math.round(offsetSec * 1000) / 1000,
      durationSec: played,
      queued: false,
    };
  }

  /**
   * `cancel_audio`：予約・再生中のものを捨てる（`id` 省略で全部）。
   * オンセット待ちの FIFO も一緒に空にする（SPEC §5.1）。
   */
  cancel(id?: string): number {
    const cancelled = this.queue.cancel(id);
    if (id === undefined) {
      this.buffers.clear();
      this.silent.clear();
    } else {
      this.buffers.delete(id);
      this.silent.delete(id);
    }
    return this.stop(id) + cancelled;
  }

  /** 予約・再生中の直接再生を止める（`id` 省略で全部）。 */
  stop(id?: string): number {
    const ids = id === undefined ? [...this.playing.keys()] : [id];
    let stopped = 0;
    for (const key of ids) {
      const source = this.playing.get(key);
      this.playing.delete(key);
      // fetch 中のものも捨てる（世代を進めて着地させない）。
      this.tokens.set(key, ++this.tokenSeq);
      if (!source) continue;
      try {
        source.stop();
        stopped += 1;
      } catch {
        /* まだ start していない / 既に終わっている */
      }
    }
    if (id === undefined) this.tokens.clear();
    return stopped;
  }

  /** 鳴っている・鳴らす予定の本数（オンセット待ちを含む）。 */
  get pendingPlays(): number {
    return this.playing.size + this.queue.pending;
  }
}
