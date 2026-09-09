import assert from "node:assert/strict";
import { test } from "node:test";
import { loadStreamConfig, type VisualConfig } from "../src/daemon/config.ts";
import {
  assertDirection,
  buildConfigurePrompt,
  buildPrompt,
  buildPromptSections,
  checkDirection,
  DirectionBlockedError,
  normalizeText,
} from "../src/daemon/prompt.ts";

const visual: VisualConfig = {
  identity: "An anime-style young woman,\n  Kanon, with two braids.",
  frame_rules: "She must stay fully inside the frame.",
  style: "Clean anime illustration style.",
  default_scene: "A futuristic streaming room.",
};

test("YAML の折り返しは 1 スペースに畳まれる", () => {
  assert.equal(normalizeText("a\n  b\t c "), "a b c");
});

test("prompt のセクション順は IDENTITY → FRAME → STYLE → DIRECTION → SPEECH", () => {
  const sections = buildPromptSections({
    visual,
    direction: "She waves at the camera.",
    speech: "こんにちは！",
  });
  assert.deepEqual(sections.map((s) => s.name), ["IDENTITY", "FRAME", "STYLE", "DIRECTION", "SPEECH"]);
  assert.equal(sections.at(-1)?.text, 'She says: "こんにちは！"');
});

test("default_scene は configure のときだけ入る", () => {
  const speak = buildPromptSections({ visual, direction: "She smiles." });
  assert.ok(!speak.some((s) => s.name === "SCENE"));
  const configure = buildPromptSections({ visual, includeScene: true, direction: "She smiles." });
  assert.deepEqual(configure.map((s) => s.name), ["IDENTITY", "FRAME", "STYLE", "SCENE", "DIRECTION"]);
});

test("不変条件は direction や speech が無くても必ず入る", () => {
  const prompt = buildPrompt({ visual });
  assert.ok(prompt.includes("Kanon"));
  assert.ok(prompt.includes("fully inside the frame"));
  assert.ok(prompt.includes("Clean anime illustration style."));
  assert.ok(!prompt.includes("She says"));
});

test("configure プロンプトは既定の待機演出を含む", () => {
  const prompt = buildConfigurePrompt(visual);
  assert.ok(prompt.includes("A futuristic streaming room."));
  assert.ok(prompt.includes("waiting to start"));
  assert.ok(buildConfigurePrompt(visual, "She stands up.").includes("She stands up."));
});

test("空セクションは落ちる", () => {
  const sections = buildPromptSections({
    visual: { ...visual, style: "   " },
    direction: "",
    speech: "  ",
  });
  assert.deepEqual(sections.map((s) => s.name), ["IDENTITY", "FRAME"]);
});

test("direction_blocklist に当たったら ok:false（大文字小文字は無視）", () => {
  const result = checkDirection("She walks Away and goes Out Of Frame.", ["out of frame", "she walks away"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.hits.sort(), ["out of frame", "she walks away"]);
  assert.match(result.message ?? "", /out of frame/);
});

test("問題ない direction は ok", () => {
  const result = checkDirection("A cat walks across the desk.", ["out of frame", "another character"]);
  assert.equal(result.ok, true);
  assert.equal(result.message, null);
  assert.deepEqual(result.hits, []);
});

test("direction が無い（direct なし speak）ならチェックは通る", () => {
  assert.equal(checkDirection(null, ["out of frame"]).ok, true);
});

test("assertDirection は禁止語で DirectionBlockedError を投げる", () => {
  assert.doesNotThrow(() => assertDirection("A cat hops onto the desk.", ["out of frame"]));
  assert.throws(
    () => assertDirection("She walks away from the desk.", ["she walks away"]),
    (error: unknown) =>
      error instanceof DirectionBlockedError &&
      error.code === "direction_blocked" &&
      error.hits.length === 1 &&
      error.hits[0] === "she walks away",
  );
});

test("既定の direction_blocklist は SPEC §3.1 の 4 分類を弾く", () => {
  const blocklist = loadStreamConfig().direction_blocklist;
  const blocked = [
    "She walks away from the desk.",             // 画面外に出る
    "Her friend, another person, sits beside her.", // 別人物
    "Large text on screen shows the topic.",     // 画面表示
    "She takes off her cap and smiles.",         // キャラ本人（帽子）
    "She changes her outfit to a red dress.",    // キャラ本人（服）
    "Her hair color shifts to pink.",            // キャラ本人（髪）
    "She removes her glasses and laughs.",       // キャラ本人（眼鏡）
  ];
  for (const direction of blocked) {
    assert.equal(checkDirection(direction, blocklist).ok, false, direction);
  }

  // 通ってほしい演出（誤爆しないこと）。
  const allowed = [
    "A small tabby cat hops onto the desk and walks across the keyboard.",
    "The room dissolves into a vast sunlit grassland; the crops ripple in the wind.",
    "Behind her, a large holographic '0235' logo materializes and slowly rotates.",
    "Rain starts falling indoors in soft glowing droplets; she holds out one hand.",
    "Stars twinkle in the window behind her as she leans back and laughs.",
  ];
  for (const direction of allowed) {
    const result = checkDirection(direction, blocklist);
    assert.equal(result.ok, true, `${direction} -> ${result.hits.join(", ")}`);
  }
});
