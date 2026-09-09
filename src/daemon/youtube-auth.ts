/**
 * YouTube OAuth (installed app / loopback flow).
 *
 * 外部依存なし。Node 24 の fetch / node:http だけで完結する。
 *
 *   1. client_secret.json（Google Cloud で作った「デスクトップアプリ」の OAuth クライアント）を読む
 *   2. 127.0.0.1 の空きポートでローカルサーバーを立て、そこを redirect_uri にする
 *   3. 認可 URL を stdout に出す（ユーザーがブラウザで開く）
 *   4. コードを受け取り、トークンに交換して refresh_token を tokenPath に保存する
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface ClientSecret {
  clientId: string;
  clientSecret: string;
  authUri: string;
  tokenUri: string;
}

export interface StoredToken {
  refresh_token: string;
  access_token?: string;
  /** epoch ms */
  expiry?: number;
  scope?: string;
  token_type?: string;
  client_id?: string;
  obtained_at?: string;
}

interface ClientSecretFile {
  installed?: Record<string, unknown>;
  web?: Record<string, unknown>;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** client_secret.json（installed / web どちらの形でも）を読む。 */
export async function loadClientSecret(clientSecretPath: string): Promise<ClientSecret> {
  let raw: string;
  try {
    raw = await readFile(clientSecretPath, 'utf8');
  } catch (err) {
    throw new Error(
      `client_secret を読めません: ${clientSecretPath} (${(err as Error).message})\n` +
        'docs/youtube-setup.md の手順で OAuth クライアント（デスクトップアプリ）を作成し、JSON を配置してください。',
    );
  }
  const parsed = JSON.parse(raw) as ClientSecretFile;
  const node = parsed.installed ?? parsed.web;
  if (!node) {
    throw new Error(`client_secret の形式が不正です（installed / web が無い）: ${clientSecretPath}`);
  }
  const clientId = asString(node['client_id']);
  const clientSecret = asString(node['client_secret']);
  if (!clientId || !clientSecret) {
    throw new Error(`client_secret に client_id / client_secret がありません: ${clientSecretPath}`);
  }
  return {
    clientId,
    clientSecret,
    authUri: asString(node['auth_uri']) ?? AUTH_ENDPOINT,
    tokenUri: asString(node['token_uri']) ?? TOKEN_ENDPOINT,
  };
}

export async function loadToken(tokenPath: string): Promise<StoredToken> {
  let raw: string;
  try {
    raw = await readFile(tokenPath, 'utf8');
  } catch (err) {
    throw new Error(
      `token を読めません: ${tokenPath} (${(err as Error).message})\n` +
        '`h3 youtube auth` を実行して認可を済ませてください。',
    );
  }
  const token = JSON.parse(raw) as StoredToken;
  if (!asString(token.refresh_token)) {
    throw new Error(`token に refresh_token がありません: ${tokenPath}。\`h3 youtube auth\` をやり直してください。`);
  }
  return token;
}

export async function saveToken(tokenPath: string, token: StoredToken): Promise<void> {
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function postToken(tokenUri: string, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || body.error) {
    throw new Error(
      `token endpoint error (${res.status}): ${body.error ?? 'unknown'} ${body.error_description ?? ''}`.trim(),
    );
  }
  return body;
}

/** refresh token から access token を取り直す。 */
export async function refreshAccessToken(
  secret: ClientSecret,
  refreshToken: string,
): Promise<{ accessToken: string; expiry: number }> {
  const body = await postToken(secret.tokenUri, {
    client_id: secret.clientId,
    client_secret: secret.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const accessToken = asString(body.access_token);
  if (!accessToken) throw new Error('token endpoint が access_token を返しませんでした');
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  return { accessToken, expiry: Date.now() + expiresIn * 1000 };
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>h3-stream</title>
<body style="font-family:system-ui;padding:3rem;background:#0e1117;color:#e6edf3">
<h1>認可が完了しました</h1><p>このタブを閉じて、ターミナルに戻ってください。</p></body>`;

const FAIL_PAGE = `<!doctype html><meta charset="utf-8"><title>h3-stream</title>
<body style="font-family:system-ui;padding:3rem;background:#0e1117;color:#e6edf3">
<h1>認可に失敗しました</h1><p>ターミナルのエラーを確認してください。</p></body>`;

/**
 * ローカルサーバー（127.0.0.1:任意ポート）で認可コードを受け取り、
 * refresh token を tokenPath に保存する。認可 URL は stdout に出す。
 */
export function runOAuthFlow(clientSecretPath: string, tokenPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    void (async () => {
      let secret: ClientSecret;
      try {
        secret = await loadClientSecret(clientSecretPath);
      } catch (err) {
        reject(err as Error);
        return;
      }

      const state = base64url(randomBytes(24));
      const verifier = base64url(randomBytes(48));
      const challenge = base64url(createHash('sha256').update(verifier).digest());

      let settled = false;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        server.close();
        if (err) reject(err);
        else resolve();
      };

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/callback') {
          res.writeHead(404).end('not found');
          return;
        }
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        const gotState = url.searchParams.get('state');

        if (error || !code || gotState !== state) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(FAIL_PAGE);
          finish(new Error(error ? `認可が拒否されました: ${error}` : '認可コードまたは state が不正です'));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DONE_PAGE);

        const port = (server.address() as AddressInfo).port;
        void postToken(secret.tokenUri, {
          client_id: secret.clientId,
          client_secret: secret.clientSecret,
          code,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: `http://127.0.0.1:${port}/callback`,
        })
          .then(async (body) => {
            const refreshToken = asString(body.refresh_token);
            if (!refreshToken) {
              throw new Error(
                'refresh_token が返りませんでした。Google アカウントの「サードパーティ アプリ」から ' +
                  'このアプリのアクセスを解除してから、もう一度実行してください。',
              );
            }
            await saveToken(tokenPath, {
              refresh_token: refreshToken,
              access_token: asString(body.access_token),
              expiry: Date.now() + (body.expires_in ?? 3600) * 1000,
              scope: body.scope,
              token_type: body.token_type,
              client_id: secret.clientId,
              obtained_at: new Date().toISOString(),
            });
            process.stdout.write(`\n[youtube-auth] refresh token を保存しました: ${tokenPath}\n`);
            finish();
          })
          .catch((err: unknown) => finish(err as Error));
      });

      server.on('error', (err) => finish(err));

      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        const authUrl = new URL(secret.authUri);
        authUrl.searchParams.set('client_id', secret.clientId);
        authUrl.searchParams.set('redirect_uri', `http://127.0.0.1:${port}/callback`);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('scope', YOUTUBE_SCOPES.join(' '));
        authUrl.searchParams.set('access_type', 'offline');
        authUrl.searchParams.set('prompt', 'consent');
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('code_challenge', challenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');

        process.stdout.write(
          '\n[youtube-auth] 以下の URL をブラウザで開き、配信に使う Google アカウントで許可してください:\n\n' +
            `${authUrl.toString()}\n\n` +
            `[youtube-auth] 認可後 http://127.0.0.1:${port}/callback に戻ります。待機中...\n`,
        );
      });
    })();
  });
}
