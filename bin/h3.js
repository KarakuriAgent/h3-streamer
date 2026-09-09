#!/usr/bin/env node
// h3 CLI のエントリ。TypeScript のまま tsx のローダで実行する。
import { register } from "tsx/esm/api";

const unregister = register();
try {
  await import("../src/cli/index.ts");
} finally {
  await unregister();
}
