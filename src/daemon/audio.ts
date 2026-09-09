import { appendFileSync, createWriteStream, mkdirSync, writeFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { parseWavDuration } from "./tts.ts";

/**
 * `audio_source: tts_direct`（SPEC §5.1）まわりのデーモン側の道具。
 *
 * - `AudioStore`            … compositor に配る wav を持ち、`/audio/<id>.wav` で返す
 * - `DirectorAudioRecorder` … Director 音声トラックだけの別録りを受けてファイルに落とす
 * - `TtsScheduleLog`        … 何をいつ鳴らすよう指示したかを jsonl に残す
 *
 * 直接再生する wav を fal storage 経由にしない理由は 2 つ。
 * 1. Director を使わないローカル検証（`h3 audio test`）でも同じ経路を通したい。
 * 2. 送出ホストからの取得を localhost に閉じ、ネットワークの揺れを再生時刻に持ち込まない。
 */

/** 保持する wav の本数。1 本 1MB 前後なので、これ以上は古い順に捨てる。 */
const MAX_ENTRIES = 64;

export interface AudioEntry {
  id: string;
  bytes: Uint8Array;
  durationSec: number;
  createdAtMs: number;
}

/**
 * compositor に直接再生させる wav の置き場（メモリ）。
 *
 * 配信中に積まれる発話は数十本なので永続化はしない。デーモンを落としたら
 * 予約も一緒に消えるため、残しておく意味がない。
 */
export class AudioStore {
  private readonly entries = new Map<string, AudioEntry>();
  private counter = 0;

  /** wav を登録して id を返す。長さは wav ヘッダから読む（呼び出し側が知っていれば渡す）。 */
  put(bytes: Uint8Array, durationSec?: number): AudioEntry {
    this.counter += 1;
    const id = `a${String(this.counter).padStart(5, "0")}`;
    const entry: AudioEntry = {
      id,
      bytes,
      durationSec: durationSec ?? parseWavDuration(bytes),
      createdAtMs: Date.now(),
    };
    this.entries.set(id, entry);
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry;
  }

  /**
   * wav を持たない仮想エントリ（字幕・強調の切替だけに使う）用の id。
   * `/audio/<id>.wav` は存在しないので、compositor は fetch しない。
   */
  nextSilentId(): string {
    this.counter += 1;
    return `s${String(this.counter).padStart(5, "0")}`;
  }

  get(id: string): AudioEntry | undefined {
    return this.entries.get(id);
  }

  /** compositor が fetch する URL。デーモン自身の HTTP に閉じる。 */
  url(id: string): string {
    return `/audio/${id}.wav`;
  }

  get size(): number {
    return this.entries.size;
  }
}

/** `state/analysis/` に置くファイル名の頭に付ける、このデーモン起動を表す ID。 */
export function makeRunId(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

export interface AnalysisLogger {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * compositor が別録りした Director の音声（audio/webm;codecs=opus）を受けて
 * `state/analysis/director-audio-<run>-s<seq>.webm` に書く。
 *
 * webm はヘッダが先頭チャンクにしか無いので、**接続 1 本 = ファイル 1 本**にする。
 * 口パクとのずれを測るには録画開始の絶対時刻が要るので、同名の `.meta.json` に
 * `started_at_ms` を残す（`tts-schedule-*.jsonl` の `at_ms` と同じ時計）。
 */
export class DirectorAudioRecorder {
  private stream: WriteStream | null = null;
  private path: string | null = null;
  private bytes = 0;

  constructor(
    private readonly analysisDir: string,
    private readonly runId: string,
    private readonly logger: AnalysisLogger,
  ) {}

  get currentPath(): string | null {
    return this.path;
  }

  get bytesWritten(): number {
    return this.bytes;
  }

  attach(socket: WebSocket, sessionSeq: number): void {
    // 前の録りが残っていたら閉じる（ページを開き直したときなど）。
    this.close();
    mkdirSync(this.analysisDir, { recursive: true });
    const path = join(this.analysisDir, `director-audio-${this.runId}-s${sessionSeq}.webm`);
    const startedAtMs = Date.now();
    this.path = path;
    this.bytes = 0;
    this.stream = createWriteStream(path);
    writeFileSync(
      `${path}.meta.json`,
      `${JSON.stringify({ started_at_ms: startedAtMs, started_at: new Date(startedAtMs).toISOString(), session_seq: sessionSeq }, null, 2)}\n`,
    );
    this.logger.info(`director audio recording → ${path}`);

    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      this.bytes += chunk.length;
      this.stream?.write(chunk);
    });
    socket.on("close", () => {
      this.logger.info(`director audio recording closed (${this.bytes} bytes)`);
      this.close();
    });
    socket.on("error", (error) => this.logger.warn(`director audio socket error: ${String(error)}`));
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}

export interface TtsScheduleEntry {
  id: string;
  url: string;
  at_ms: number;
  duration_sec: number;
  prompt_version: number | null;
  [key: string]: unknown;
}

/**
 * 「どの wav をいつ鳴らすよう指示したか」を
 * `state/analysis/tts-schedule-<run>.jsonl` に 1 行 1 件で残す。
 * 別録りした Director 音声と突き合わせて口パクのずれを測るための台帳。
 */
export class TtsScheduleLog {
  readonly path: string;

  constructor(analysisDir: string, runId: string) {
    mkdirSync(analysisDir, { recursive: true });
    this.path = join(analysisDir, `tts-schedule-${runId}.jsonl`);
  }

  append(entry: TtsScheduleEntry): void {
    try {
      // 追記だけなので同期で書く（1 発話につき 1 行）。
      appendFileSync(this.path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    } catch {
      // 解析用の記録なので、書けなくても配信は続ける。
    }
  }
}
