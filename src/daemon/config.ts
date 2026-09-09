import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { AudioSource } from "../shared/protocol.ts";

/** リポジトリルート（このファイルは src/daemon にある）。 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface StreamPorts {
  api: number;
  host: string;
}

/**
 * OpenAI 互換の音声合成 API（`POST {base_url}/v1/audio/speech`）の接続設定。
 * サーバーはこのリポジトリの管理外で、デーモンは起動も停止もしない（.claude/skills/h3-stream-setup/SKILL.md §6）。
 */
export interface TtsConfig {
  /** キャラの voice/tts.yaml に base_url があればそちらが優先される。 */
  base_url: string;
  /** 合成 1 回のタイムアウト（秒）。 */
  request_timeout_sec: number;
  /** 起動時の疎通確認のタイムアウト（秒）。 */
  ping_timeout_sec: number;
}

export interface YoutubeConfig {
  enabled: boolean;
  /**
   * 認証方式。
   * api_key: .env の YOUTUBE_API_KEY を使う（OAuth 不要・broadcast_id 必須）
   * oauth:   client_secret.json + `h3 youtube auth` の refresh token を使う
   */
  auth: "api_key" | "oauth";
  client_secret_path: string;
  token_path: string;
  broadcast_id: string;
  poll_interval_ms: number;
  ng_words: string[];
  /**
   * 配信者本人（配信枠のチャンネル）のコメントを拾うか。
   * 既定 true（テスト中に自分のコメントで動作確認したいため）。
   * false のときだけ従来どおり除外する。
   */
  include_owner_comments: boolean;
}

/**
 * 自前送出（SPEC §8）。headless Chromium で `/compositor` を開き、
 * そこから届く webm を ffmpeg に渡して RTMP（または確認用のファイル）へ出す。
 */
export interface BroadcastConfig {
  /** true で headless Chromium + ffmpeg を起動して送出する。 */
  enabled: boolean;
  /** enabled が false でも Chromium だけ起動して合成を回す（ffmpeg 無しのプレビュー）。 */
  preview: boolean;
  /** rtmp = rtmp_url へ送出 / file = file_path へ書く（ローカル確認用）。 */
  output: "rtmp" | "file";
  /** ストリームキーは .env の RTMP_KEY。ここには書かない。 */
  rtmp_url: string;
  file_path: string;
  encoder: "auto" | "nvenc" | "x264";
  video_bitrate_k: number;
  audio_bitrate_k: number;
  fps: number;
  /** 合成解像度。空なら resolution から決める（768p/720p→1280x720, 1080p→1920x1080）。 */
  width: number | null;
  height: number | null;
  headless: boolean;
  /** Chromium に GPU を使わせる（使えない環境では false）。 */
  gpu: boolean;
  /** MediaRecorder の `timeslice`（ms）。小さいほど低遅延だがオーバーヘッドが増える。 */
  chunk_ms: number;
  /**
   * Director の音声トラックだけを別 MediaRecorder（audio/webm;codecs=opus）で録り、
   * `state/analysis/director-audio-<run>-s<seq>.webm` に残す（解析用）。
   * `audio_source: tts_direct` で直接再生した音と口パクのずれを測るために使う。
   * 送出には一切影響しない。既定 false。
   */
  record_director_audio: boolean;
}

export interface StreamConfig {
  resolution: string;
  aspect_ratio: string;
  chunk_seconds: number;
  memory: number;
  queue_low_sec: number;
  lead_target_sec: number;
  session_max_min: number;
  restart_warn_min: number;
  voice_mode: "tts" | "native";
  /**
   * 配信に乗せる音声の出どころ（SPEC §5.1）。既定 `tts_direct`。
   * `director` は Director の音声トラックをそのまま流す（劣化する。docs/SPEC.md §5.1）。
   */
  audio_source: AudioSource;
  /**
   * `tts_direct` の再生時刻の補正（ms）。compositor は
   * `on_air_at + audio_offset_ms` に wav を鳴らす。正で遅らせる。
   */
  audio_offset_ms: number;
  /** デーモン起動より前に投稿されたコメントを捨てる（初回ポーリングの過去分対策）。 */
  ignore_comments_before_start: boolean;
  endpoint: string;
  ports: StreamPorts;
  tts: TtsConfig;
  youtube: YoutubeConfig;
  broadcast: BroadcastConfig;
  direction_blocklist: string[];
}

const DEFAULT_CONFIG: StreamConfig = {
  resolution: "768p",
  aspect_ratio: "16:9",
  chunk_seconds: 10,
  memory: 20,
  queue_low_sec: 15,
  lead_target_sec: 15,
  session_max_min: 15,
  restart_warn_min: 2,
  voice_mode: "tts",
  audio_source: "tts_direct",
  audio_offset_ms: 0,
  ignore_comments_before_start: true,
  endpoint: "minimax/h3-max/director",
  ports: { api: 8777, host: "127.0.0.1" },
  tts: { base_url: "http://127.0.0.1:8020", request_timeout_sec: 120, ping_timeout_sec: 5 },
  youtube: {
    enabled: false,
    auth: "api_key",
    client_secret_path: "./config/client_secret.json",
    token_path: "./state/youtube_token.json",
    broadcast_id: "",
    poll_interval_ms: 5000,
    ng_words: [],
    include_owner_comments: true,
  },
  broadcast: {
    enabled: false,
    preview: false,
    output: "rtmp",
    rtmp_url: "rtmp://a.rtmp.youtube.com/live2",
    file_path: "./state/preview.flv",
    encoder: "auto",
    video_bitrate_k: 4500,
    audio_bitrate_k: 160,
    fps: 30,
    width: null,
    height: null,
    headless: true,
    gpu: false,
    chunk_ms: 500,
    record_director_audio: false,
  },
  direction_blocklist: [],
};

/** 既定値のコピー。テストや部分上書きの土台に使う（呼び出し側が壊しても影響しない）。 */
export function defaultStreamConfig(): StreamConfig {
  return structuredClone(DEFAULT_CONFIG);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** YAML の部分指定を既定値に重ねる（配列は置き換え、オブジェクトは再帰マージ）。 */
function mergeDeep<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = mergeDeep((base as Record<string, unknown>)[key], value);
  }
  return out as T;
}

/**
 * yaml の文字列に書いた `${VAR}` を環境変数（`.env` 込み）で置き換える。
 * このリポジトリの外を指すパス（TTS の LoRA など）を設定ファイルに直書きしないため。
 * 未定義の変数は空文字になる（TTS の extra_body では空の値は送られない）。
 */
export function expandEnvVars<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "") as T;
  }
  if (Array.isArray(value)) return value.map(expandEnvVars) as T;
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEnvVars(item)])) as T;
  }
  return value;
}

export function readYamlFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  return expandEnvVars(parseYaml(readFileSync(path, "utf8")));
}

/**
 * config/stream.yaml を既定値に重ね、さらに config/youtube.yaml があれば
 * `youtube` セクションだけ上書きする（YouTube 設定はこちらが正）。
 */
export function loadStreamConfig(
  configPath = join(ROOT, "config", "stream.yaml"),
  youtubeConfigPath = join(ROOT, "config", "youtube.yaml"),
): StreamConfig {
  const config = mergeDeep(DEFAULT_CONFIG, readYamlFile(configPath));
  const youtubeRaw = readYamlFile(youtubeConfigPath);
  if (youtubeRaw === undefined) return config;
  return { ...config, youtube: mergeDeep(config.youtube, youtubeRaw) };
}

/** characters/<name>/visual.yaml。_default を継承しキャラ側で上書きする。 */
export interface VisualConfig {
  identity: string;
  frame_rules: string;
  style: string;
  default_scene: string;
}

/**
 * characters/<name>/voice/tts.yaml。OpenAI 互換の音声合成 API に送る値。
 * `_default/tts.yaml` を土台にキャラ側が上書きする。
 */
export interface VoiceConfig {
  /** 既定は config/stream.yaml の tts.base_url。 */
  base_url?: string;
  /** 任意。`.env` の TTS_API_KEY があればそちらが優先される。 */
  api_key?: string;
  /** サーバーが公開しているモデル ID（`GET /v1/models`）。 */
  model: string;
  /** サーバー側のボイス ID。空ならサーバーの既定に任せる。 */
  voice?: string;
  /** 0.25〜4.0。省略するとサーバーの既定。 */
  speed?: number;
  /** 感情指定が無いときの instructions。 */
  instructions_default: string;
  /** `h3 speak --emotion <key>` → instructions に足す文字列。 */
  emotion_instructions: Record<string, string>;
  /**
   * instructions を入れるリクエスト本文のキー（ドット表記）。既定は OpenAI の `instructions`。
   * サーバー独自の場所に入れたいときに使う（例: Irodori-TTS-Server は `irodori.caption`）。
   */
  instructions_field?: string;
  /** サーバー固有の追加フィールド。リクエスト本文にそのままマージされる。 */
  extra_body?: Record<string, unknown>;
}

export interface CharacterConfig {
  name: string;
  dir: string;
  visual: VisualConfig;
  voice: VoiceConfig;
  /** character.md の本文（存在しなければ null）。エージェント向けなのでデーモンは使わない。 */
  characterMd: string | null;
  topicsMd: string | null;
  imagePath: string;
  referenceWavPath: string | null;
}

const EMPTY_VISUAL: VisualConfig = {
  identity: "",
  frame_rules: "",
  style: "",
  default_scene: "",
};

const EMPTY_VOICE: VoiceConfig = {
  model: "",
  instructions_default: "",
  emotion_instructions: {},
};

function readTextFile(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * `--character` 省略時に使うキャラ名。`characters/` にキャラが 1 つだけならそれを使う。
 * 0 個なら `characters/README.md` の手順を、2 つ以上なら候補を挙げて指定を促す。
 * （キャラはインスタンス固有の資産で、リポジトリには雛形しか入っていない。）
 */
export function defaultCharacterName(charactersDir = join(ROOT, "characters")): string {
  const names = existsSync(charactersDir)
    ? readdirSync(charactersDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
        .map((entry) => entry.name)
    : [];
  if (names.length === 1 && names[0]) return names[0];
  if (names.length === 0) {
    throw new Error(
      "characters/ にキャラクターがありません。`cp -r characters/_example characters/<name>` で作ってください（characters/README.md）",
    );
  }
  throw new Error(`--character でキャラクターを指定してください（候補: ${names.join(", ")}）`);
}

export function loadCharacter(name: string, charactersDir = join(ROOT, "characters")): CharacterConfig {
  const dir = join(charactersDir, name);
  if (!existsSync(dir)) {
    throw new Error(`character not found: ${dir}`);
  }
  const defaultDir = join(charactersDir, "_default");

  const visual = mergeDeep(
    mergeDeep(EMPTY_VISUAL, readYamlFile(join(defaultDir, "visual.yaml"))),
    readYamlFile(join(dir, "visual.yaml")),
  );
  const voice = mergeDeep(
    mergeDeep(EMPTY_VOICE, readYamlFile(join(defaultDir, "tts.yaml"))),
    readYamlFile(join(dir, "voice", "tts.yaml")),
  );

  const voiceDir = join(dir, "voice");
  const referenceWav = join(voiceDir, "reference.wav");

  return {
    name,
    dir,
    visual,
    voice,
    characterMd: readTextFile(join(dir, "character.md")),
    topicsMd: readTextFile(join(dir, "topics.md")),
    imagePath: join(dir, "image.png"),
    referenceWavPath: existsSync(referenceWav) ? referenceWav : null,
  };
}

/** config 内の ./ 始まりのパスをリポジトリルートから解決する。 */
export function resolveFromRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(ROOT, path);
}

/** 合成 canvas の大きさ。`broadcast.width/height` が無ければ resolution から決める。 */
export function broadcastSize(config: StreamConfig): { width: number; height: number } {
  const { width, height } = config.broadcast;
  if (width && height) return { width, height };
  return config.resolution === "1080p" ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
}
