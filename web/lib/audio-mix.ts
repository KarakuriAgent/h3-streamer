import type { AudioSource } from "../../src/shared/protocol.ts";

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
 *  Director tracks ─▶ tap ─┬─▶ directorGain ─┐
 *                          │  (tts_direct=0) ├─▶ destination ─▶ MediaRecorder（送出）
 *   play_audio の wav ─────┼─▶ ttsGain ──────┘
 *                          └─▶ recordDestination ─▶ MediaRecorder（解析用の別録り）
 * ```
 *
 * `audio_source: tts_direct` では Director の音声を 0 に絞り（口パクの条件付けにだけ使う）、
 * デーモンが指示した時刻に TTS の wav をそのまま鳴らす。Director の音声トラックは
 * モデルが再合成したもので、16kHz 以上が消え元 TTS との波形相関が 0.175 まで落ちる
 * （docs/SPEC.md §5.1）ため、配信にはこちらを乗せない。
 */

/** `play_audio` を鳴らした結果。デーモンに返してタイミングの実測に使う。 */
export interface ScheduledPlay {
  id: string;
  /** 実際に鳴り始める時刻（`Date.now()` 基準の推定）。 */
  startsAtMs: number;
  /** 指定時刻に間に合わず頭を切った秒数。 */
  skippedSec: number;
  durationSec: number;
}

export class AudioMix {
  readonly context: AudioContext;
  private readonly destination: MediaStreamAudioDestinationNode;
  /** Director 音声の合流点。ここから送出用のゲインと解析用の別録りに分岐する。 */
  private readonly directorTap: GainNode;
  /** 送出に乗せる Director 音声の音量。`tts_direct` では 0。 */
  private readonly directorGain: GainNode;
  /** 直接再生する TTS wav の音量。 */
  private readonly ttsGain: GainNode;
  private recordDestination: MediaStreamAudioDestinationNode | null = null;
  private readonly sources = new Map<string, MediaStreamAudioSourceNode>();
  /** 予約済み・再生中の直接再生。id で置き換え・取り消しができるようにする。 */
  private readonly playing = new Map<string, AudioBufferSourceNode>();
  /** id ごとの世代番号。fetch 中に同じ id が来たら古い方を捨てる。 */
  private readonly tokens = new Map<string, number>();
  private tokenSeq = 0;

  constructor(sampleRate = 48_000) {
    this.context = new AudioContext({ sampleRate, latencyHint: "playback" });
    this.destination = this.context.createMediaStreamDestination();

    this.directorTap = this.context.createGain();
    this.directorGain = this.context.createGain();
    this.ttsGain = this.context.createGain();
    this.directorTap.connect(this.directorGain);
    this.directorGain.connect(this.destination);
    this.ttsGain.connect(this.destination);

    // 無音でもグラフを回し続けるためのソース。これが音声トラックの存在を保証する。
    const silence = this.context.createConstantSource();
    silence.offset.value = 0;
    silence.connect(this.destination);
    silence.start();
  }

  /** MediaRecorder に渡す音声トラック。Director の有無にかかわらず常に 1 本ある。 */
  get track(): MediaStreamTrack {
    const [track] = this.destination.stream.getAudioTracks();
    if (!track) throw new Error("audio destination has no track");
    return track;
  }

  /**
   * 配信に乗せる音声の出どころを切り替える（SPEC §5.1）。
   * `tts_direct` では Director の音声トラックは受け続けるがゲインを 0 にする。
   */
  setSource(source: AudioSource): void {
    this.directorGain.gain.value = source === "tts_direct" ? 0 : 1;
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
   * wav を取ってきて `atMs`（`Date.now()` 基準の絶対時刻）に鳴らす。
   *
   * - 同じ `id` を渡すと前の予約を置き換える（`audio_applied` での撃ち直し用）。
   * - fetch / decode に手間取って `atMs` を過ぎていたら、**遅れた分だけ頭を切って**
   *   すぐ鳴らす。頭から鳴らすと以降の発話が全部その分ずれていくため。
   * - 丸ごと過ぎていたら鳴らさない。
   */
  async play(id: string, url: string, atMs: number, durationSec: number): Promise<ScheduledPlay | null> {
    const token = ++this.tokenSeq;
    this.tokens.set(id, token);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`fetch ${url} → HTTP ${response.status}`);
    const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
    // fetch/decode の間に同じ id が撃ち直されていたら、こちらは捨てる。
    if (this.tokens.get(id) !== token) return null;
    await this.resume();

    this.stop(id);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ttsGain);

    const deltaSec = (atMs - this.epochNowMs()) / 1000;
    const when = this.context.currentTime + Math.max(0, deltaSec);
    const offsetSec = deltaSec < 0 ? -deltaSec : 0;
    if (offsetSec >= buffer.duration) {
      // 発話まるごと過ぎている。ここで鳴らすと後続とぶつかるだけなので捨てる。
      return { id, startsAtMs: atMs, skippedSec: buffer.duration, durationSec: buffer.duration };
    }
    source.start(when, offsetSec);
    this.playing.set(id, source);
    source.addEventListener("ended", () => {
      if (this.playing.get(id) === source) this.playing.delete(id);
    });

    return {
      id,
      startsAtMs: this.epochNowMs() + (when - this.context.currentTime) * 1000,
      skippedSec: Math.round(offsetSec * 1000) / 1000,
      durationSec: durationSec > 0 ? durationSec : buffer.duration,
    };
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

  get pendingPlays(): number {
    return this.playing.size;
  }
}
