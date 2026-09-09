/**
 * デーモン ⇄ ブラウザページ間の WebSocket メッセージ。
 *
 * Director（fal `minimax/h3-max/director`）のセッションは WebRTC(WMA) 前提なので
 * ブラウザ側（`/viewer`）が保持する。デーモンは制御メッセージを中継するだけで、
 * FAL_KEY はデーモンの `/api/fal/proxy` に閉じ込める。
 */

/** Director の configure メッセージ（SPEC §5）。 */
export interface DirectorConfigure {
  type: "configure";
  protocol_version: 1;
  /** セッション内で単調増加する版番号。configure が 1 で、prompt ごとに +1。 */
  prompt_version: number;
  prompt: string;
  image_url: string;
  aspect_ratio: string;
  resolution: string;
  memory: number;
  audio_url?: string;
}

/**
 * Director の prompt メッセージ（SPEC §5）。
 *
 * `prompt_version` は **必ず前回より大きくしなければならない**。同じ値で送ると
 * サーバーが `{"type":"error","code":"stale_prompt_version"}` を返してプロンプトを捨てる
 * （実測。SPEC §0.4）。採番は `DirectorController` が持つ。
 */
export interface DirectorPrompt {
  type: "prompt";
  prompt_version: number;
  prompt: string;
  audio_url?: string;
  audio_behavior?: "queue" | "replace";
  replan?: boolean;
}

/** 版番号を採番する前の prompt。`DirectorController.prompt()` が番号を付けて送る。 */
export type DirectorPromptRequest = Omit<DirectorPrompt, "prompt_version">;

/** セッションを明示的に終わらせる（`session_info.client_message_types` にある）。 */
export interface DirectorStop {
  type: "stop";
}

export type DirectorControlMessage = DirectorConfigure | DirectorPrompt | DirectorStop;

/**
 * `session_info`（接続直後に届く能力表）。実測値の例：
 *
 * ```json
 * { "type":"session_info","app":"minimax-h3-max-director","protocol_version":1,
 *   "default_chunk_duration":10,"min_chunk_duration":5,"max_chunk_duration":15,
 *   "continuation_context_frames":39,"continuation_playback_seconds":8.5,"fps":24,
 *   "audio_sample_rate":48000,"conditioning_audio_sample_rate":32000,
 *   "max_session_seconds":372.466,"session_limit_scope":"effective",
 *   "max_audio_source_seconds":600,"default_memory":12,"max_memory":50, ... }
 * ```
 */
export interface DirectorSessionInfo {
  type: "session_info";
  app?: string;
  protocol_version?: number;
  default_chunk_duration?: number;
  chunk_seconds?: number;
  min_chunk_duration?: number;
  max_chunk_duration?: number;
  /** 1 チャンクのうち実際に再生に足される秒数（重なり分を除いた尺）。実測 8.5。 */
  continuation_playback_seconds?: number;
  continuation_context_frames?: number;
  fps?: number;
  /** 返ってくる音声のサンプリングレート（実測 48000）。 */
  audio_sample_rate?: number;
  /** `audio_url` が内部で変換されるサンプリングレート（実測 32000）。 */
  conditioning_audio_sample_rate?: number;
  /** このセッションで生成できる上限秒数。**15 分ではない**（実測 372.5 秒）。 */
  max_session_seconds?: number;
  session_limit_scope?: string;
  max_audio_source_seconds?: number;
  audio_behaviors?: string[];
  aspect_ratios?: string[];
  resolutions?: string[];
  default_memory?: number;
  min_memory?: number;
  max_memory?: number;
  client_message_types?: string[];
  server_message_types?: string[];
  [key: string]: unknown;
}

/**
 * `chunk`（1 チャンク生成完了）。実測フィールド：
 *
 * ```json
 * { "type":"chunk","chunk_index":3,"prompt_version":1,"generation_seconds":4.981,
 *   "playback_seconds":8.5,"requested_duration_seconds":10,"generated_frame_count":243,
 *   "trimmed_context_frames":39,"next_generation_estimate_seconds":5.797,"route":"gorgonea",
 *   "buffer_depth_seconds":1.604,"buffer_depth_chunks":2,
 *   "scheduling_lead_ms":6585.392,"scheduling_slack_ms":1604.499,"dispatch":{...} }
 * ```
 *
 * `playback_seconds` は **累積の再生位置ではなく、このチャンクが再生に足す秒数**
 * （`requested_duration_seconds` から重なり分を引いたもの）。生成先行分は
 * `buffer_depth_seconds`（生成済みでまだ流れていない秒数）で読む。
 */
export interface DirectorChunk {
  type: "chunk";
  chunk_index?: number;
  prompt_version?: number;
  generation_seconds?: number;
  playback_seconds?: number;
  requested_duration_seconds?: number;
  generated_frame_count?: number;
  trimmed_context_frames?: number;
  next_generation_estimate_seconds?: number;
  route?: string;
  buffer_depth_seconds?: number;
  buffer_depth_chunks?: number;
  scheduling_lead_ms?: number;
  scheduling_slack_ms?: number;
  [key: string]: unknown;
}

/**
 * Director から返ってくるサーバーメッセージ。data channel の JSON 文字列。
 *
 * 実測の `session_info.server_message_types`：
 * `audio_applied` / `audio_exhausted` / `audio_pending` / `audio_rejected` /
 * `chunk` / `chunk_metrics` / `configured` / `deadline_missed` / `error` / `pong` /
 * `prompt_applied` / `prompt_pending` / `prompt_rejected` / `session_info` /
 * `session_metrics` / `stream_exhausted`。
 */
export interface DirectorServerMessage {
  type: string;
  /** chunk / prompt_* / audio_* が持つ、対象のプロンプト版番号。 */
  prompt_version?: number;
  /** chunk / chunk_metrics / deadline_missed */
  chunk_index?: number;
  playback_seconds?: number;
  generated_frame_count?: number;
  requested_duration_seconds?: number;
  buffer_depth_seconds?: number;
  /** type === "error"：`code` が機械可読な理由（例 `stale_prompt_version`）。 */
  code?: string;
  message?: string;
  /** error のときは文字列で理由が入る（`{"error":"prompt_version must increase"}`）。 */
  error?: unknown;
  /** type === "audio_applied"：積んだ音声の実測。 */
  duration_seconds?: number;
  remaining_seconds?: number;
  queued_sources?: number;
  behavior?: string;
  source?: string;
  transcribed?: boolean;
  /** type === "deadline_missed" */
  late_by_seconds?: number;
  [key: string]: unknown;
}

/** Director のエラーを 1 行にする。`code` と本文の両方を拾う。 */
export function describeDirectorError(message: DirectorServerMessage): string {
  const detail =
    typeof message.error === "string"
      ? message.error
      : (message.message ?? JSON.stringify(message.error ?? message));
  return message.code ? `${message.code}: ${detail}` : detail;
}

/**
 * 配信に乗せる音声をどこから取るか（SPEC §5.1 / §8、`config/stream.yaml: audio_source`）。
 *
 * - `director`   … Director の音声トラックをそのまま流す（v0.3 までの挙動）。
 * - `tts_direct` … Director の音声トラックはゲイン 0 にして口パクの条件付けだけに使い、
 *                  配信音声は TTS の wav を compositor 内で直接再生する。
 *                  Director はモデルが音声を再合成するため 16kHz 以上が消え、
 *                  元 TTS との波形相関が 0.175 まで落ちる（docs/SPEC.md §5.1）。
 */
export type AudioSource = "director" | "tts_direct";

/**
 * `tts_direct` の再生開始をどう決めるか（SPEC §5.1、`config/stream.yaml: audio_sync`）。
 *
 * - `director_onset` … Director 音声トラックの立ち上がり（＝口パクの開始）を compositor が
 *                      検知した瞬間に鳴らす。`play_audio` は FIFO キューに積むだけで、
 *                      `at_ms` は順番の目安とフォールバックの締切にしか使わない。
 * - `scheduled`      … `at_ms` の時刻に鳴らす（v0.3 までの挙動）。
 *
 * 推定 `on_air_at` と実際の口パク開始のずれは実測で −0.1〜+9.8 秒。プロンプトは
 * 次のチャンク境界で適用されるため、デーモン側では原理的に詰められない。
 */
export type AudioSync = "director_onset" | "scheduled";

/** `audio_started` の引き金。どうやって再生開始を決めたか。 */
export type PlayTrigger = "onset" | "fallback" | "scheduled";

/**
 * compositor の音声設定。`hello` に載せてページへ渡す。
 * ページは query param ではなくこれを唯一の情報源にする（人が `/compositor` を
 * そのまま開いてもデーモンの設定と食い違わないようにするため）。
 */
export interface AudioSetup {
  source: AudioSource;
  /** Director の音声トラックだけを別 MediaRecorder で録って解析用に保存する。 */
  record_director_audio: boolean;
  /** 再生開始の決め方（既定 `director_onset`）。 */
  sync: AudioSync;
  /** オンセットとみなす Director 音声の RMS（dBFS）。 */
  onset_threshold_db: number;
  /** オンセットを待つ上限（秒）。過ぎたらフォールバックで即時再生する。 */
  onset_fallback_sec: number;
  /** 直接再生する TTS の入力ゲイン（dB）。リミッターの手前に入る。 */
  tts_gain_db: number;
}

/**
 * `tts_direct` のときデーモンが送る「この wav をこの時刻に鳴らせ」。
 *
 * `at_ms` は `Date.now()` 基準の絶対時刻（＝デーモンが推定した `on_air_at` に
 * `audio_offset_ms` を足したもの）。ページは `performance.timeOrigin` と
 * `AudioContext.currentTime` に換算して `AudioBufferSourceNode.start(when)` で鳴らす。
 * 同じ `id` を再送すると**置き換え**になる（`audio_applied` で on_air 推定が
 * 動いたときに鳴らす時刻を上書きするため）。
 */
export interface PlayAudioMessage {
  type: "play_audio";
  id: string;
  /** wav の URL。デーモンの `/audio/<id>.wav` を指す（fal storage は経由しない）。 */
  url: string;
  at_ms: number;
  duration_sec: number;
  /**
   * true = 音は鳴らさず、字幕・強調の切替だけを行う仮想エントリ。
   * `audio_source: director`（配信音声は Director のまま）でも、字幕を
   * 実際の発話開始に合わせるためにオンセット検知の FIFO に載せる。
   */
  silent?: boolean;
  /**
   * この発話の字幕。**鳴り始めた瞬間**に切り替え、`duration_sec` + 0.5 秒で消す
   * （`audio_sync: director_onset` のとき。`scheduled` ではデーモンのタイマーが
   * 従来どおり `on_air_at` で切り替えるので、ここには載せない）。
   */
  subtitle?: string | null;
  /** 同時に強調するコメント id。 */
  highlight_comment_id?: string | null;
}

/** デーモン → ビューワーページ。 */
export type ToViewerMessage =
  | { type: "hello"; endpoint: string; audio: AudioSetup }
  | { type: "open_session"; sessionSeq: number; endpoint: string }
  | { type: "close_session"; sessionSeq: number }
  | { type: "control"; sessionSeq: number; payload: DirectorControlMessage }
  | { type: "capture_frame"; requestId: string }
  | PlayAudioMessage
  /** 予約済みの再生を捨てる（`id` 省略で全部）。session restart / reset で使う。 */
  | { type: "cancel_audio"; id?: string };

/** ビューワーページ → デーモン。 */
export type FromViewerMessage =
  | { type: "ready" }
  | { type: "session_state"; sessionSeq: number; state: "opening" | "live" | "failed" | "closed" }
  | { type: "director_message"; sessionSeq: number; raw: string }
  | { type: "diagnostic"; kind: string; message: string }
  | { type: "viewer_error"; message: string }
  | { type: "frame"; requestId: string; dataUrl?: string; error?: string }
  /**
   * `play_audio` を実際にスケジュールした結果。`skipped_sec` は到着が遅れて
   * 頭を切った秒数（0 なら指定時刻に間に合っている）。タイミング検証に使う。
   */
  | {
      type: "audio_scheduled";
      id: string;
      at_ms: number;
      /** 実際に鳴り始める時刻（`Date.now()` 基準の推定）。 */
      starts_at_ms: number;
      skipped_sec: number;
      duration_sec: number;
    }
  /**
   * 実際に鳴り始めたことの報告（`audio_scheduled` は「いつ鳴らす予定か」なので別物）。
   * `director_onset` ではここでしか実測が取れない。デーモンは
   * `tts-schedule-<run>.jsonl` に追記し、`h3 status` の `audio` に直近値を出す。
   */
  | {
      type: "audio_started";
      id: string;
      /** 鳴り始めた時刻（`Date.now()` 基準）。 */
      started_at_ms: number;
      trigger: PlayTrigger;
      /** そのとき指示されていた `at_ms`（推定との差を出すため）。 */
      at_ms: number;
      duration_sec: number;
    }
  | { type: "audio_error"; id: string; message: string };

/** デーモン → オーバーレイページ。 */
export interface OverlayComment {
  id: string;
  author: string;
  text: string;
  published_at: string;
}

export type ToOverlayMessage =
  | { type: "snapshot"; state: OverlayState }
  | { type: "comments"; comments: OverlayComment[] }
  | { type: "highlight"; commentId: string | null }
  | { type: "subtitle"; text: string | null }
  | { type: "visible"; comments: boolean };

export interface OverlayState {
  comments: OverlayComment[];
  highlight: string | null;
  subtitle: string | null;
  commentsVisible: boolean;
}
