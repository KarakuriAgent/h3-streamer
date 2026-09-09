/**
 * YouTube Live Chat ポーラー。
 *
 * 外部依存なし（googleapis を使わず fetch で YouTube Data API v3 を直接叩く）。
 *
 * 認証は 2 方式（config/youtube.yaml の `auth`）。
 *
 * api_key（既定・簡単）: .env の YOUTUBE_API_KEY を `key=` に付けて叩く。
 *   `mine=true` 系が使えないので broadcast_id（配信ページ URL の v= の値）が必須。
 *   videos.list(id=broadcast_id) → liveStreamingDetails.activeLiveChatId
 *   videos.list の snippet.channelId を「配信者自身」の判定に使う
 *
 * oauth: client_secret.json + refresh token で access token を取り、Bearer で叩く。
 *   liveBroadcasts.list(mine=true) → liveChatId
 *   channels.list(mine=true)       → 自分のチャンネル ID
 *
 * 共通:
 *   liveChatMessages.list → コメント（pollingIntervalMillis に従いポーリング、pageToken 継続）
 *   videos.list           → liveStreamingDetails.concurrentViewers（視聴者数）
 *
 * 除外ルール（SPEC §7）：NG ワード / URL のみ / 同一ユーザーの連投（直近 3 件以内）。
 * 配信者本人のコメントは `include_owner_comments: false` のときだけ除外する（既定は拾う）。
 * 除外したコメントは onComment に渡さない。
 * 使用済みコメント ID の管理は daemon 側（state/used_comments.json）の責務でここでは扱わない。
 */

import {
  loadClientSecret,
  loadToken,
  refreshAccessToken,
  saveToken,
  type ClientSecret,
  type StoredToken,
} from './youtube-auth.ts';

const API_BASE = 'https://www.googleapis.com/youtube/v3';

/** 直近この件数以内に同じユーザーのコメントがあれば連投として除外する。 */
const REPEAT_AUTHOR_WINDOW = 3;

const DEFAULT_POLL_INTERVAL_MS = 5000;
const MIN_POLL_INTERVAL_MS = 1000;
const MAX_POLL_INTERVAL_MS = 30000;

/**
 * ライブチャットがまだ開いていない（配信枠が upcoming / 404）ときの再確認間隔。
 * 致命的扱いにせず、この間隔で activeLiveChatId を取り直しながら待ち続ける。
 */
const WAITING_RETRY_MIN_MS = 10_000;
const WAITING_RETRY_MAX_MS = 15_000;

/** 指数バックオフ（ミリ秒）。 */
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60000;
const BACKOFF_MAX_ATTEMPTS = 8;

export interface ChatComment {
  id: string;
  author: string;
  authorChannelId: string;
  text: string;
  publishedAt: string;
}

export type ChatAuthMode = 'api_key' | 'oauth';

export interface ChatPollerOptions {
  /** 認証方式。省略時は 'oauth'（既存の呼び出しを壊さないため）。 */
  auth?: ChatAuthMode;
  /** auth='api_key' のときに使う YouTube Data API v3 の API キー。 */
  apiKey?: string;
  /** auth='oauth' のとき必須。Google Cloud の OAuth クライアント JSON（デスクトップアプリ）のパス。 */
  clientSecretPath?: string;
  /** auth='oauth' のとき必須。`h3 youtube auth` が保存した refresh token JSON のパス。 */
  tokenPath?: string;
  /**
   * 動画 ID。auth='api_key' では必須（mine=true が使えないため）。
   * 配信ページの URL（watch?v= / live/ / youtu.be/ 形式）を丸ごと渡してもよい（ID を抽出する）。
   * auth='oauth' で省略した場合は liveBroadcasts.list(mine=true) から active → upcoming の順で選ぶ。
   */
  broadcastId?: string;
  /** ポーリング間隔の下限。API の pollingIntervalMillis がこれより大きければそちらに従う。 */
  pollIntervalMs?: number;
  /** NG ワード（部分一致・大文字小文字を無視）。 */
  ngWords: string[];
  /**
   * 配信者本人（配信枠のチャンネル）のコメントを拾うか。既定 true。
   * false のときだけ従来どおり除外する。
   */
  includeOwnerComments?: boolean;
  /**
   * ライブチャットがまだ開いていないときの再確認間隔（ミリ秒）。
   * 省略時は 10〜15 秒のランダム。テストで短縮するためだけの設定。
   */
  waitingRetryMs?: number;
}

/** ロガー（daemon 側の logger を差し込めるように最小限のインターフェースにしておく）。 */
export interface ChatLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const defaultLogger: ChatLogger = {
  info: (m) => console.error(`[chat] ${m}`),
  warn: (m) => console.error(`[chat][warn] ${m}`),
  error: (m) => console.error(`[chat][error] ${m}`),
};

/** API が返したエラー（ステータスと reason を保持する）。 */
class YouTubeApiError extends Error {
  readonly status: number;
  readonly reason: string;
  /** true ならリトライせずに停止する（reason / status による判定を上書きする）。 */
  readonly fatal: boolean;

  constructor(status: number, reason: string, message: string, fatal = false) {
    super(message);
    this.name = 'YouTubeApiError';
    this.status = status;
    this.reason = reason;
    this.fatal = fatal;
  }
}

/** これらが返ったらリトライしても回復しない。ログを出してポーリングを止める。 */
const FATAL_REASONS = new Set([
  'liveChatEnded',
  'liveChatRemoved',
  'forbidden',
  'insufficientPermissions',
  'authError',
]);

/**
 * 「チャットがまだ無い / まだ開いていない」だけで、待てば回復するもの。
 *
 * 配信枠が `upcoming` の間は `liveChatMessages.list` が 404（`liveChatNotFound`）を返す。
 * 初回の本番配信ではこれを致命的として扱ってしまい、配信が `live` になっても
 * コメントを取りに行かなかった。ここに入る理由は待機状態にして再解決を続ける。
 */
const WAITING_REASONS = new Set([
  'liveChatNotFound',
  'liveChatDisabled',
  'liveBroadcastNotFound',
  'videoNotFound',
  'notFound',
]);

/** ポーラーの状態。`h3 status` の `youtube.chat_state` に出す。 */
export type ChatState = 'waiting' | 'polling' | 'stopped';

interface ApiErrorBody {
  error?: {
    code?: number;
    message?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
}

interface LiveChatMessageItem {
  id?: string;
  snippet?: {
    type?: string;
    publishedAt?: string;
    displayMessage?: string;
    textMessageDetails?: { messageText?: string };
  };
  authorDetails?: {
    channelId?: string;
    displayName?: string;
  };
}

interface LiveChatMessageListResponse {
  items?: LiveChatMessageItem[];
  nextPageToken?: string;
  pollingIntervalMillis?: number;
  offlineAt?: string;
}

interface LiveBroadcastItem {
  id?: string;
  status?: { lifeCycleStatus?: string };
  snippet?: { liveChatId?: string; title?: string; scheduledStartTime?: string };
}

interface LiveBroadcastListResponse {
  items?: LiveBroadcastItem[];
}

interface ChannelListResponse {
  items?: Array<{ id?: string }>;
}

interface VideoListResponse {
  items?: Array<{
    id?: string;
    snippet?: { channelId?: string; title?: string };
    liveStreamingDetails?: { concurrentViewers?: string; activeLiveChatId?: string };
  }>;
}

const URL_PATTERN = 'https?:\\/\\/\\S+|www\\.\\S+';

/** URL を取り除いた残りが実質空なら「URL のみ」。 */
export function isUrlOnly(text: string): boolean {
  if (!new RegExp(URL_PATTERN, 'i').test(text)) return false;
  const stripped = text.replace(new RegExp(URL_PATTERN, 'gi'), ' ').replace(/[\s\p{P}\p{S}]/gu, '');
  return stripped.length === 0;
}

export function containsNgWord(text: string, ngWords: readonly string[]): string | null {
  const lower = text.toLowerCase();
  for (const w of ngWords) {
    const word = w.trim();
    if (word.length > 0 && lower.includes(word.toLowerCase())) return word;
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 動画 ID を取り出す。設定に配信ページの URL がそのまま貼られていても動くようにする。
 *
 *   https://www.youtube.com/watch?v=AbCdEfG1234   → AbCdEfG1234
 *   https://www.youtube.com/live/AbCdEfG1234      → AbCdEfG1234（YouTube Studio の共有リンク）
 *   https://youtu.be/AbCdEfG1234                  → AbCdEfG1234
 *   AbCdEfG1234                                   → AbCdEfG1234（そのまま）
 */
export function extractVideoId(raw: string): string {
  const value = raw.trim();
  if (value.length === 0) return '';
  const normalized = /^(https?:\/\/|www\.|youtu\.be\/|youtube\.com\/)/i.test(value)
    ? value.replace(/^(?!https?:\/\/)/i, 'https://')
    : null;
  if (normalized === null) return value;
  try {
    const url = new URL(normalized);
    const v = url.searchParams.get('v');
    if (v) return v;
    // /live/<id>, /embed/<id>, /shorts/<id>, youtu.be/<id>
    const segments = url.pathname.split('/').filter((s) => s.length > 0);
    return segments[segments.length - 1] ?? value;
  } catch {
    return value;
  }
}

export class ChatPoller {
  private readonly opts: ChatPollerOptions;
  private readonly onComment: (c: ChatComment) => void;
  private readonly log: ChatLogger;
  private readonly authMode: ChatAuthMode;
  /** opts.broadcastId から取り出した動画 ID（URL が渡されても ID にする）。 */
  private readonly configuredBroadcastId: string | undefined;

  private secret: ClientSecret | null = null;
  private token: StoredToken | null = null;
  private accessToken: string | null = null;
  private accessTokenExpiry = 0;
  private refreshing: Promise<void> | null = null;

  private ownChannelId: string | null = null;
  /** api_key 方式の videos.list で拾った直近の視聴者数。 */
  private lastViewers: number | null = null;
  private broadcastId: string | null = null;
  private liveChatId: string | null = null;

  private running = false;
  /** waiting = チャットが開くのを待っている / polling = 取得中 / stopped = 停止。 */
  private chatState: ChatState = 'stopped';
  private chatReason: string | null = null;
  /** 直近にログへ出した状態。状態が変わったときだけ 1 行出す（毎回は出さない）。 */
  private loggedState: string | null = null;
  private loopPromise: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;
  private nextPageToken: string | undefined;
  private pollIntervalMs: number;
  private readonly seenIds = new Set<string>();
  /** 直近に採用したコメントの投稿者（新しい順）。連投判定用。 */
  private recentAuthors: string[] = [];

  constructor(opts: ChatPollerOptions, onComment: (c: ChatComment) => void, logger: ChatLogger = defaultLogger) {
    this.opts = opts;
    this.onComment = onComment;
    this.log = logger;
    this.authMode = opts.auth ?? 'oauth';
    this.configuredBroadcastId = opts.broadcastId ? extractVideoId(opts.broadcastId) : undefined;
    this.pollIntervalMs = clamp(opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS);
  }

  // ---------------------------------------------------------------- lifecycle

  /** 認証・配信枠の解決を済ませてポーリングを開始する。 */
  async start(): Promise<{ liveChatId: string | null; broadcastId: string }> {
    if (this.running && this.broadcastId) {
      return { liveChatId: this.liveChatId, broadcastId: this.broadcastId };
    }

    if (this.authMode === 'api_key') {
      if (!this.opts.apiKey) {
        throw new Error(
          'YOUTUBE_API_KEY が設定されていません（config/youtube.yaml の auth: api_key を使う場合は .env に API キーが必要です）',
        );
      }
      if (!this.configuredBroadcastId) {
        throw new Error(
          'API キー方式では broadcast_id が必須です（config/youtube.yaml の broadcast_id に配信ページ URL の v= の値を書いてください）',
        );
      }
      this.broadcastId = this.configuredBroadcastId;
      // activeLiveChatId はまだ取れないことがある（配信前 / チャット未開始）。
      // その場合はポーリングループの中で解決を繰り返す。
      try {
        await this.resolveViaVideos();
      } catch (err) {
        // 「まだ無い」だけなら起動は止めず、待機状態でループに入る。
        if (!isWaiting(err)) throw err;
        this.liveChatId = null;
      }
    } else {
      this.secret = await loadClientSecret(this.requireOAuthPath('clientSecretPath'));
      this.token = await loadToken(this.requireOAuthPath('tokenPath'));
      await this.ensureAccessToken();

      this.ownChannelId = await this.fetchOwnChannelId();
      const resolved = await this.resolveBroadcast(this.configuredBroadcastId);
      this.broadcastId = resolved.broadcastId;
      this.liveChatId = resolved.liveChatId;
    }

    this.log.info(
      `auth=${this.authMode} broadcast=${this.broadcastId} liveChat=${this.liveChatId ?? 'pending'} ` +
        `ownChannel=${this.ownChannelId ?? 'unknown'} include_owner_comments=${String(this.includeOwnerComments)}`,
    );

    if (this.liveChatId) this.setChatState('polling', null);
    else this.setChatState('waiting', 'live chat not started yet');

    this.running = true;
    this.loopPromise = this.pollLoop();

    return { liveChatId: this.liveChatId, broadcastId: this.broadcastId };
  }

  private requireOAuthPath(key: 'clientSecretPath' | 'tokenPath'): string {
    const value = this.opts[key];
    if (!value) throw new Error(`auth: oauth には ${key} が必要です`);
    return value;
  }

  /** ポーリングを止める。呼び出しは何度でも安全。 */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.wakeUp?.();
    this.wakeUp = null;
    this.setChatState('stopped', 'stopped by daemon');
    this.log.info('stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /** ループ終了を待つ（daemon の graceful shutdown 用）。 */
  async waitClosed(): Promise<void> {
    await this.loopPromise;
  }

  getBroadcastId(): string | null {
    return this.broadcastId;
  }

  getLiveChatId(): string | null {
    return this.liveChatId;
  }

  /** `h3 status` の `youtube` に出す取得状態。 */
  getChatStatus(): { chat_state: ChatState; reason: string | null } {
    return { chat_state: this.chatState, reason: this.chatReason };
  }

  /** 既定は true（テスト中に自分のコメントで確認したいため）。 */
  private get includeOwnerComments(): boolean {
    return this.opts.includeOwnerComments !== false;
  }

  /**
   * 状態と理由を更新する。**変わったときだけ**ログを 1 行出す。
   * （404 のたびに 1 行出すとログが埋まるので、同じ状態のあいだは黙る。）
   */
  private setChatState(state: ChatState, reason: string | null): void {
    this.chatState = state;
    this.chatReason = reason;
    const key = `${state}:${reason ?? ''}`;
    if (this.loggedState === key) return;
    this.loggedState = key;
    const line = `chat_state=${state}${reason ? ` (${reason})` : ''}`;
    if (state === 'waiting') this.log.warn(line);
    else this.log.info(line);
  }

  /** videos.list の liveStreamingDetails.concurrentViewers。取得できなければ null。 */
  async getViewerCount(): Promise<number | null> {
    if (!this.broadcastId) return null;
    try {
      const res = await this.api<VideoListResponse>('videos', {
        part: 'liveStreamingDetails',
        id: this.broadcastId,
      });
      const raw = res.items?.[0]?.liveStreamingDetails?.concurrentViewers;
      if (raw === undefined) return null;
      const n = Number.parseInt(raw, 10);
      this.lastViewers = Number.isFinite(n) ? n : null;
      return this.lastViewers;
    } catch (err) {
      this.log.warn(`viewer count 取得失敗: ${describe(err)}`);
      return this.lastViewers;
    }
  }

  // ------------------------------------------------------------------- setup

  /**
   * API キー方式の解決。videos.list?part=liveStreamingDetails,snippet&id=<broadcastId> から
   * activeLiveChatId（チャット ID）と snippet.channelId（配信者自身の判定用）を取る。
   *
   * activeLiveChatId が無いのは「配信前 / チャット未開始 / チャット無効」なので例外にはせず
   * false を返し、呼び出し側でリトライする。
   */
  private async resolveViaVideos(): Promise<boolean> {
    const id = this.broadcastId ?? this.configuredBroadcastId;
    if (!id) throw new Error('broadcast_id が未設定です');

    const res = await this.api<VideoListResponse>('videos', {
      part: 'liveStreamingDetails,snippet',
      id,
    });
    const item = res.items?.[0];
    if (!item) {
      throw new YouTubeApiError(
        404,
        'videoNotFound',
        `動画 ${id} が見つかりません（config/youtube.yaml の broadcast_id を確認してください）`,
      );
    }

    // 配信者本人の判定に使うチャンネル ID。oauth では channels.list(mine=true) が正なので上書きしない。
    const channelId = item.snippet?.channelId;
    if (channelId && this.ownChannelId === null) {
      this.ownChannelId = channelId;
    }

    const viewers = item.liveStreamingDetails?.concurrentViewers;
    if (viewers !== undefined) {
      const n = Number.parseInt(viewers, 10);
      this.lastViewers = Number.isFinite(n) ? n : null;
    }

    const liveChatId = item.liveStreamingDetails?.activeLiveChatId;
    if (!liveChatId) {
      this.liveChatId = null;
      return false;
    }
    this.liveChatId = liveChatId;
    return true;
  }

  private async fetchOwnChannelId(): Promise<string | null> {
    try {
      const res = await this.api<ChannelListResponse>('channels', { part: 'id', mine: 'true' });
      return res.items?.[0]?.id ?? null;
    } catch (err) {
      this.log.warn(`自分のチャンネル ID を取得できませんでした（配信者自身の除外が効きません）: ${describe(err)}`);
      return null;
    }
  }

  private async resolveBroadcast(explicitId?: string): Promise<{ broadcastId: string; liveChatId: string }> {
    if (explicitId) {
      const res = await this.api<LiveBroadcastListResponse>('liveBroadcasts', {
        part: 'snippet,status',
        id: explicitId,
      });
      const item = res.items?.[0];
      const liveChatId = item?.snippet?.liveChatId;
      if (!item?.id || !liveChatId) {
        throw new Error(
          `broadcast ${explicitId} が見つからないか、ライブチャットが有効ではありません（config/youtube.yaml の broadcast_id を確認してください）`,
        );
      }
      return { broadcastId: item.id, liveChatId };
    }

    for (const status of ['active', 'upcoming'] as const) {
      const res = await this.api<LiveBroadcastListResponse>('liveBroadcasts', {
        part: 'snippet,status',
        mine: 'true',
        broadcastStatus: status,
        maxResults: '10',
      });
      const item = res.items?.find((i) => i.id && i.snippet?.liveChatId);
      if (item?.id && item.snippet?.liveChatId) {
        this.log.info(`broadcastStatus=${status} の配信枠を選択: "${item.snippet.title ?? ''}"`);
        return { broadcastId: item.id, liveChatId: item.snippet.liveChatId };
      }
    }

    throw new Error(
      'ライブチャットのある配信枠（active / upcoming）が見つかりません。YouTube Studio で配信枠を作成するか、config/youtube.yaml に broadcast_id を指定してください。',
    );
  }

  // -------------------------------------------------------------------- loop

  private async pollLoop(): Promise<void> {
    let attempt = 0;
    while (this.running) {
      let waitMs = this.pollIntervalMs;
      try {
        waitMs = await this.pollOnce();
        attempt = 0;
      } catch (err) {
        if (!this.running) break;
        if (isWaiting(err)) {
          // 配信枠が upcoming の間 liveChatMessages.list は 404 を返す。致命的にはせず、
          // activeLiveChatId を取り直しながら待ち続ける（live になったら自動で再開する）。
          this.liveChatId = null;
          this.nextPageToken = undefined;
          attempt = 0;
          waitMs = this.waitingRetryMs();
          this.setChatState('waiting', waitingReason(err));
        } else if (isFatal(err)) {
          this.log.error(`致命的エラーのためチャット取得を停止します: ${describe(err)}`);
          this.setChatState('stopped', describe(err));
          this.running = false;
          break;
        } else {
          attempt += 1;
          if (attempt > BACKOFF_MAX_ATTEMPTS) {
            this.log.error(`リトライ上限（${BACKOFF_MAX_ATTEMPTS} 回）に達したためチャット取得を停止します: ${describe(err)}`);
            this.setChatState('stopped', `retry limit reached: ${describe(err)}`);
            this.running = false;
            break;
          }
          waitMs = backoffMs(attempt);
          this.log.warn(`取得に失敗（${attempt}/${BACKOFF_MAX_ATTEMPTS}）、${Math.round(waitMs / 1000)}s 後に再試行: ${describe(err)}`);
        }
      }
      if (!this.running) break;
      await this.interruptibleSleep(waitMs);
    }
    this.wakeUp = null;
  }

  /**
   * チャット ID を取り直す。配信枠が `live` になったら activeLiveChatId が生えるので、
   * 取れるまで false を返し続ける（例外にはしない）。
   */
  private async ensureLiveChatId(): Promise<boolean> {
    if (this.liveChatId) return true;
    // videos.list は API キーでも OAuth でも叩ける。broadcast_id が分かっていればこれが一番速い。
    if (this.broadcastId) return this.resolveViaVideos();
    const resolved = await this.resolveBroadcast(undefined);
    this.broadcastId = resolved.broadcastId;
    this.liveChatId = resolved.liveChatId;
    return true;
  }

  /** ライブチャットが開くのを待つときの間隔（既定 10〜15 秒）。 */
  private waitingRetryMs(): number {
    const configured = this.opts.waitingRetryMs;
    if (typeof configured === 'number' && configured > 0) return configured;
    return WAITING_RETRY_MIN_MS + Math.random() * (WAITING_RETRY_MAX_MS - WAITING_RETRY_MIN_MS);
  }

  /** 1 回分の取得。次の待ち時間（ミリ秒）を返す。 */
  private async pollOnce(): Promise<number> {
    if (!this.liveChatId) {
      if (!(await this.ensureLiveChatId())) {
        this.setChatState('waiting', 'activeLiveChatId is not available yet');
        return this.waitingRetryMs();
      }
      this.log.info(`liveChat=${this.liveChatId} を検出しました。コメント取得を開始します。`);
    }
    if (!this.liveChatId) throw new Error('liveChatId が未解決です（start() を呼んでください）');
    this.setChatState('polling', null);

    const params: Record<string, string> = {
      liveChatId: this.liveChatId,
      part: 'snippet,authorDetails',
      maxResults: '200',
    };
    if (this.nextPageToken) params['pageToken'] = this.nextPageToken;

    const res = await this.api<LiveChatMessageListResponse>('liveChat/messages', params);
    this.nextPageToken = res.nextPageToken;

    for (const item of res.items ?? []) {
      const comment = this.toComment(item);
      if (!comment) continue;
      if (this.seenIds.has(comment.id)) continue;
      this.seenIds.add(comment.id);
      if (this.seenIds.size > 5000) {
        // 古い ID を捨てて上限を保つ（Set は挿入順）。
        const drop = this.seenIds.size - 4000;
        let i = 0;
        for (const id of this.seenIds) {
          if (i++ >= drop) break;
          this.seenIds.delete(id);
        }
      }

      const rejected = this.rejectReason(comment);
      if (rejected) {
        this.log.info(`skip ${comment.id} (${rejected}) ${comment.author}: ${comment.text.slice(0, 40)}`);
        continue;
      }

      this.recentAuthors.unshift(comment.authorChannelId);
      if (this.recentAuthors.length > REPEAT_AUTHOR_WINDOW) this.recentAuthors.length = REPEAT_AUTHOR_WINDOW;

      try {
        this.onComment(comment);
      } catch (err) {
        this.log.error(`onComment ハンドラが例外を投げました: ${describe(err)}`);
      }
    }

    if (res.offlineAt) {
      this.log.error(`ライブチャットが終了しました（offlineAt=${res.offlineAt}）。チャット取得を停止します。`);
      this.setChatState('stopped', `live chat ended (offlineAt=${res.offlineAt})`);
      this.running = false;
    }

    const apiInterval = typeof res.pollingIntervalMillis === 'number' ? res.pollingIntervalMillis : 0;
    return clamp(Math.max(apiInterval, this.pollIntervalMs), MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS);
  }

  private toComment(item: LiveChatMessageItem): ChatComment | null {
    const id = item.id;
    const snippet = item.snippet;
    if (!id || !snippet) return null;
    // 通常のテキストコメントだけを扱う（スーパーチャットや入退室通知は無視）。
    if (snippet.type && snippet.type !== 'textMessageEvent') return null;
    const text = (snippet.textMessageDetails?.messageText ?? snippet.displayMessage ?? '').trim();
    if (text.length === 0) return null;
    return {
      id,
      author: item.authorDetails?.displayName ?? 'unknown',
      authorChannelId: item.authorDetails?.channelId ?? '',
      text,
      publishedAt: snippet.publishedAt ?? new Date().toISOString(),
    };
  }

  /** 除外理由。採用する場合は null。 */
  private rejectReason(c: ChatComment): string | null {
    if (!this.includeOwnerComments && this.ownChannelId && c.authorChannelId === this.ownChannelId) {
      return 'self';
    }
    const ng = containsNgWord(c.text, this.opts.ngWords);
    if (ng) return `ng_word:${ng}`;
    if (isUrlOnly(c.text)) return 'url_only';
    // 同一ユーザーの連投：直近 REPEAT_AUTHOR_WINDOW 件の採用コメントが全て同じ人のときだけ弾く
    // （視聴者が 1 人しかいないテスト配信などで全部捨ててしまわないように）。
    if (
      c.authorChannelId &&
      this.recentAuthors.length >= REPEAT_AUTHOR_WINDOW &&
      this.recentAuthors.every((id) => id === c.authorChannelId)
    ) {
      return 'repeat_author';
    }
    return null;
  }

  private async interruptibleSleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUp = null;
        resolve();
      }, ms);
      this.wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  // --------------------------------------------------------------- API 呼び出し

  private async ensureAccessToken(force = false): Promise<string> {
    if (!force && this.accessToken && Date.now() < this.accessTokenExpiry - 60_000) {
      return this.accessToken;
    }
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const secret = this.secret ?? (await loadClientSecret(this.requireOAuthPath('clientSecretPath')));
        this.secret = secret;
        const token = this.token ?? (await loadToken(this.requireOAuthPath('tokenPath')));
        this.token = token;
        const { accessToken, expiry } = await refreshAccessToken(secret, token.refresh_token);
        this.accessToken = accessToken;
        this.accessTokenExpiry = expiry;
        // 次回起動を速くするためにキャッシュしておく（refresh_token は変えない）。
        await saveToken(this.requireOAuthPath('tokenPath'), {
          ...token,
          access_token: accessToken,
          expiry,
        }).catch(() => undefined);
      })().finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;
    if (!this.accessToken) throw new Error('access token を取得できませんでした');
    return this.accessToken;
  }

  private async api<T>(path: string, params: Record<string, string>, retriedAuth = false): Promise<T> {
    const apiKeyMode = this.authMode === 'api_key';
    const url = new URL(`${API_BASE}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiKeyMode) {
      if (!this.opts.apiKey) throw new Error('YOUTUBE_API_KEY が設定されていません');
      url.searchParams.set('key', this.opts.apiKey);
    } else {
      headers['authorization'] = `Bearer ${await this.ensureAccessToken()}`;
    }

    const res = await fetch(url, { headers });

    if (res.ok) return (await res.json()) as T;

    const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
    const reason = body.error?.errors?.[0]?.reason ?? '';
    const message = body.error?.message ?? res.statusText;

    if (apiKeyMode && (res.status === 401 || res.status === 403) && !WAITING_REASONS.has(reason)) {
      // API キーが無効／制限に引っかかっている／このエンドポイントが OAuth を要求している。
      // リトライしても回復しないので理由をログに出して止める。
      this.log.error(
        `API キーが拒否されました (${res.status} ${reason || 'error'}): ${message}\n` +
          'Google Cloud で YouTube Data API v3 が有効か、API キーの制限（HTTP リファラ制限は外す / ' +
          'API 制限は YouTube Data API v3 のみ）を確認してください。',
      );
      throw new YouTubeApiError(
        res.status,
        reason || 'authError',
        `${path} (${res.status} ${reason || 'authError'}): ${message}`,
        true,
      );
    }

    if (!apiKeyMode && res.status === 401 && !retriedAuth) {
      // access token 切れ。取り直して 1 回だけやり直す。
      await this.ensureAccessToken(true);
      return this.api<T>(path, params, true);
    }
    throw new YouTubeApiError(res.status, reason, `${path} (${res.status} ${reason || 'error'}): ${message}`);
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function backoffMs(attempt: number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
  return Math.round(base * (0.8 + Math.random() * 0.4)); // ジッター
}

/**
 * 「まだチャットが開いていないだけ」なら true。ポーリングは止めず待機状態にする。
 *
 * 配信枠が `upcoming` のあいだ `liveChatMessages.list` は 404 を返す。
 */
function isWaiting(err: unknown): boolean {
  if (!(err instanceof YouTubeApiError)) return false;
  if (err.fatal) return false;
  if (WAITING_REASONS.has(err.reason)) return true;
  return err.status === 404;
}

/** 待機理由を 1 行にする（状態が変わったときだけログに出す文言）。 */
function waitingReason(err: unknown): string {
  if (err instanceof YouTubeApiError) {
    return `${err.reason || 'notFound'} (${err.status})`;
  }
  return describe(err);
}

function isFatal(err: unknown): boolean {
  if (err instanceof YouTubeApiError) {
    if (err.fatal) return true;
    if (FATAL_REASONS.has(err.reason)) return true;
    // 4xx のうち 401（更新で回復）と 429（レート制限）以外は回復しない。
    if (err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429) return true;
  }
  return false;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
