import type { TtsConfig, VoiceConfig } from "./config.ts";
import { readEnvFile } from "./env.ts";
import { uploadBuffer } from "./falstorage.ts";

export class TtsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "TtsError";
  }
}

export interface WavFormat {
  duration_sec: number;
  sample_rate: number;
  channels: number;
}

/**
 * RIFF/WAVE ヘッダから再生秒数とサンプリングレートを読む（秒数は `データ長 ÷ byteRate`）。
 *
 * サンプリングレートは決め打ちにしない。OpenAI 互換サーバーが何 Hz の wav を返すかは
 * 実装依存で、ここで読んだ値をそのまま下流（compositor / Director）に渡す。
 *
 * `byteRate` は fmt チャンク本体の +8 にある。ここを +4（sampleRate）と
 * 取り違えると 16bit mono で長さが 2 倍になる。
 */
export function parseWavFormat(bytes: Uint8Array): WavFormat {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number): string =>
    String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
  if (ascii(0) !== "RIFF" || ascii(8) !== "WAVE") {
    throw new TtsError("tts_bad_wav", "TTS server did not return a RIFF/WAVE file");
  }
  let offset = 12;
  let byteRate = 0;
  let sampleRate = 0;
  let channels = 0;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      // fmt チャンクの本体は offset+8 から。
      // format(+0) channels(+2) sampleRate(+4) **byteRate(+8)** blockAlign(+12) bits(+14)
      channels = view.getUint16(offset + 8 + 2, true);
      sampleRate = view.getUint32(offset + 8 + 4, true);
      byteRate = view.getUint32(offset + 8 + 8, true);
    } else if (id === "data") {
      if (byteRate <= 0) break;
      const dataSize = Math.min(size, bytes.byteLength - (offset + 8));
      return { duration_sec: dataSize / byteRate, sample_rate: sampleRate, channels };
    }
    offset += 8 + size + (size % 2);
  }
  throw new TtsError("tts_bad_wav", "could not find a usable fmt/data chunk in the TTS wav");
}

/** wav ヘッダから再生秒数だけを読む。 */
export function parseWavDuration(bytes: Uint8Array): number {
  return parseWavFormat(bytes).duration_sec;
}

export interface TtsRequest {
  text: string;
  /** --emotion から引いた instructions。無ければ instructions_default。 */
  instructions: string;
}

export interface TtsResult {
  audio_url: string;
  duration_sec: number;
  bytes: number;
  instructions: string;
  /** 返ってきた wav のサンプリングレート（Hz）。サーバー実装依存なので決め打ちしない。 */
  sample_rate: number;
  /**
   * 生成された wav そのもの。`audio_source: tts_direct` のとき、デーモンはこれを
   * `/audio/<id>.wav` で compositor に配って直接再生させる（SPEC §5.1）。
   * テストのスタブが返さなくても済むよう任意にしてある。
   */
  wav?: Uint8Array;
}

/**
 * 空文字の値を落とす（入れ子も見る）。`extra_body` に `${VAR}` を書いたとき、
 * その環境変数が未設定なら「指定しなかった」ことにするため。
 */
function pruneEmpty(value: unknown): unknown {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (Array.isArray(value)) return value;
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const pruned = pruneEmpty(item);
    if (pruned !== undefined) out[key] = pruned;
  }
  return out;
}

/** `instructions_field` のドット表記に沿って値を差し込む（例: `irodori.caption`）。 */
function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".").filter((key) => key.length > 0);
  const last = keys.pop();
  if (!last) return;
  let cursor = target;
  for (const key of keys) {
    const next = cursor[key];
    if (typeof next === "object" && next !== null && !Array.isArray(next)) {
      cursor = next as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      cursor[key] = created;
      cursor = created;
    }
  }
  cursor[last] = value;
}

/**
 * OpenAI 互換の音声合成 API のクライアント。
 *
 * - 合成 : `POST {base_url}/v1/audio/speech`（JSON → `audio/wav`）
 * - 疎通 : `GET {base_url}/v1/models`、無ければ `GET {base_url}/health`
 *
 * サーバーはこのリポジトリの管理外（別プロセス・別ホスト）で、デーモンは起動も停止もしない。
 * 具体的なサーバーの立て方は `docs/setup.md` §4。
 */
export class TtsClient {
  private readonly config: TtsConfig;
  private readonly voice: VoiceConfig;
  private counter = 0;
  /** 生成した wav を fal storage に上げる関数。テストで差し替える。 */
  upload: (bytes: Uint8Array, filename: string, contentType: string) => Promise<string> = uploadBuffer;

  constructor(config: TtsConfig, voice: VoiceConfig) {
    this.config = config;
    this.voice = voice;
  }

  /** キャラの voice/tts.yaml の base_url を優先し、無ければ config/stream.yaml のもの。 */
  get baseUrl(): string {
    return (this.voice.base_url ?? this.config.base_url).replace(/\/+$/, "");
  }

  /** `.env` の `TTS_API_KEY` を優先する（yaml に鍵を書かせないため）。 */
  get apiKey(): string {
    return process.env.TTS_API_KEY || readEnvFile().TTS_API_KEY || this.voice.api_key || "";
  }

  private headers(): Record<string, string> {
    const key = this.apiKey;
    return {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    };
  }

  /** --emotion → instructions 変換（tts.yaml の emotion_instructions）。 */
  instructionsFor(emotion?: string | null): string {
    const base = this.voice.instructions_default ?? "";
    if (!emotion) return base;
    const extra = this.voice.emotion_instructions?.[emotion];
    if (!extra) return base;
    return base.length > 0 ? `${base}${extra}` : extra;
  }

  /**
   * 疎通確認。`GET /v1/models` を叩き、それが無いサーバーのために `GET /health` も試す。
   * 失敗しても例外は投げない（デーモンは TTS 無しでも起動を続ける）。
   */
  async ping(): Promise<boolean> {
    for (const path of ["/v1/models", "/health"]) {
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method: "GET",
          signal: AbortSignal.timeout(this.config.ping_timeout_sec * 1000),
        });
        if (response.ok) return true;
      } catch {
        /* 次の候補を試す */
      }
    }
    return false;
  }

  /** デーモン起動時の疎通確認。外部サービス前提なので spawn はしない。 */
  async start(): Promise<{ ready: boolean; base_url: string }> {
    return { ready: await this.ping(), base_url: this.baseUrl };
  }

  /** `POST /v1/audio/speech` に送る JSON を組み立てる。 */
  buildRequestBody(request: TtsRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.voice.model,
      input: request.text,
      response_format: "wav",
      ...(this.voice.voice ? { voice: this.voice.voice } : {}),
      ...(this.voice.speed !== undefined ? { speed: this.voice.speed } : {}),
      ...((pruneEmpty(this.voice.extra_body ?? {}) as Record<string, unknown>) ?? {}),
    };
    if (request.instructions) {
      // 既定は OpenAI の `instructions`。サーバー独自の場所に入れたいときは
      // tts.yaml の instructions_field に `irodori.caption` のように書く。
      setByPath(body, this.voice.instructions_field ?? "instructions", request.instructions);
    }
    return body;
  }

  /** テキスト → wav → fal storage。返り値の audio_url を Director の audio_url に渡す。 */
  async synthesize(request: TtsRequest): Promise<TtsResult> {
    if (!this.voice.model) {
      throw new TtsError(
        "tts_config",
        "characters/<name>/voice/tts.yaml の model が空です（TTS サーバーの GET /v1/models のモデル ID を書いてください）",
      );
    }
    const url = `${this.baseUrl}/v1/audio/speech`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.buildRequestBody(request)),
        signal: AbortSignal.timeout(this.config.request_timeout_sec * 1000),
      });
    } catch (error) {
      throw new TtsError(
        "tts_unavailable",
        `TTS server ${this.baseUrl} に接続できない (${String(error)})。OpenAI 互換の音声合成サーバーを起動するか、tts.base_url を直す（docs/setup.md §4）。`,
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new TtsError("tts_failed", `TTS server returned HTTP ${response.status}: ${body.slice(0, 400)}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const format = parseWavFormat(bytes);
    this.counter += 1;
    const name = `u${String(this.counter).padStart(4, "0")}.wav`;
    const audioUrl = await this.upload(bytes, name, "audio/wav");
    return {
      audio_url: audioUrl,
      duration_sec: Math.round(format.duration_sec * 10) / 10,
      bytes: bytes.byteLength,
      instructions: request.instructions,
      sample_rate: format.sample_rate,
      wav: bytes,
    };
  }
}
