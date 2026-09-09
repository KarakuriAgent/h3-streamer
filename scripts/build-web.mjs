// ブラウザ用バンドル。web/*.ts を overlay/*.js に出す（overlay/*.html が読む）。
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [
    join(root, "web", "viewer.ts"),
    join(root, "web", "overlay.ts"),
    join(root, "web", "compositor.ts"),
  ],
  outdir: join(root, "overlay"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120", "firefox121", "safari17"],
  sourcemap: true,
  logLevel: "info",
});
