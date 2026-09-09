import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { createFalClient, type FalClient } from "@fal-ai/client";

let client: FalClient | null = null;

export function hasFalKey(): boolean {
  return typeof process.env.FAL_KEY === "string" && process.env.FAL_KEY.length > 0;
}

/**
 * Node 側の fal クライアント。FAL_KEY を直接使う（ブラウザには渡さない）。
 * ブラウザ側は `/api/fal/proxy` 経由で、鍵はデーモンから出ない。
 */
export function falClient(): FalClient {
  if (!hasFalKey()) {
    throw new Error("FAL_KEY is not set (see .env.example)");
  }
  client ??= createFalClient({ credentials: () => process.env.FAL_KEY });
  return client;
}

/** ローカルファイルを fal storage に上げて URL を返す。 */
export async function uploadFile(path: string, contentType: string): Promise<string> {
  const bytes = await readFile(path);
  return uploadBuffer(bytes, basename(path), contentType);
}

export async function uploadBuffer(
  bytes: Uint8Array,
  filename: string,
  contentType: string,
): Promise<string> {
  const file = new File([new Uint8Array(bytes)], filename, { type: contentType });
  return falClient().storage.upload(file);
}
