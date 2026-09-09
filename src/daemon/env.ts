import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.ts";

/**
 * `.env` の読み込み。
 *
 * デーモンも CLI も秘密は環境変数（`FAL_KEY` / `RTMP_KEY` / `RTMP_URL`）から取るが、
 * README は `.env` に書く手順になっている。シェルで export していなくても動くよう、
 * 起動時に一度だけ `.env` を読んで **未設定のものだけ** `process.env` に入れる。
 * 既に環境変数がある場合はそちらを優先する（一時的な上書きを潰さない）。
 */
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

let cache: Record<string, string> | null = null;

/** `.env` を素朴にパースする（`KEY=VALUE`、`#` 始まりはコメント）。 */
export function readEnvFile(path = join(ROOT, ".env")): Record<string, string> {
  if (cache) return cache;
  const out: Record<string, string> = {};
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (/^\s*#/.test(line)) continue;
      const match = LINE.exec(line);
      if (!match?.[1] || match[2] === undefined) continue;
      out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  cache = out;
  return out;
}

/** `.env` の値のうち、まだ環境変数に無いものを `process.env` へ入れる。入れたキー名を返す。 */
export function applyEnvFile(path?: string): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(readEnvFile(path))) {
    if (value.length === 0) continue;
    if (process.env[key] !== undefined && process.env[key] !== "") continue;
    process.env[key] = value;
    applied.push(key);
  }
  return applied;
}

/** テスト用。次の `readEnvFile` でファイルを読み直させる。 */
export function resetEnvFileCache(): void {
  cache = null;
}
