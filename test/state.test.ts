import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeSpeakTiming, estimateGenerationLead, round1, StreamState } from "../src/daemon/state.ts";

const NOW = 1_700_000_000_000;

test("キューが空なら on_air は生成先行分だけ後ろになる", () => {
  const timing = computeSpeakTiming(NOW, NOW, 6.8, 4.1);
  assert.equal(timing.duration_sec, 6.8);
  assert.equal(timing.on_air_in_sec, 4.1);
  assert.equal(timing.queue_remaining_sec, 6.8);
  assert.equal(timing.on_air_at_ms, NOW + 4100);
  assert.equal(timing.queue_end_at_ms, NOW + 6800);
});

test("2 発話目は 1 発話目の後ろに積まれる（docs/SPEC.md §5.1 のタイミングモデル）", () => {
  const first = computeSpeakTiming(NOW, NOW, 6.8, 4.1);
  const second = computeSpeakTiming(NOW, first.queue_end_at_ms, 4.6, 4.1);
  assert.equal(second.on_air_in_sec, 10.9); // 6.8 + 4.1
  assert.equal(second.queue_remaining_sec, 11.4); // 6.8 + 4.6
});

test("キュー終端が過去なら残りは 0 として扱う", () => {
  const timing = computeSpeakTiming(NOW, NOW - 30_000, 5, 3);
  assert.equal(timing.on_air_in_sec, 3);
  assert.equal(timing.queue_remaining_sec, 5);
});

test("生成先行分が負でもクランプされる", () => {
  const timing = computeSpeakTiming(NOW, NOW, 5, -2);
  assert.equal(timing.on_air_in_sec, 0);
});

test("時間が進むとキュー残が減り on_air も前に寄る", () => {
  const first = computeSpeakTiming(NOW, NOW, 10, 4);
  const later = computeSpeakTiming(NOW + 6000, first.queue_end_at_ms, 5, 4);
  assert.equal(later.on_air_in_sec, 8); // 残り 4 秒 + 先行 4 秒
  assert.equal(later.queue_remaining_sec, 9);
});

test("generation lead は buffer_depth + チャンク再生尺の EMA になる", () => {
  // 実測の chunk: 生成済みでまだ流れていないのが 1.6 秒、1 チャンクは 8.5 秒ぶん再生に足す。
  // prompt は次のチャンクから効くので、画に出るまでは 1.6 + 8.5 = 10.1 秒。
  const lead = estimateGenerationLead(0, { buffer_depth_seconds: 1.6, playback_seconds: 8.5 }, 8.5);
  assert.equal(lead, round1(10.1 * 0.3));

  let value = 0;
  for (let i = 0; i < 40; i += 1) {
    value = estimateGenerationLead(value, { buffer_depth_seconds: 1.6, playback_seconds: 8.5 }, 8.5);
  }
  assert.ok(Math.abs(value - 10.1) < 0.2, `converged to ${value}`);
});

test("playback_seconds が無ければフォールバックの再生尺を使う", () => {
  const lead = estimateGenerationLead(0, { buffer_depth_seconds: 0 }, 8.5);
  assert.equal(lead, round1(8.5 * 0.3));
});

test("buffer_depth が無ければ 0 とみなす（最初のチャンク）", () => {
  const lead = estimateGenerationLead(0, { playback_seconds: 10.125 }, 8.5);
  assert.equal(lead, round1(10.125 * 0.3));
});

test("壊れた値は前回の推定をそのまま返す", () => {
  const lead = estimateGenerationLead(6, { buffer_depth_seconds: Number.NaN, playback_seconds: 8.5 }, 8.5);
  assert.equal(lead, 6);
});

test("session_info の max_session_seconds が設定値より短ければそちらを使う", () => {
  const state = new StreamState({
    chunkSeconds: 10,
    queueLowSec: 12,
    sessionMaxMin: 15,
    restartWarnMin: 1,
    stateDir: mkdtempSync(join(tmpdir(), "h3-state-")),
  });
  assert.equal(state.sessionMaxSec(), 900);
  // 実測の session_info（PoC）。15 分ではなく 372 秒だった。
  state.onSessionInfo({ type: "session_info", max_session_seconds: 372.466, continuation_playback_seconds: 8.5 });
  assert.equal(state.sessionMaxSec(), 372.466);
  assert.equal(state.chunkPlaybackSec(), 8.5);
});

test("audio_applied の remaining_seconds でキュー残を実測に合わせる", () => {
  const state = new StreamState({
    chunkSeconds: 10,
    queueLowSec: 12,
    sessionMaxMin: 6,
    restartWarnMin: 1,
    stateDir: mkdtempSync(join(tmpdir(), "h3-state-")),
  });
  state.enqueueAudio(6.7);
  state.syncAudioQueue(6.72);
  assert.ok(Math.abs(state.queueRemainingSec() - 6.7) < 0.2, `queue was ${state.queueRemainingSec()}`);
  state.syncAudioQueue(0);
  assert.equal(state.queueRemainingSec(), 0);
});

// ---------- イベントキュー（h3 wait） ----------

function makeState(overrides: Partial<ConstructorParameters<typeof StreamState>[0]> = {}): StreamState {
  return new StreamState({
    chunkSeconds: 10,
    queueLowSec: 12,
    sessionMaxMin: 6,
    restartWarnMin: 1,
    stateDir: mkdtempSync(join(tmpdir(), "h3-state-")),
    ...overrides,
  });
}

test("イベントは一度返したら消える（同じものを返し続けない）", async () => {
  const state = makeState();
  state.pushEvent({ event: "new_comment" });
  assert.equal(state.queuedEventCount(), 1);

  const first = await state.waitForEvent(50);
  assert.equal(first?.event, "new_comment");
  assert.equal(state.queuedEventCount(), 0);

  // 2 回目は何も無いのでタイムアウト（null）。
  assert.equal(await state.waitForEvent(20), null);
});

test("同じ内容の error は 1 回しか積まれない", async () => {
  const state = makeState();
  for (let i = 0; i < 5; i += 1) state.recordError("chat: liveChatMessages (404)");
  assert.equal(state.queuedEventCount(), 1);
  // ログ・errors には全部残る（返り続けるのはイベントだけを止める）。
  assert.equal(state.errors.length, 5);

  const event = await state.waitForEvent(50);
  assert.equal(event?.event, "error");
  assert.equal(await state.waitForEvent(20), null);

  // 別の内容なら積まれる。
  state.recordError("tts: 接続できない");
  assert.equal(state.queuedEventCount(), 1);
});

test("wait の elapsed_sec は待った秒数ではなくデーモン経過秒", async () => {
  const state = makeState();
  // 積んだ時点の値ではなく、返すときに測り直す。
  state.pushEvent({ event: "new_comment", elapsed_sec: 0 });
  const event = await state.waitForEvent(50);
  assert.ok(event !== null);
  assert.equal(event.elapsed_sec, state.elapsedSec());
});

test("queue_low は閾値を下回った瞬間に 1 回だけ積み、上回ってからまた積む", () => {
  const state = makeState({ queueLowSec: 12 });
  const now = Date.now();
  state.enqueueAudio(20, now);

  // まだ閾値以上なので何も出ない。
  state.tick(now);
  assert.equal(state.queuedEventCount(), 0);

  // 閾値を下回った最初の tick で 1 回だけ。
  state.tick(now + 9_000);
  state.tick(now + 10_000);
  state.tick(now + 11_000);
  assert.equal(state.queuedEventCount(), 1);

  // 閾値未満のまま積み増しても（閾値を超えない限り）再発火しない。
  state.enqueueAudio(1, now + 11_000);
  state.tick(now + 12_000);
  assert.equal(state.queuedEventCount(), 1);

  // 閾値を上回ってから下回ればまた積む。
  state.enqueueAudio(30, now + 12_000);
  state.tick(now + 13_000);
  assert.equal(state.queuedEventCount(), 1);
  state.tick(now + 40_000);
  assert.equal(state.queuedEventCount(), 2);
});

// ---------- session_ended ----------

test("endSession は session_ended イベントを 1 回だけ積み、状態を ended にする", async () => {
  const state = makeState();
  state.startSession();
  state.endSession("stream_exhausted");
  state.endSession("stream_exhausted");

  assert.equal(state.sessionState, "ended");
  assert.equal(state.sessionEndedReason, "stream_exhausted");
  assert.equal(state.isSessionEnded(), true);
  assert.equal(state.queuedEventCount(), 1);
  const event = await state.waitForEvent(50);
  assert.equal(event?.event, "session_ended");
  assert.equal(event?.reason, "stream_exhausted");
});

test("chunk が 60 秒来なければ session_ended になる", () => {
  const state = makeState();
  const now = Date.now();
  state.startSession(now);
  state.sessionState = "live";
  state.onChunk({ playback_seconds: 8.5 }, now);

  state.tick(now + 30_000);
  assert.equal(state.sessionState, "live");

  state.tick(now + 61_000);
  assert.equal(state.sessionState, "ended");
  assert.match(String(state.sessionEndedReason), /no chunk/);
});

test("session restart（startSession）で ended から復帰する", () => {
  const state = makeState();
  state.startSession();
  state.endSession("control channel closed");
  state.startSession();
  assert.equal(state.sessionState, "opening");
  assert.equal(state.sessionEndedReason, null);
  assert.equal(state.isSessionEnded(), false);
});

// ---------- セッション上限が短いときの警告 ----------

test("max_session_seconds が設定より大幅に短ければ warnings に出る", () => {
  const state = makeState({ sessionMaxMin: 6 });
  assert.deepEqual(state.warnings(), []);

  // 実測の正常値（372 秒）では警告しない。
  state.onSessionInfo({ type: "session_info", max_session_seconds: 372.466 });
  assert.deepEqual(state.warnings(), []);

  // クレジット不足で短くなった例。
  state.onSessionInfo({ type: "session_info", max_session_seconds: 183 });
  assert.deepEqual(state.warnings(), ["director session limit is 183s (fal credit may be low)"]);
});

test("session_ending の閾値は restart_warn_min と max_session_sec の 30% の小さい方", () => {
  const state = makeState({ sessionMaxMin: 6, restartWarnMin: 1 });
  // 設定どおりなら 60 秒（360 * 0.3 = 108 より小さい）。
  assert.equal(state.sessionEndingThresholdSec(), 60);

  // 上限が 183 秒しかないときは 183 * 0.3 = 54.9 秒。
  state.onSessionInfo({ type: "session_info", max_session_seconds: 183 });
  assert.ok(Math.abs(state.sessionEndingThresholdSec() - 54.9) < 0.001);
});
