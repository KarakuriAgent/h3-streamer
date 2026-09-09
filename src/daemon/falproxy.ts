import type { Request, RequestHandler, Response } from "express";

export const TARGET_URL_HEADER = "x-fal-target-url";

/**
 * ブラウザから fal へのリクエストを FAL_KEY 付きで中継する。
 *
 * @fal-ai/client の `withProxy`（createFalClient({ proxyUrl }) が内部で使う）は
 * リクエスト URL を proxyUrl に差し替え、元の URL を `x-fal-target-url` に入れて送る。
 * realtime/wma.js の `context.fetch(...)` も同じ経路（config.requestMiddleware）を通るので、
 * `https://wma.fal.run/ice` `/session` `/session/heartbeat` もここを通過する。
 * ブラウザ側の client は credentials を持たないため Authorization はここで初めて付く。
 */
const ALLOWED_HOST_SUFFIXES = [".fal.ai", ".fal.run", ".fal.media"];
const ALLOWED_HOSTS = new Set(["fal.ai", "fal.run", "fal.media"]);

/** クライアントから素通しするヘッダ。認証系は落とす。 */
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "accept-encoding",
  "x-fal-object-lifecycle-preference",
];

const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "x-fal-request-id",
  "cache-control",
];

export function isAllowedFalTarget(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.host.toLowerCase();
  return ALLOWED_HOSTS.has(host) || ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function headerValue(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export interface FalProxyOptions {
  /** FAL_KEY の取得。未設定なら 500 を返す。 */
  credentials: () => string | undefined;
  onError?: (message: string) => void;
}

export function createFalProxyHandler(options: FalProxyOptions): RequestHandler {
  return async (request: Request, response: Response): Promise<void> => {
    const targetUrl = headerValue(request, TARGET_URL_HEADER);
    if (!targetUrl) {
      response.status(400).json({ error: `missing ${TARGET_URL_HEADER} header` });
      return;
    }
    if (!isAllowedFalTarget(targetUrl)) {
      response.status(403).json({ error: `target url is not a fal host: ${targetUrl}` });
      return;
    }
    const key = options.credentials();
    if (!key) {
      response.status(500).json({ error: "FAL_KEY is not set on the daemon" });
      return;
    }

    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = headerValue(request, name);
      if (value) headers.set(name, value);
    }
    headers.set("Authorization", `Key ${key}`);
    headers.set("x-fal-client-proxy", "h3-stream/0.3");

    const method = request.method.toUpperCase();
    // express.raw() が Buffer を置いてくれる。GET/HEAD は本文なし。
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : Buffer.isBuffer(request.body)
          ? new Uint8Array(request.body)
          : typeof request.body === "string"
            ? request.body
            : JSON.stringify(request.body ?? {});

    try {
      const upstream = await fetch(targetUrl, { method, headers, body, redirect: "follow" });
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) response.setHeader(name, value);
      }
      response.status(upstream.status);
      const buffer = Buffer.from(await upstream.arrayBuffer());
      response.end(buffer);
    } catch (error) {
      const message = `fal proxy request failed: ${String(error)}`;
      options.onError?.(message);
      response.status(502).json({ error: message });
    }
  };
}
