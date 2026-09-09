import assert from "node:assert/strict";
import test from "node:test";
import { defaultStreamConfig, type VoiceConfig } from "../src/daemon/config.ts";
import { parseWavFormat, TtsClient, TtsError } from "../src/daemon/tts.ts";

/**
 * OpenAI 互換の音声合成 API（`POST /v1/audio/speech`）を fetch のスタブで置き換えて
 * クライアントの組み立て・エラー処理を確かめる。
 */

const VOICE: VoiceConfig = {
  model: "irodori-tts",
  voice: "example",
  speed: 1.1,
  instructions_default: "明るい声。",
  emotion_instructions: { happy: "とても嬉しそうに。" },
};

/** 16bit mono の最小 wav（無音 `frames` サンプル）を Response の本体として返す。 */
function makeWav(sampleRate: number, frames: number): ArrayBuffer {
  const dataSize = frames * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byteRate
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataSize, true);
  return buffer;
}

interface Captured {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/** fetch を差し替え、最後のリクエストを captured に残す。戻り値で元に戻す。 */
function stubFetch(captured: Captured[], respond: (url: string) => Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    captured.push({ url, init: init ?? {}, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return respond(url);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeClient(voice: Partial<VoiceConfig> = {}): TtsClient {
  const client = new TtsClient(defaultStreamConfig().tts, { ...VOICE, ...voice });
  client.upload = async () => "https://fal.test/u0001.wav";
  return client;
}

test("synthesize は POST /v1/audio/speech に OpenAI 互換の JSON を送る", async () => {
  const captured: Captured[] = [];
  const restore = stubFetch(
    captured,
    () => new Response(makeWav(48000, 48000 * 3), { status: 200, headers: { "content-type": "audio/wav" } }),
  );
  try {
    const result = await makeClient().synthesize({ text: "こんにちは", instructions: "明るい声。" });
    assert.equal(captured[0]?.url, "http://127.0.0.1:8020/v1/audio/speech");
    assert.deepEqual(captured[0]?.body, {
      model: "irodori-tts",
      input: "こんにちは",
      response_format: "wav",
      voice: "example",
      speed: 1.1,
      instructions: "明るい声。",
    });
    assert.equal(result.audio_url, "https://fal.test/u0001.wav");
    assert.equal(result.duration_sec, 3);
    assert.equal(result.sample_rate, 48000);
    assert.equal(result.instructions, "明るい声。");
    assert.ok(result.wav && result.wav.byteLength > 0);
  } finally {
    restore();
  }
});

test("48kHz 以外の wav でも長さとサンプルレートをヘッダから読む", async () => {
  const captured: Captured[] = [];
  const restore = stubFetch(captured, () => new Response(makeWav(24000, 24000 * 2), { status: 200 }));
  try {
    const result = await makeClient().synthesize({ text: "テスト", instructions: "" });
    assert.equal(result.duration_sec, 2);
    assert.equal(result.sample_rate, 24000);
  } finally {
    restore();
  }
});

test("instructions_field と extra_body でサーバー独自の場所に入れられる", async () => {
  const captured: Captured[] = [];
  const restore = stubFetch(captured, () => new Response(makeWav(48000, 4800), { status: 200 }));
  try {
    const client = makeClient({
      instructions_field: "irodori.caption",
      extra_body: { irodori: { lora_adapter: "/models/example", num_steps: 24 } },
    });
    await client.synthesize({ text: "やっほー", instructions: "元気に。" });
    assert.deepEqual(captured[0]?.body["irodori"], {
      lora_adapter: "/models/example",
      num_steps: 24,
      caption: "元気に。",
    });
    assert.equal(captured[0]?.body["instructions"], undefined);
  } finally {
    restore();
  }
});

test("api_key があれば Authorization: Bearer を付ける", async () => {
  const captured: Captured[] = [];
  const restore = stubFetch(captured, () => new Response(makeWav(48000, 4800), { status: 200 }));
  const previous = process.env.TTS_API_KEY;
  process.env.TTS_API_KEY = "secret-token";
  try {
    await makeClient().synthesize({ text: "a", instructions: "" });
    const headers = captured[0]?.init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer secret-token");
  } finally {
    restore();
    if (previous === undefined) delete process.env.TTS_API_KEY;
    else process.env.TTS_API_KEY = previous;
  }
});

test("HTTP エラーは tts_failed、接続不可は tts_unavailable", async () => {
  const captured: Captured[] = [];
  let restore = stubFetch(captured, () => new Response("bad voice", { status: 400 }));
  try {
    await assert.rejects(
      () => makeClient().synthesize({ text: "a", instructions: "" }),
      (error: unknown) => error instanceof TtsError && error.code === "tts_failed",
    );
  } finally {
    restore();
  }

  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => makeClient().synthesize({ text: "a", instructions: "" }),
      (error: unknown) => error instanceof TtsError && error.code === "tts_unavailable",
    );
  } finally {
    globalThis.fetch = original;
  }

  restore = stubFetch(captured, () => new Response(makeWav(48000, 4800), { status: 200 }));
  try {
    await assert.rejects(
      () => makeClient({ model: "" }).synthesize({ text: "a", instructions: "" }),
      (error: unknown) => error instanceof TtsError && error.code === "tts_config",
    );
  } finally {
    restore();
  }
});

test("ping は /v1/models を見て、無ければ /health を試す", async () => {
  const captured: Captured[] = [];
  let restore = stubFetch(captured, (url) => new Response("{}", { status: url.endsWith("/v1/models") ? 200 : 404 }));
  try {
    assert.equal(await makeClient().ping(), true);
    assert.deepEqual(
      captured.map((entry) => entry.url),
      ["http://127.0.0.1:8020/v1/models"],
    );
  } finally {
    restore();
  }

  captured.length = 0;
  restore = stubFetch(captured, (url) => new Response("{}", { status: url.endsWith("/health") ? 200 : 404 }));
  try {
    assert.equal(await makeClient().ping(), true);
    assert.deepEqual(
      captured.map((entry) => entry.url),
      ["http://127.0.0.1:8020/v1/models", "http://127.0.0.1:8020/health"],
    );
  } finally {
    restore();
  }

  captured.length = 0;
  restore = stubFetch(captured, () => new Response("nope", { status: 500 }));
  try {
    assert.equal(await makeClient().ping(), false);
  } finally {
    restore();
  }
});

test("instructionsFor は instructions_default に emotion_instructions を足す", () => {
  const client = makeClient();
  assert.equal(client.instructionsFor(null), "明るい声。");
  assert.equal(client.instructionsFor("happy"), "明るい声。とても嬉しそうに。");
  assert.equal(client.instructionsFor("unknown"), "明るい声。", "未知の emotion は既定だけ");
});

test("base_url はキャラ側が優先され、末尾の / は落とす", () => {
  assert.equal(makeClient({ base_url: "http://tts.example:9000/" }).baseUrl, "http://tts.example:9000");
});

test("parseWavFormat は RIFF/WAVE 以外を弾く", () => {
  assert.throws(
    () => parseWavFormat(new Uint8Array(64)),
    (error: unknown) => error instanceof TtsError && error.code === "tts_bad_wav",
  );
});

test("extra_body の空文字（未設定の ${VAR}）は送らない", async () => {
  const captured: Captured[] = [];
  const restore = stubFetch(captured, () => new Response(makeWav(48000, 4800), { status: 200 }));
  try {
    const client = makeClient({ extra_body: { irodori: { lora_adapter: "", cfg_scale_caption: 3.0 } } });
    await client.synthesize({ text: "a", instructions: "" });
    assert.deepEqual(captured[0]?.body["irodori"], { cfg_scale_caption: 3.0 });
  } finally {
    restore();
  }
});
