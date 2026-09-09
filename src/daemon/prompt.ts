import type { VisualConfig } from "./config.ts";

/**
 * SPEC §3.1 の映像プロンプト組み立て。
 *
 *   [IDENTITY]  visual.yaml: identity     外見の不変条件。毎回全文
 *   [FRAME]     visual.yaml: frame_rules  画面内担保の不変条件。毎回全文
 *   [STYLE]     visual.yaml: style        画風
 *   [DIRECTION] --direction               エージェントの自由記述
 *   [SPEECH]    She says: "<--text>"      speak のときのみ
 *
 * 不変条件（identity / frame_rules / style）はデーモンが必ず付ける。
 */
export type PromptSectionName = "IDENTITY" | "FRAME" | "STYLE" | "SCENE" | "DIRECTION" | "SPEECH";

export interface PromptSection {
  name: PromptSectionName;
  text: string;
}

/** 改行・連続空白を 1 スペースに畳む（YAML の折り返しをそのまま送らない）。 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface BuildPromptInput {
  visual: VisualConfig;
  /** --direction。省略可。 */
  direction?: string | null;
  /** --text。speak のときのみ。 */
  speech?: string | null;
  /** configure のときだけ default_scene を含める。 */
  includeScene?: boolean;
}

/** セクションの配列を返す（順序が仕様。テスト用に公開する）。 */
export function buildPromptSections(input: BuildPromptInput): PromptSection[] {
  const sections: PromptSection[] = [];
  const push = (name: PromptSectionName, text: string | null | undefined) => {
    const normalized = normalizeText(text ?? "");
    if (normalized.length > 0) sections.push({ name, text: normalized });
  };

  push("IDENTITY", input.visual.identity);
  push("FRAME", input.visual.frame_rules);
  push("STYLE", input.visual.style);
  if (input.includeScene) push("SCENE", input.visual.default_scene);
  push("DIRECTION", input.direction);
  if (input.speech && normalizeText(input.speech).length > 0) {
    push("SPEECH", `She says: "${normalizeText(input.speech)}"`);
  }
  return sections;
}

/** Director に送る 1 本のプロンプト文字列。 */
export function buildPrompt(input: BuildPromptInput): string {
  return buildPromptSections(input)
    .map((section) => section.text)
    .join(" ");
}

/** configure 用（default_scene 込み、direction は待機の一文）。 */
export function buildConfigurePrompt(visual: VisualConfig, openingDirection?: string): string {
  return buildPrompt({
    visual,
    includeScene: true,
    direction:
      openingDirection ?? "She is sitting quietly, smiling softly at the camera, waiting to start.",
  });
}

export interface DirectionCheck {
  ok: boolean;
  /** 当たった禁止語（元の綴りのまま）。 */
  hits: string[];
  /** 禁止語に当たったときの説明。当たっていなければ null。 */
  message: string | null;
}

/** `--direction` が禁止語に当たったときに投げる（API は 422 で返す）。 */
export class DirectionBlockedError extends Error {
  readonly code = "direction_blocked";
  readonly hits: string[];
  constructor(hits: string[], message: string) {
    super(message);
    this.name = "DirectionBlockedError";
    this.hits = hits;
  }
}

/**
 * `--direction` の簡易チェック（SPEC §3.1）。
 * 禁止語（`config/stream.yaml: direction_blocklist`）に当たったら **送信しない**。
 */
export function checkDirection(direction: string | null | undefined, blocklist: string[]): DirectionCheck {
  const text = (direction ?? "").toLowerCase();
  const hits = blocklist.filter((word) => {
    const needle = word.trim().toLowerCase();
    return needle.length > 0 && text.includes(needle);
  });
  return {
    ok: hits.length === 0,
    hits,
    message:
      hits.length === 0
        ? null
        : `direction に禁止語が含まれるので送信しない（identity / frame_rules に反する）: ${hits.join(", ")}。` +
          "キャラ本人（髪・帽子・眼鏡・ヘッドホン・服・顔）を変える、画面外に出る、別人物を出す、" +
          "画面に文字を出す演出は書けない。direction を書き直すか h3 comments skip で捨てる。",
  };
}

/** 禁止語に当たっていたら投げる。speak / direct は送信前にこれを通す。 */
export function assertDirection(direction: string | null | undefined, blocklist: string[]): void {
  const check = checkDirection(direction, blocklist);
  if (!check.ok) throw new DirectionBlockedError(check.hits, check.message ?? "direction blocked");
}
