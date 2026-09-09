import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { defaultStreamConfig, loadCharacter, type StreamConfig } from "../src/daemon/config.ts";
import { Daemon } from "../src/daemon/index.ts";
import { toErrorBody } from "../src/daemon/api.ts";
import {
  DirectorController,
  DirectorError,
  isSessionEndedMessage,
  SessionEndedError,
} from "../src/daemon/director.ts";
import type { DirectorServerMessage, FromViewerMessage } from "../src/shared/protocol.ts";
import { isCommentBeforeStart, type ChatComment } from "../src/daemon/state.ts";
import { DirectionBlockedError } from "../src/daemon/prompt.ts";
import { parseWavDuration, TtsError } from "../src/daemon/tts.ts";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * テストが使う設定。**`config/stream.yaml` は読まない**
 * （運用中のファイル、特に `broadcast.enabled` の変更でテストが落ちないようにする）。
 */
function testConfig(overrides: Partial<StreamConfig> = {}): StreamConfig {
  const base = defaultStreamConfig();
  return {
    ...base,
    session_max_min: 6,
    queue_low_sec: 12,
    restart_warn_min: 1,
    // 禁止語のテストが参照する語だけを持たせる。
    direction_blocklist: ["she walks away", "takes off her cap", "out of frame"],
    broadcast: { ...base.broadcast, enabled: false, preview: false },
    ...overrides,
  };
}

/**
 * テスト用の Daemon。状態ディレクトリは一時領域に逃がし、
 * Director はビューワーの代わりにスタブを差し込む（fal も FAL_KEY も要らない）。
 */
interface DirectorStub {
  connected: boolean;
  closed: number;
  configured: number;
  imageUrl: string;
  promptVersion: number;
  /** compositor へ送った play_audio。tts_direct のテストで中身を見る。 */
  plays: { id: string; url: string; at_ms: number; duration_sec: number }[];
  /** cancel_audio を送った回数。 */
  cancels: number;
  onAudioApplied: ((message: DirectorServerMessage) => void) | null;
}

function makeDaemon(overrides: Partial<StreamConfig> = {}): {
  daemon: Daemon;
  director: DirectorStub;
} {
  const stateDir = mkdtempSync(join(tmpdir(), "h3-state-"));
  tempDirs.push(stateDir);
  const config = testConfig(overrides);
  const daemon = new Daemon(config, loadCharacter("_example"), stateDir);

  const stub: DirectorStub & Record<string, unknown> = {
    connected: true,
    closed: 0,
    configured: 0,
    promptVersion: 1,
    plays: [],
    cancels: 0,
    onAudioApplied: null,
    imageUrl: "https://example.test/image.png",
    closeSession(): void {
      stub.closed += 1;
      daemon.state.sessionState = "closed";
    },
    async ensureImageUrl(): Promise<string> {
      return stub.imageUrl;
    },
    configure(): void {
      stub.configured += 1;
      // 実物と同じく configure でセッションが張り直され、音声キューが消える。
      daemon.state.startSession();
    },
    prompt(): { prompt_version: number } {
      stub.promptVersion += 1;
      return { prompt_version: stub.promptVersion };
    },
    playAudio(message: { id: string; url: string; at_ms: number; duration_sec: number }): boolean {
      stub.plays.push(message);
      return stub.connected;
    },
    cancelAudio(): boolean {
      stub.cancels += 1;
      return stub.connected;
    },
  };
  Object.defineProperty(daemon, "director", { value: stub, configurable: true });
  return { daemon, director: stub };
}

function comment(id: string, publishedAt: string): ChatComment {
  return { id, author: "someone", authorChannelId: `ch-${id}`, text: `hello ${id}`, publishedAt };
}

// ---------- h3 reset ----------

test("reset は積んでいた音声キューの残秒数を queue_lost_sec で返し、以後 0 になる", async () => {
  const { daemon, director } = makeDaemon();
  daemon.state.enqueueAudio(6.8);
  daemon.state.enqueueAudio(4.6);
  const lostBefore = daemon.state.queueRemainingSec();
  assert.ok(lostBefore > 11 && lostBefore <= 11.4, `queue was ${lostBefore}`);

  const result = await daemon.restartSession("見た目が崩れた", "reset");

  assert.equal(result.ok, true);
  assert.equal(result.trigger, "reset");
  assert.equal(result.reason, "見た目が崩れた");
  assert.equal(result.queue_cleared, true);
  assert.equal(result.queue_remaining_sec, 0);
  assert.equal(result.queue_lost_sec, lostBefore);
  // セッションは張り直されている。
  assert.equal(director.closed, 1);
  assert.equal(director.configured, 1);
  assert.equal(result.session_seq, 1);
  // セッション上限は config（session_max_min）と session_info の短い方。張り直した直後なので満タン。
  assert.ok((result.session_remaining_sec as number) > daemon.state.sessionMaxSec() - 5);
  // リセット後はキューが空。
  assert.equal(daemon.state.queueRemainingSec(), 0);
});

test("キューが空のときの reset は queue_lost_sec 0", async () => {
  const { daemon } = makeDaemon();
  const result = await daemon.restartSession("manual", "reset");
  assert.equal(result.queue_lost_sec, 0);
  assert.equal(result.queue_cleared, true);
});

test("reset はオーバーレイ状態（コメント一覧・強調・字幕）を残す", async () => {
  const { daemon } = makeDaemon();
  daemon.ingestComment(comment("c1", new Date().toISOString()));
  daemon.overlay.setHighlight("c1");
  daemon.overlay.setSubtitle("いま喋っている字幕");

  await daemon.restartSession("visual drift", "reset");

  assert.equal(daemon.overlay.snapshot.highlight, "c1");
  assert.equal(daemon.overlay.snapshot.subtitle, "いま喋っている字幕");
  assert.equal(daemon.overlay.snapshot.comments.length, 1);
  assert.equal(daemon.state.pendingCount(), 1);
});

test("session restart と reset は trigger だけが違う", async () => {
  const { daemon } = makeDaemon();
  const restart = await daemon.restartSession("session limit", "restart");
  const reset = await daemon.restartSession("visual drift", "reset");
  assert.equal(restart.trigger, "restart");
  assert.equal(reset.trigger, "reset");
  assert.equal(restart.reconfigured, true);
  assert.equal(reset.reconfigured, true);
});

test("ビューワー未接続なら reset は viewer_not_connected", async () => {
  const { daemon, director } = makeDaemon();
  director.connected = false;
  await assert.rejects(
    () => daemon.restartSession("visual drift", "reset"),
    (error: unknown) => error instanceof DirectorError && error.code === "viewer_not_connected",
  );
});

// ---------- 起動前コメントの除外 ----------

test("isCommentBeforeStart は起動前だけ true（壊れた publishedAt は捨てない）", () => {
  const started = Date.parse("2026-01-01T00:00:00.000Z");
  assert.equal(isCommentBeforeStart("2025-12-31T23:59:59.000Z", started), true);
  assert.equal(isCommentBeforeStart("2026-01-01T00:00:00.000Z", started), false);
  assert.equal(isCommentBeforeStart("2026-01-01T00:00:01.000Z", started), false);
  assert.equal(isCommentBeforeStart("not a date", started), false);
});

test("デーモン起動より前のコメントは未使用バッファに入らない", () => {
  const { daemon } = makeDaemon();
  const before = new Date(daemon.state.startedAtMs - 60_000).toISOString();
  const after = new Date(daemon.state.startedAtMs + 1_000).toISOString();

  assert.equal(daemon.ingestComment(comment("old1", before)), false);
  assert.equal(daemon.ingestComment(comment("old2", before)), false);
  assert.equal(daemon.ingestComment(comment("new1", after)), true);

  assert.equal(daemon.state.pendingCount(), 1);
  assert.deepEqual(
    daemon.state.comments(10).map((c) => c.id),
    ["new1"],
  );
  assert.equal(daemon.state.staleCommentsDropped, 2);
});

test("ignore_comments_before_start: false なら過去のコメントも拾う", () => {
  const { daemon } = makeDaemon({ ignore_comments_before_start: false });
  const before = new Date(daemon.state.startedAtMs - 60_000).toISOString();
  assert.equal(daemon.ingestComment(comment("old1", before)), true);
  assert.equal(daemon.state.pendingCount(), 1);
  assert.equal(daemon.state.staleCommentsDropped, 0);
});

// ---------- h3 comments skip ----------

test("skip したコメントは使用済みになり comments に出てこない", () => {
  const { daemon } = makeDaemon();
  const now = new Date(daemon.state.startedAtMs + 1_000).toISOString();
  daemon.ingestComment(comment("c1", now));
  daemon.ingestComment(comment("c2", now));

  const result = daemon.skipComment("c1", "演出ルール違反");
  assert.deepEqual(result, {
    ok: true,
    comment_id: "c1",
    skipped: true,
    reason: "演出ルール違反",
  });
  assert.equal(daemon.state.isCommentUsed("c1"), true);
  assert.deepEqual(
    daemon.state.comments(10).map((c) => c.id),
    ["c2"],
  );
  assert.ok(
    daemon.state.tailLog(20).some((line) => line.includes("skip comment c1") && line.includes("演出ルール違反")),
  );
});

test("既に使用済みのコメントの skip は comment_already_used", () => {
  const { daemon } = makeDaemon();
  const now = new Date(daemon.state.startedAtMs + 1_000).toISOString();
  daemon.ingestComment(comment("c1", now));
  daemon.skipComment("c1", "NG");
  const again = daemon.skipComment("c1", "NG");
  assert.deepEqual(again, { ok: false, error: "comment_already_used", comment_id: "c1" });
});

test("skip したコメントを強調していたら解除する", () => {
  const { daemon } = makeDaemon();
  const now = new Date(daemon.state.startedAtMs + 1_000).toISOString();
  daemon.ingestComment(comment("c1", now));
  daemon.overlay.setHighlight("c1");
  daemon.skipComment("c1", "TTS 失敗");
  assert.equal(daemon.overlay.snapshot.highlight, null);
});

// ---------- speak が失敗したコメントは使用済みにしない ----------

test("TTS が落ちた speak はコメントを使用済みにしない（再試行・skip はエージェントの判断）", async () => {
  const { daemon } = makeDaemon();
  const now = new Date(daemon.state.startedAtMs + 1_000).toISOString();
  daemon.ingestComment(comment("c1", now));
  daemon.tts.synthesize = async () => {
    throw new TtsError("tts_unavailable", "TTS サーバーに繋がらない");
  };

  await assert.rejects(
    () => daemon.speak({ text: "こんにちは", direction: null, emotion: null, commentId: "c1" }),
    (error: unknown) => error instanceof TtsError,
  );

  assert.equal(daemon.state.isCommentUsed("c1"), false);
  assert.equal(daemon.state.pendingCount(), 1);
  assert.equal(daemon.state.queueRemainingSec(), 0);
});

// ---------- direction の禁止語（送信をブロックする） ----------

test("blocklist に引っかかった speak は送信されず、コメントも使用済みにならない", async () => {
  const { daemon } = makeDaemon();
  const now = new Date(daemon.state.startedAtMs + 1_000).toISOString();
  daemon.ingestComment(comment("c1", now));
  let synthesized = 0;
  daemon.tts.synthesize = async () => {
    synthesized += 1;
    return { audio_url: "https://example.test/a.wav", duration_sec: 5, bytes: 1234, instructions: "normal", sample_rate: 48000 };
  };

  await assert.rejects(
    () =>
      daemon.speak({
        text: "はい",
        direction: "she walks away from the desk",
        emotion: null,
        commentId: "c1",
      }),
    (error: unknown) =>
      error instanceof DirectionBlockedError &&
      error.code === "direction_blocked" &&
      error.hits.includes("she walks away"),
  );

  assert.equal(synthesized, 0, "TTS まで行かずに弾く");
  assert.equal(daemon.state.isCommentUsed("c1"), false);
  assert.equal(daemon.state.pendingCount(), 1);
  assert.equal(daemon.state.queueRemainingSec(), 0);
});

test("blocklist に引っかかった direct は送信されない", async () => {
  const { daemon } = makeDaemon();
  await assert.rejects(
    () => daemon.direct("She takes off her cap and waves."),
    (error: unknown) => error instanceof DirectionBlockedError,
  );
});

test("問題ない direction の speak は通る", async () => {
  const { daemon } = makeDaemon();
  const now = new Date(daemon.state.startedAtMs + 1_000).toISOString();
  daemon.ingestComment(comment("c1", now));
  daemon.tts.synthesize = async () => ({
    audio_url: "https://example.test/a.wav",
    duration_sec: 5,
    bytes: 1234,
    instructions: "normal",
    sample_rate: 48000,
  });

  const result = await daemon.speak({
    text: "はい",
    direction: "A small tabby cat hops onto the desk; she laughs.",
    emotion: null,
    commentId: "c1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.comment_used, "c1");
  assert.equal(daemon.state.isCommentUsed("c1"), true);
});

// ---------- h3 broadcast / h3 status ----------

test("broadcast が無効でも status と broadcaster.status() は mode: off を返す", async () => {
  const { daemon } = makeDaemon();
  const status = await daemon.status();
  const broadcast = status.broadcast as Record<string, unknown>;
  assert.equal(broadcast.mode, "off");
  assert.equal(broadcast.running, false);
  assert.deepEqual(daemon.broadcaster.status(), broadcast);
});

test("broadcast が off なら start は何も起こさず stop 後も start し直せる", async () => {
  const { daemon } = makeDaemon();
  assert.deepEqual(await daemon.broadcaster.start(), { mode: "off" });
  await daemon.broadcaster.stop();
  // stop() のあとでも start() が動く（stopping がリセットされる）。
  assert.deepEqual(await daemon.broadcaster.start(), { mode: "off" });
  assert.equal(daemon.broadcaster.status().mode, "off");
});

/** ビューワーから届いたメッセージを流し込む（private ハンドラを型だけ合わせて呼ぶ）。 */
function handleFromViewer(director: DirectorController, message: FromViewerMessage): void {
  (director as unknown as { handleViewerMessage(m: FromViewerMessage): void }).handleViewerMessage(message);
}

// ---------- Director の prompt_version（PoC で判明） ----------

/** `attach` が必要とする最低限の WebSocket もどき。送ったものを溜めるだけ。 */
function fakeSocket(): { sent: unknown[]; readyState: number; send(data: string): void; on(): void } {
  const sent: unknown[] = [];
  return {
    sent,
    readyState: 1,
    send(data: string): void {
      sent.push(JSON.parse(data));
    },
    on(): void {},
  };
}

test("prompt_version は configure が 1、prompt ごとに増える", () => {
  const { daemon } = makeDaemon();
  const state = daemon.state;
  const director = new DirectorController(daemon.config, daemon.character, state);
  const socket = fakeSocket();
  // 実物の WebSocket は使わない（型だけ合わせる）。
  director.attach(socket as unknown as Parameters<DirectorController["attach"]>[0]);

  director.configure("https://example.test/image.png");
  director.prompt({ type: "prompt", prompt: "one", replan: true });
  director.prompt({ type: "prompt", prompt: "two", replan: true });

  const versions = socket.sent
    .filter((m): m is { type: string; payload: { type: string; prompt_version: number } } =>
      (m as { type?: string }).type === "control",
    )
    .map((m) => [m.payload.type, m.payload.prompt_version] as const);
  assert.deepEqual(versions, [
    ["configure", 1],
    ["prompt", 2],
    ["prompt", 3],
  ]);

  // セッションを張り直したら 1 に戻る。
  director.configure("https://example.test/image.png");
  const last = socket.sent.at(-1) as { payload: { prompt_version: number } };
  assert.equal(last.payload.prompt_version, 1);
});

// ---------- セッション終了（session_ended） ----------

test("ended のあいだ speak は session_ended を返し、TTS もコメントも消費しない", async () => {
  const { daemon } = makeDaemon();
  const now = new Date(daemon.state.startedAtMs + 1_000).toISOString();
  daemon.ingestComment(comment("c1", now));
  let synthesized = 0;
  daemon.tts.synthesize = async () => {
    synthesized += 1;
    return { audio_url: "https://example.test/a.wav", duration_sec: 5, bytes: 1234, instructions: "normal", sample_rate: 48000 };
  };

  daemon.state.startSession();
  daemon.state.endSession("stream_exhausted");

  await assert.rejects(
    () => daemon.speak({ text: "はい", direction: null, emotion: null, commentId: "c1" }),
    (error: unknown) =>
      error instanceof SessionEndedError &&
      error.code === "session_ended" &&
      error.reason === "stream_exhausted",
  );

  assert.equal(synthesized, 0, "TTS まで行かない");
  assert.equal(daemon.state.isCommentUsed("c1"), false);
  assert.equal(daemon.state.pendingCount(), 1);
  assert.equal(daemon.state.queueRemainingSec(), 0);
});

test("ended のあいだ direct も session_ended", async () => {
  const { daemon } = makeDaemon();
  daemon.state.startSession();
  daemon.state.endSession("control channel closed");
  await assert.rejects(
    () => daemon.direct("She smiles."),
    (error: unknown) => error instanceof SessionEndedError && error.reason === "control channel closed",
  );
});

test("session_ended は CLI に {ok:false, error, reason} で返る", () => {
  const { status, body } = toErrorBody(new SessionEndedError("stream_exhausted"));
  assert.equal(status, 409);
  assert.equal(body.ok, false);
  assert.equal(body.error, "session_ended");
  assert.equal(body.reason, "stream_exhausted");
});

test("session restart で ended から復帰して speak できる", async () => {
  const { daemon } = makeDaemon();
  daemon.tts.synthesize = async () => ({
    audio_url: "https://example.test/a.wav",
    duration_sec: 5,
    bytes: 1234,
    instructions: "normal",
    sample_rate: 48000,
  });
  daemon.state.startSession();
  daemon.state.endSession("no chunk for 60s");

  const result = await daemon.restartSession("session ended", "restart");
  assert.equal(result.ok, true);
  assert.equal(daemon.state.isSessionEnded(), false);

  const speak = await daemon.speak({ text: "ただいま", direction: null, emotion: null, commentId: null });
  assert.equal(speak.ok, true);
});

test("status は session_state: ended と理由・警告を返す", async () => {
  const { daemon } = makeDaemon();
  daemon.state.startSession();
  daemon.state.onSessionInfo({ type: "session_info", max_session_seconds: 183 });
  daemon.state.endSession("stream_exhausted");

  const status = await daemon.status();
  assert.equal(status.session_state, "ended");
  assert.equal(status.session_ended_reason, "stream_exhausted");
  assert.deepEqual(status.warnings, ["director session limit is 183s (fal credit may be low)"]);
  // チャットを起動していないので stopped。
  assert.equal((status.youtube as Record<string, unknown>).chat_state, "stopped");
});

// ---------- compositor / Director からの終了検知 ----------

test("compositor の data channel 切断メッセージでセッションを ended にする", () => {
  const { daemon } = makeDaemon();
  const state = daemon.state;
  const director = new DirectorController(daemon.config, daemon.character, state);
  const socket = fakeSocket();
  director.attach(socket as unknown as Parameters<DirectorController["attach"]>[0]);
  state.startSession();
  state.sessionState = "live";

  handleFromViewer(director, {
    type: "viewer_error",
    message: "control data channel closed or errored — SCTP died while ICE may still say connected",
  });

  assert.equal(state.sessionState, "ended");
  assert.match(String(state.sessionEndedReason), /control channel closed/);
});

test("Director の stream_exhausted でセッションを ended にする", () => {
  const { daemon } = makeDaemon();
  const state = daemon.state;
  const director = new DirectorController(daemon.config, daemon.character, state);
  const socket = fakeSocket();
  director.attach(socket as unknown as Parameters<DirectorController["attach"]>[0]);
  state.startSession();
  state.sessionState = "live";

  handleFromViewer(director, {
    type: "director_message",
    sessionSeq: state.sessionSeq,
    raw: JSON.stringify({ type: "stream_exhausted", reason: "session limit" }),
  });

  assert.equal(state.sessionState, "ended");
  assert.equal(state.sessionEndedReason, "stream_exhausted");
});

test("ended のあとに来た session_state: live で live に戻らない", () => {
  const { daemon } = makeDaemon();
  const state = daemon.state;
  const director = new DirectorController(daemon.config, daemon.character, state);
  const socket = fakeSocket();
  director.attach(socket as unknown as Parameters<DirectorController["attach"]>[0]);
  state.startSession();
  state.endSession("control channel closed");

  handleFromViewer(director, { type: "session_state", sessionSeq: state.sessionSeq, state: "live" });
  assert.equal(state.sessionState, "ended");
});

test("isSessionEndedMessage は data channel 切断だけを拾う", () => {
  assert.equal(
    isSessionEndedMessage("control data channel closed or errored — SCTP died while ICE may still say connected"),
    true,
  );
  assert.equal(isSessionEndedMessage("peerconnection failed"), true);
  assert.equal(isSessionEndedMessage("play blocked: NotAllowedError"), false);
  assert.equal(isSessionEndedMessage("media: video+audio"), false);
});

// ---------- tts_direct（配信音声の直接再生。SPEC §5.1） ----------

/** parseWavDuration が読める最小の wav（16bit mono）。長さは秒で指定する。 */
function makeWav(seconds: number, sampleRate = 48_000): Uint8Array {
  const samples = Math.round(seconds * sampleRate);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byteRate
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  return bytes;
}

function stubTts(daemon: Daemon, durationSec = 5, withWav = true): void {
  daemon.tts.synthesize = async () => ({
    audio_url: "https://example.test/a.wav",
    duration_sec: durationSec,
    bytes: 1234,
    instructions: "normal",
    sample_rate: 48000,
    ...(withWav ? { wav: makeWav(durationSec) } : {}),
  });
}

test("tts_direct の speak は on_air_at + audio_offset_ms に play_audio を送る", async () => {
  const { daemon, director } = makeDaemon({ audio_source: "tts_direct", audio_offset_ms: 250 });
  stubTts(daemon, 6);

  const result = await daemon.speak({ text: "こんにちは", direction: null, emotion: null, commentId: null });

  assert.equal(director.plays.length, 1);
  const play = director.plays[0]!;
  assert.equal(play.duration_sec, 6);
  assert.match(play.url, /^\/audio\/a\d+\.wav$/);
  assert.equal(play.at_ms, Math.round(result.on_air_at_ms + 250));
  assert.equal(result.play_id, play.id);
  // 直接再生する wav は fal storage ではなくデーモン自身が配る。
  assert.equal(daemon.audioStore.get(play.id)?.bytes.byteLength, makeWav(6).byteLength);
});

test("audio_source: director では play_audio を送らない（従来どおり Director の音声を流す）", async () => {
  const { daemon, director } = makeDaemon({ audio_source: "director" });
  stubTts(daemon);
  const result = await daemon.speak({ text: "はい", direction: null, emotion: null, commentId: null });
  assert.equal(director.plays.length, 0);
  assert.equal(result.play_id, undefined);
  // Director には従来どおり音声を渡す（口パクの条件付け）。
  assert.equal(result.audio_url, "https://example.test/a.wav");
});

test("tts_direct でも Director には audio_url を渡す（口パクの条件付けに必要）", async () => {
  const { daemon } = makeDaemon({ audio_source: "tts_direct" });
  stubTts(daemon);
  const result = await daemon.speak({ text: "はい", direction: null, emotion: null, commentId: null });
  assert.equal(result.audio_url, "https://example.test/a.wav");
});

test("reset / session restart は未再生の直接再生を全部取り消す", async () => {
  const { daemon, director } = makeDaemon({ audio_source: "tts_direct" });
  stubTts(daemon, 8);
  await daemon.speak({ text: "ひとつめ", direction: null, emotion: null, commentId: null });
  await daemon.speak({ text: "ふたつめ", direction: null, emotion: null, commentId: null });

  const result = await daemon.restartSession("見た目が崩れた", "reset");

  assert.equal(director.cancels, 1);
  assert.equal(result.audio_cancelled, 2);
  const status = await daemon.status();
  assert.equal((status.audio as Record<string, unknown>).pending_plays, 0);
});

test("audio_applied の remaining_seconds で直接再生の時刻を撃ち直す", async () => {
  const { daemon, director } = makeDaemon({ audio_source: "tts_direct" });
  stubTts(daemon, 6);
  await daemon.speak({ text: "こんにちは", direction: null, emotion: null, commentId: null });
  const first = director.plays[0]!;

  // Director が「キュー残は 20 秒」と言ってきた＝推定よりずっと後ろにずれる。
  // 実物では DirectorController が syncAudioQueue → onAudioApplied の順で呼ぶ。
  daemon.state.syncAudioQueue(20);
  daemon.onDirectorAudioApplied({
    type: "audio_applied",
    source: "https://example.test/a.wav",
    duration_seconds: 6,
    remaining_seconds: 20,
  });

  assert.equal(director.plays.length, 2, "同じ id で撃ち直す");
  const second = director.plays[1]!;
  assert.equal(second.id, first.id);
  assert.ok(second.at_ms > first.at_ms + 1000, `${second.at_ms} > ${first.at_ms}`);
  // キュー終端（now+20s）から発話長を引いたあたりに来る。
  assert.ok(Math.abs(second.at_ms - (Date.now() + 14_000)) < 1500, String(second.at_ms - Date.now()));
});

test("ずれが小さければ撃ち直さない", async () => {
  const { daemon, director } = makeDaemon({ audio_source: "tts_direct" });
  stubTts(daemon, 6);
  await daemon.speak({ text: "こんにちは", direction: null, emotion: null, commentId: null });
  // 推定どおり（キュー残 = 発話長）なら送り直す必要はない。
  daemon.state.syncAudioQueue(6);
  daemon.onDirectorAudioApplied({
    type: "audio_applied",
    source: "https://example.test/a.wav",
    duration_seconds: 6,
    remaining_seconds: 6,
  });
  assert.equal(director.plays.length, 1);
});

test("h3 audio test は wav を登録して play_audio を送る（Director セッション不要）", () => {
  const { daemon, director } = makeDaemon({ audio_source: "tts_direct" });
  const wavPath = join(daemon.state.stateDir, "test-tone.wav");
  writeFileSync(wavPath, makeWav(2.5));

  const result = daemon.audioTest(wavPath, null, 1500) as Record<string, number | string>;

  assert.equal(director.plays.length, 1);
  assert.equal(result.id, director.plays[0]!.id);
  assert.ok(Math.abs(Number(result.duration_sec) - 2.5) < 0.01, `duration_sec=${String(result.duration_sec)}`);
  assert.ok(Number(result.in_ms) > 1000 && Number(result.in_ms) <= 1500, `in_ms=${String(result.in_ms)}`);
  assert.equal(daemon.audioStore.get(String(result.id))?.bytes.byteLength, makeWav(2.5).byteLength);
});

test("parseWavDuration は byteRate から長さを出す（16bit mono で 2 倍にならない）", () => {
  // 48kHz / 16bit / mono の 2.5 秒。byteRate は 96000 で sampleRate ではない。
  assert.ok(Math.abs(parseWavDuration(makeWav(2.5)) - 2.5) < 0.001);
  assert.ok(Math.abs(parseWavDuration(makeWav(1, 24_000)) - 1) < 0.001);
  assert.throws(() => parseWavDuration(new Uint8Array(64)), (error: unknown) => error instanceof TtsError);
});

test("h3 audio test は wav が無ければ wav_not_found", () => {
  const { daemon } = makeDaemon();
  assert.throws(
    () => daemon.audioTest(join(daemon.state.stateDir, "missing.wav"), null, 1000),
    (error: unknown) => error instanceof DirectorError && error.code === "wav_not_found",
  );
});

test("status の audio は出どころ・オフセット・未再生件数を返す", async () => {
  const { daemon } = makeDaemon({ audio_source: "tts_direct", audio_offset_ms: -120 });
  stubTts(daemon, 7);
  await daemon.speak({ text: "はい", direction: null, emotion: null, commentId: null });
  const audio = (await daemon.status()).audio as Record<string, unknown>;
  assert.equal(audio.source, "tts_direct");
  assert.equal(audio.offset_ms, -120);
  assert.equal(audio.pending_plays, 1);
  assert.equal(audio.record_director_audio, false);
});

test("wav を返さない TTS でも speak は成功する（直接再生だけ行われない）", async () => {
  const { daemon, director } = makeDaemon({ audio_source: "tts_direct" });
  stubTts(daemon, 5, false);
  const result = await daemon.speak({ text: "はい", direction: null, emotion: null, commentId: null });
  assert.equal(result.ok, true);
  assert.equal(director.plays.length, 0);
});
