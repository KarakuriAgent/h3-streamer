import assert from "node:assert/strict";
import { test } from "node:test";
import {
  amplitudeToDb,
  dbToGain,
  EARLY_IGNORE_SEC,
  OnsetDetector,
  OnsetPlayQueue,
  rms,
  TAIL_SEC,
} from "../web/lib/onset-sync.ts";

/**
 * `audio_sync: director_onset`（SPEC §5.1）の判定ロジック。
 * WebAudio に触らない純粋な部分だけをここで固める。
 */

// ---------- dB / RMS ----------

test("dbToGain は -6dB を約 0.501 にする（リミッター手前のゲイン）", () => {
  assert.ok(Math.abs(dbToGain(-6) - 0.5012) < 0.001, String(dbToGain(-6)));
  assert.equal(dbToGain(0), 1);
});

test("amplitudeToDb は 0 を -Infinity にする（無音でも NaN にしない）", () => {
  assert.equal(amplitudeToDb(0), Number.NEGATIVE_INFINITY);
  assert.ok(Math.abs(amplitudeToDb(1)) < 1e-9);
  assert.ok(Math.abs(amplitudeToDb(0.5) + 6.02) < 0.01);
});

test("rms は二乗平均平方根（空なら 0）", () => {
  assert.equal(rms(new Float32Array(0)), 0);
  assert.equal(rms(new Float32Array([1, -1, 1, -1])), 1);
  assert.ok(Math.abs(rms(new Float32Array([0.5, -0.5])) - 0.5) < 1e-9);
});

// ---------- オンセット検知 ----------

test("直前 300ms が閾値未満 → 超過 の瞬間だけオンセットになる", () => {
  const detector = new OnsetDetector(-40);
  // 無音が続いているあいだは何も起きない。
  assert.equal(detector.push(-60, 0.0), false);
  assert.equal(detector.push(-60, 0.05), false);
  // 立ち上がり。
  assert.equal(detector.push(-20, 0.1), true);
  // 発話の途中は立ち上がりではない（1 発話で 1 回だけ鳴らすため）。
  assert.equal(detector.push(-18, 0.15), false);
  assert.equal(detector.push(-25, 0.2), false);
});

test("静かな時間が 300ms 未満なら次の立ち上がりとみなさない（発話中の一瞬の谷）", () => {
  const detector = new OnsetDetector(-40);
  detector.push(-20, 0.0);
  // 0.2 秒だけ谷になってまた鳴った＝同じ発話の中。
  detector.push(-60, 0.05);
  detector.push(-60, 0.15);
  assert.equal(detector.push(-20, 0.2), false);
  // 0.3 秒以上空いたら別の発話の立ち上がり。
  detector.push(-60, 0.25);
  assert.equal(detector.push(-20, 0.6), true);
});

test("-Infinity（完全な無音）でも閾値を超えたことにならない", () => {
  const detector = new OnsetDetector(-40);
  assert.equal(detector.push(Number.NEGATIVE_INFINITY, 0), false);
  assert.equal(detector.isActive(0), false);
});

test("isActive は直近 300ms にエネルギーがあったか（連続発話の判定）", () => {
  const detector = new OnsetDetector(-40);
  detector.push(-20, 1.0);
  assert.equal(detector.isActive(1.1), true);
  assert.equal(detector.isActive(1.5), false);
});

test("reset で次の音がまたオンセットになる（セッション張り直し）", () => {
  const detector = new OnsetDetector(-40);
  assert.equal(detector.push(-20, 0), true);
  assert.equal(detector.push(-20, 0.05), false);
  detector.reset();
  assert.equal(detector.push(-20, 0.1), true);
});

// ---------- FIFO とフォールバック ----------

const T0 = 1_700_000_000_000;

function makeQueue(fallbackSec = 12): OnsetPlayQueue {
  return new OnsetPlayQueue({ fallbackSec });
}

function item(id: string, atMs: number, durationSec = 5): {
  id: string;
  atMs: number;
  durationSec: number;
  ready: boolean;
} {
  return { id, atMs, durationSec, ready: true };
}

test("オンセットで先頭が 1 本だけ出る（FIFO）", () => {
  const queue = makeQueue();
  queue.push(item("a1", T0));
  queue.push(item("a2", T0 + 6000));

  const first = queue.onOnset(T0);
  assert.equal(first?.item.id, "a1");
  assert.equal(first?.trigger, "onset");
  // まだ a1 が鳴っている最中なので、次のオンセットでは出ない。
  assert.equal(queue.onOnset(T0 + 1000), null);
  assert.equal(queue.pending, 1);
});

test("再生中の残りが 0.3 秒未満になったら次のオンセットで出る", () => {
  const queue = makeQueue();
  queue.push(item("a1", T0, 5));
  queue.push(item("a2", T0 + 5000, 5));
  queue.onOnset(T0);

  // 残り 0.5 秒ではまだ出ない。
  assert.equal(queue.onOnset(T0 + 4500), null);
  // 残り 0.2 秒（TAIL_SEC 未満）なら出る。
  const next = queue.onOnset(T0 + 5000 - TAIL_SEC * 1000 + 100);
  assert.equal(next?.item.id, "a2");
});

test("デコードが終わっていない先頭は出さない（発話の順番が入れ替わらない）", () => {
  const queue = makeQueue();
  queue.push({ id: "a1", atMs: T0, durationSec: 5, ready: false });
  queue.push(item("a2", T0 + 100));
  assert.equal(queue.onOnset(T0), null, "先頭が未デコードなら 2 本目を先に鳴らさない");
  queue.markReady("a1", 4.2);
  const decision = queue.onOnset(T0 + 50);
  assert.equal(decision?.item.id, "a1");
  assert.equal(decision?.item.durationSec, 4.2, "長さはデコード実測で置き換える");
});

test("at_ms より 3 秒以上早いオンセットは無視する（前の発話の続き・ノイズ）", () => {
  const queue = makeQueue();
  queue.push(item("a1", T0 + 10_000));
  assert.equal(queue.onOnset(T0), null);
  assert.equal(queue.onOnset(T0 + 6000), null);
  // 3 秒前まで来たら受け付ける。
  const decision = queue.onOnset(T0 + 10_000 - EARLY_IGNORE_SEC * 1000 + 1);
  assert.equal(decision?.item.id, "a1");
});

test("オンセットが来なくても at_ms + onset_fallback_sec を過ぎたら鳴らす", () => {
  const queue = makeQueue(12);
  queue.push(item("a1", T0));
  // 締切前は何も起きない（Director 音声も無音）。
  assert.equal(queue.tick(T0 + 11_000, false), null);
  const decision = queue.tick(T0 + 12_001, false);
  assert.equal(decision?.item.id, "a1");
  assert.equal(decision?.trigger, "fallback");
});

test("フォールバックでも再生中の TTS には割り込まない", () => {
  const queue = makeQueue(1);
  queue.push(item("a1", T0, 10));
  queue.push(item("a2", T0, 5));
  queue.onOnset(T0);
  // a1 を鳴らしている最中は、a2 の締切を過ぎても出さない。
  assert.equal(queue.tick(T0 + 5000, false), null);
  const decision = queue.tick(T0 + 10_000, false);
  assert.equal(decision?.item.id, "a2");
  assert.equal(decision?.trigger, "fallback");
});

test("切れ目なく続く発話は、オンセットが無くてもエネルギーの継続で次を鳴らす", () => {
  const queue = makeQueue(12);
  queue.push(item("a1", T0, 5));
  queue.push(item("a2", T0 + 5000, 5));
  queue.onOnset(T0);
  // 前の再生の終わり際に Director 音声が続いている＝そのまま次の発話に入っている。
  const decision = queue.tick(T0 + 4900, true);
  assert.equal(decision?.item.id, "a2");
  assert.equal(decision?.trigger, "onset");
});

test("何も鳴らしていないうちは、エネルギーが続いているだけでは鳴らさない", () => {
  const queue = makeQueue(12);
  queue.push(item("a1", T0));
  // 最初の 1 本は必ずオンセット（またはフォールバック）で鳴らす。
  assert.equal(queue.tick(T0, true), null);
  assert.equal(queue.onOnset(T0)?.item.id, "a1");
});

test("同じ id の push は順番を変えずに at_ms を上書きする（audio_applied の撃ち直し）", () => {
  const queue = makeQueue();
  queue.push(item("a1", T0 + 10_000));
  queue.push(item("a2", T0 + 20_000));
  queue.push(item("a1", T0)); // 撃ち直し
  assert.equal(queue.pending, 2);
  assert.deepEqual(
    queue.queued.map((entry) => entry.id),
    ["a1", "a2"],
  );
  assert.equal(queue.onOnset(T0)?.item.id, "a1", "上書きされた at_ms で早く鳴らせる");
});

test("cancel でキューを空にする（reset / session restart）", () => {
  const queue = makeQueue();
  queue.push(item("a1", T0));
  queue.push(item("a2", T0));
  assert.equal(queue.cancel(), 2);
  assert.equal(queue.pending, 0);
  assert.equal(queue.onOnset(T0), null);
  // 再生中の扱いも消えるので、次に積んだものは普通にオンセットで鳴る。
  queue.push(item("a3", T0));
  assert.equal(queue.onOnset(T0)?.item.id, "a3");
});

test("cancel(id) は 1 本だけ捨てる", () => {
  const queue = makeQueue();
  queue.push(item("a1", T0));
  queue.push(item("a2", T0));
  assert.equal(queue.cancel("a1"), 1);
  assert.equal(queue.onOnset(T0)?.item.id, "a2");
});
