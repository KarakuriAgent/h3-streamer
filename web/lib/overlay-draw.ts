import type { OverlayComment, OverlayState } from "../../src/shared/protocol.ts";

/**
 * オーバーレイ（コメント一覧・強調・字幕）を canvas に描く。
 *
 * 見た目は `overlay/index.html`（OBS ブラウザソース用の DOM 版）を踏襲する：
 * 右上からコメントを積み、強調中のものを青くし、下部中央に字幕を出す。
 * 寸法は 1280x720 を基準に書き、実際の canvas 幅に合わせて拡大縮小する。
 */

const BASE_WIDTH = 1280;

const LAYOUT = {
  panelRight: 24,
  panelTop: 24,
  panelWidth: 380,
  panelMaxHeightRatio: 0.7,
  itemGap: 8,
  itemPaddingX: 12,
  itemPaddingY: 8,
  itemRadius: 8,
  accentWidth: 3,
  authorFontSize: 13,
  authorLineHeight: 19,
  textFontSize: 17,
  textLineHeight: 25,
  subtitleBottom: 56,
  subtitleFontSize: 34,
  subtitleLineHeight: 46,
  subtitleMaxWidthRatio: 0.78,
  subtitlePaddingX: 26,
  subtitlePaddingY: 10,
  subtitleRadius: 12,
  /** 強調中のコメントは DOM 版の `transform: scale(1.03)` に相当する分だけ左に広げる。 */
  highlightGrow: 6,
} as const;

const COLORS = {
  itemBackground: "rgba(6, 12, 24, 0.62)",
  itemAccent: "rgba(120, 190, 255, 0.5)",
  itemText: "#eef4ff",
  highlightBackground: "rgba(24, 84, 168, 0.85)",
  highlightAccent: "#8fd6ff",
  author: "#8fd6ff",
  subtitleBackground: "rgba(4, 10, 22, 0.6)",
  subtitleText: "#ffffff",
  shadow: "rgba(0, 0, 0, 0.75)",
} as const;

const FONT_STACK = '"Noto Sans JP", "Noto Sans CJK JP", system-ui, sans-serif';

/** 字幕のフェード（DOM 版の `transition: opacity 200ms`）。 */
const SUBTITLE_FADE_MS = 200;

interface WrappedComment {
  comment: OverlayComment;
  authorLines: string[];
  textLines: string[];
  height: number;
}

export class OverlayRenderer {
  /** 字幕の表示率。0→1 に補間してフェードさせる。 */
  private subtitleAlpha = 0;
  private lastSubtitle: string | null = null;

  /**
   * @param state 直近のオーバーレイ状態
   * @param deltaMs 前フレームからの経過ミリ秒（フェード用）
   */
  draw(
    context: CanvasRenderingContext2D,
    state: OverlayState,
    width: number,
    height: number,
    deltaMs: number,
  ): void {
    const scale = width / BASE_WIDTH;
    this.advanceSubtitleFade(state.subtitle, deltaMs);

    context.save();
    context.textBaseline = "top";
    if (state.commentsVisible) this.drawComments(context, state, width, height, scale);
    this.drawSubtitle(context, state.subtitle ?? this.lastSubtitle, width, height, scale);
    context.restore();
  }

  private advanceSubtitleFade(subtitle: string | null, deltaMs: number): void {
    const step = SUBTITLE_FADE_MS > 0 ? deltaMs / SUBTITLE_FADE_MS : 1;
    if (subtitle !== null) {
      this.lastSubtitle = subtitle;
      this.subtitleAlpha = Math.min(1, this.subtitleAlpha + step);
      return;
    }
    this.subtitleAlpha = Math.max(0, this.subtitleAlpha - step);
    // 完全に消えてからテキストを捨てる（消える途中も前の文字を出しておく）。
    if (this.subtitleAlpha === 0) this.lastSubtitle = null;
  }

  private drawComments(
    context: CanvasRenderingContext2D,
    state: OverlayState,
    width: number,
    height: number,
    scale: number,
  ): void {
    const panelWidth = LAYOUT.panelWidth * scale;
    const left = width - LAYOUT.panelRight * scale - panelWidth;
    const top = LAYOUT.panelTop * scale;
    const maxHeight = height * LAYOUT.panelMaxHeightRatio;
    const gap = LAYOUT.itemGap * scale;

    let y = top;
    for (const comment of state.comments) {
      const item = this.measure(context, comment, panelWidth, scale);
      if (y + item.height > top + maxHeight) break;
      this.drawComment(context, item, left, y, panelWidth, scale, comment.id === state.highlight);
      y += item.height + gap;
    }
  }

  private measure(
    context: CanvasRenderingContext2D,
    comment: OverlayComment,
    panelWidth: number,
    scale: number,
  ): WrappedComment {
    const inner = panelWidth - (LAYOUT.itemPaddingX * 2 + LAYOUT.accentWidth) * scale;

    context.font = `700 ${LAYOUT.authorFontSize * scale}px ${FONT_STACK}`;
    const authorLines = wrapText(context, comment.author, inner).slice(0, 1);

    context.font = `400 ${LAYOUT.textFontSize * scale}px ${FONT_STACK}`;
    const textLines = wrapText(context, comment.text, inner).slice(0, 4);

    const height =
      LAYOUT.itemPaddingY * 2 * scale +
      authorLines.length * LAYOUT.authorLineHeight * scale +
      textLines.length * LAYOUT.textLineHeight * scale;
    return { comment, authorLines, textLines, height };
  }

  private drawComment(
    context: CanvasRenderingContext2D,
    item: WrappedComment,
    x: number,
    y: number,
    panelWidth: number,
    scale: number,
    highlighted: boolean,
  ): void {
    const grow = highlighted ? LAYOUT.highlightGrow * scale : 0;
    const boxX = x - grow;
    const boxWidth = panelWidth + grow;
    const radius = LAYOUT.itemRadius * scale;

    context.save();
    if (highlighted) {
      context.shadowColor = "rgba(0, 0, 0, 0.45)";
      context.shadowBlur = 24 * scale;
      context.shadowOffsetY = 6 * scale;
    }
    context.fillStyle = highlighted ? COLORS.highlightBackground : COLORS.itemBackground;
    context.beginPath();
    context.roundRect(boxX, y, boxWidth, item.height, radius);
    context.fill();
    context.restore();

    // 左端のアクセントバー（DOM 版の border-left）。
    context.fillStyle = highlighted ? COLORS.highlightAccent : COLORS.itemAccent;
    context.beginPath();
    context.roundRect(boxX, y, LAYOUT.accentWidth * scale, item.height, [radius, 0, 0, radius]);
    context.fill();

    const textX = boxX + (LAYOUT.accentWidth + LAYOUT.itemPaddingX) * scale;
    let textY = y + LAYOUT.itemPaddingY * scale;

    context.save();
    context.shadowColor = COLORS.shadow;
    context.shadowBlur = 3 * scale;
    context.shadowOffsetY = 1 * scale;

    context.font = `700 ${LAYOUT.authorFontSize * scale}px ${FONT_STACK}`;
    context.fillStyle = COLORS.author;
    for (const line of item.authorLines) {
      context.fillText(line, textX, textY);
      textY += LAYOUT.authorLineHeight * scale;
    }

    context.font = `400 ${LAYOUT.textFontSize * scale}px ${FONT_STACK}`;
    context.fillStyle = COLORS.itemText;
    for (const line of item.textLines) {
      context.fillText(line, textX, textY);
      textY += LAYOUT.textLineHeight * scale;
    }
    context.restore();
  }

  private drawSubtitle(
    context: CanvasRenderingContext2D,
    subtitle: string | null,
    width: number,
    height: number,
    scale: number,
  ): void {
    if (!subtitle || this.subtitleAlpha <= 0) return;

    context.save();
    context.globalAlpha = this.subtitleAlpha;
    context.font = `700 ${LAYOUT.subtitleFontSize * scale}px ${FONT_STACK}`;
    context.textAlign = "center";

    const maxTextWidth = width * LAYOUT.subtitleMaxWidthRatio - LAYOUT.subtitlePaddingX * 2 * scale;
    const lines = wrapText(context, subtitle, maxTextWidth).slice(0, 3);
    const lineHeight = LAYOUT.subtitleLineHeight * scale;
    const boxHeight = lines.length * lineHeight + LAYOUT.subtitlePaddingY * 2 * scale;
    const textWidth = Math.max(...lines.map((line) => context.measureText(line).width));
    const boxWidth = textWidth + LAYOUT.subtitlePaddingX * 2 * scale;
    const centerX = width / 2;
    const boxY = height - LAYOUT.subtitleBottom * scale - boxHeight;

    context.fillStyle = COLORS.subtitleBackground;
    context.beginPath();
    context.roundRect(centerX - boxWidth / 2, boxY, boxWidth, boxHeight, LAYOUT.subtitleRadius * scale);
    context.fill();

    context.shadowColor = COLORS.shadow;
    context.shadowBlur = 6 * scale;
    context.shadowOffsetY = 2 * scale;
    context.fillStyle = COLORS.subtitleText;
    let y = boxY + LAYOUT.subtitlePaddingY * scale;
    for (const line of lines) {
      context.fillText(line, centerX, y);
      y += lineHeight;
    }
    context.restore();
  }
}

/**
 * 幅に収まるように折り返す。
 *
 * 日本語には単語境界が無いので、空白で切れなければ 1 文字ずつ詰める。
 * `context.font` は呼び出し側で設定しておくこと。
 */
export function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const char of paragraph) {
      const candidate = current + char;
      if (current !== "" && context.measureText(candidate).width > maxWidth) {
        lines.push(current);
        current = char === " " ? "" : char;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines.filter((line, index) => line !== "" || index === 0);
}
