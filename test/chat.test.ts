import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ChatPoller, extractVideoId, type ChatComment } from "../src/daemon/chat.ts";

const API_KEY = "test-api-key";
const VIDEO_ID = "AbCdEfG1234";
const OWN_CHANNEL = "UC_owner";
const LIVE_CHAT_ID = "LiveChat123";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

type Handler = (url: URL) => unknown;

/** ハンドラがこれを返すと、その HTTP ステータス・reason のエラー応答になる。 */
class ApiFailure {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly message = 'error',
  ) {}
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** fetch をモックし、呼ばれた URL を記録する。handler は body（JSON）を返す。 */
function mockFetch(handler: Handler): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    const result = handler(url);
    if (result instanceof ApiFailure) {
      return {
        ok: false,
        status: result.status,
        statusText: 'Not Found',
        json: async () => ({
          error: {
            code: result.status,
            message: result.message,
            errors: [{ reason: result.reason, message: result.message }],
          },
        }),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => result,
    } as unknown as Response;
  }) as typeof fetch;
  return calls;
}

function videoResponse(activeLiveChatId: string | null): unknown {
  return {
    items: [
      {
        id: VIDEO_ID,
        snippet: { channelId: OWN_CHANNEL, title: "test live" },
        liveStreamingDetails: {
          concurrentViewers: "42",
          ...(activeLiveChatId ? { activeLiveChatId } : {}),
        },
      },
    ],
  };
}

function message(id: string, channelId: string, text: string): unknown {
  return {
    id,
    snippet: {
      type: "textMessageEvent",
      publishedAt: new Date().toISOString(),
      textMessageDetails: { messageText: text },
    },
    authorDetails: { channelId, displayName: channelId },
  };
}

function makePoller(
  onComment: (c: ChatComment) => void,
  broadcastId = VIDEO_ID,
  extra: Partial<ConstructorParameters<typeof ChatPoller>[0]> = {},
): ChatPoller {
  return new ChatPoller(
    {
      auth: "api_key",
      apiKey: API_KEY,
      broadcastId,
      pollIntervalMs: 1000,
      // 待機からの復帰は既定 10〜15 秒。テストでは短くする。
      waitingRetryMs: 20,
      ngWords: [],
      ...extra,
    },
    onComment,
    silentLogger,
  );
}

test("api_key モード: videos.list → liveChatMessages.list の URL を組み立て、include_owner_comments: false なら配信者自身を除外する", async () => {
  const calls = mockFetch((url) =>
    url.pathname.endsWith("/videos")
      ? videoResponse(LIVE_CHAT_ID)
      : {
          items: [
            message("m1", OWN_CHANNEL, "配信者自身のコメント"),
            message("m2", "UC_viewer", "こんにちは"),
          ],
          nextPageToken: "next-token",
          pollingIntervalMillis: 1000,
        },
  );

  const received: ChatComment[] = [];
  const poller = makePoller((c) => received.push(c), VIDEO_ID, { includeOwnerComments: false });
  const started = await poller.start();

  assert.equal(started.broadcastId, VIDEO_ID);
  assert.equal(started.liveChatId, LIVE_CHAT_ID);

  // 最初の呼び出しは videos.list（liveStreamingDetails + snippet、key 付き、OAuth ヘッダ無し）。
  const videosUrl = new URL(calls[0] ?? "");
  assert.equal(videosUrl.origin + videosUrl.pathname, "https://www.googleapis.com/youtube/v3/videos");
  assert.equal(videosUrl.searchParams.get("part"), "liveStreamingDetails,snippet");
  assert.equal(videosUrl.searchParams.get("id"), VIDEO_ID);
  assert.equal(videosUrl.searchParams.get("key"), API_KEY);
  assert.equal(videosUrl.searchParams.get("mine"), null);

  await waitFor(() => received.length > 0);
  poller.stop();
  await poller.waitClosed();

  // 続く呼び出しは liveChatMessages.list。
  const chatUrl = new URL(calls.find((c) => c.includes("/liveChat/messages")) ?? "");
  assert.equal(chatUrl.searchParams.get("part"), "snippet,authorDetails");
  assert.equal(chatUrl.searchParams.get("liveChatId"), LIVE_CHAT_ID);
  assert.equal(chatUrl.searchParams.get("key"), API_KEY);

  // channels.list(mine=true) は使わない（API キーでは叩けない）。
  assert.equal(
    calls.some((c) => c.includes("/channels")),
    false,
  );

  // 配信者自身（videos.list の snippet.channelId）は除外される。
  assert.deepEqual(
    received.map((c) => c.id),
    ["m2"],
  );
});

test("api_key モード: activeLiveChatId が無ければリトライして、出てきたら取得を始める", async () => {
  let videosCalls = 0;
  const calls = mockFetch((url) => {
    if (url.pathname.endsWith("/videos")) {
      videosCalls += 1;
      // 1 回目はチャット未開始（activeLiveChatId 無し）。
      return videoResponse(videosCalls >= 2 ? LIVE_CHAT_ID : null);
    }
    return { items: [message("m9", "UC_viewer", "はじまった？")], pollingIntervalMillis: 1000 };
  });

  const received: ChatComment[] = [];
  const poller = makePoller((c) => received.push(c));
  const started = await poller.start();

  // start 時点ではチャット ID 未解決。デーモンは停止せずポーリングで再確認する。
  assert.equal(started.liveChatId, null);

  await waitFor(() => received.length > 0);
  poller.stop();
  await poller.waitClosed();

  assert.ok(videosCalls >= 2, "activeLiveChatId が取れるまで videos.list を再試行する");
  assert.equal(poller.getLiveChatId(), LIVE_CHAT_ID);
  assert.deepEqual(
    received.map((c) => c.text),
    ["はじまった？"],
  );
  assert.ok(calls.some((c) => c.includes("/liveChat/messages")));
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("broadcast_id に URL が貼られていても動画 ID を取り出す", () => {
  const cases: Array<[string, string]> = [
    ["AbCdEfG1234", "AbCdEfG1234"],
    ["  AbCdEfG1234  ", "AbCdEfG1234"],
    ["https://www.youtube.com/watch?v=AbCdEfG1234", "AbCdEfG1234"],
    ["https://www.youtube.com/watch?v=AbCdEfG1234&feature=share", "AbCdEfG1234"],
    // YouTube Studio の共有リンク（/live/ 形式）も同じ動画 ID。
    ["https://www.youtube.com/live/AbCdEfG1234", "AbCdEfG1234"],
    ["https://www.youtube.com/live/AbCdEfG1234?feature=share", "AbCdEfG1234"],
    ["https://youtu.be/AbCdEfG1234?t=30", "AbCdEfG1234"],
    ["www.youtube.com/live/AbCdEfG1234", "AbCdEfG1234"],
    ["", ""],
  ];
  for (const [input, expected] of cases) {
    assert.equal(extractVideoId(input), expected, input);
  }
});

test("api_key モード: broadcast_id に /live/ 形式の URL を書いても videos.list は動画 ID で叩く", async () => {
  const calls = mockFetch((url) =>
    url.pathname.endsWith("/videos")
      ? videoResponse(LIVE_CHAT_ID)
      : { items: [], pollingIntervalMillis: 1000 },
  );

  const poller = makePoller(() => {}, `https://www.youtube.com/live/${VIDEO_ID}`);
  const started = await poller.start();
  poller.stop();
  await poller.waitClosed();

  assert.equal(started.broadcastId, VIDEO_ID);
  assert.equal(new URL(calls[0] ?? "").searchParams.get("id"), VIDEO_ID);
});

// ---------- 配信枠が upcoming のときの 404（初回配信で止まった不具合） ----------

test("liveChatMessages が 404 でも致命的にせず、チャットが開いたら自動で取得を始める", async () => {
  // 配信枠は upcoming。activeLiveChatId は返るのに liveChatMessages.list は 404 を返す。
  let chatOpen = false;
  let chatCalls = 0;
  mockFetch((url) => {
    if (url.pathname.endsWith("/videos")) return videoResponse(LIVE_CHAT_ID);
    chatCalls += 1;
    if (!chatOpen) return new ApiFailure(404, "liveChatNotFound", "The live chat is no longer live.");
    return { items: [message("m1", "UC_viewer", "はじまった？")], pollingIntervalMillis: 1000 };
  });

  const received: ChatComment[] = [];
  const poller = makePoller((c) => received.push(c));
  await poller.start();

  // 404 が続くあいだは waiting のまま。停止はしない。
  await waitFor(() => chatCalls >= 2);
  assert.equal(poller.isRunning(), true);
  assert.equal(poller.getChatStatus().chat_state, "waiting");
  assert.match(String(poller.getChatStatus().reason), /liveChatNotFound/);

  // 配信が live になったらそのまま取得を始める（再起動は要らない）。
  chatOpen = true;
  await waitFor(() => received.length > 0);
  assert.equal(poller.getChatStatus().chat_state, "polling");
  assert.equal(poller.getChatStatus().reason, null);

  poller.stop();
  await poller.waitClosed();
  assert.equal(poller.getChatStatus().chat_state, "stopped");
  assert.deepEqual(
    received.map((c) => c.text),
    ["はじまった？"],
  );
});

test("回復しないエラー（forbidden）では chat_state: stopped になる", async () => {
  mockFetch((url) =>
    url.pathname.endsWith("/videos")
      ? videoResponse(LIVE_CHAT_ID)
      : new ApiFailure(403, "forbidden", "The request is not authorized."),
  );

  const poller = makePoller(() => {});
  await poller.start();
  await waitFor(() => !poller.isRunning());
  assert.equal(poller.getChatStatus().chat_state, "stopped");
  assert.match(String(poller.getChatStatus().reason), /forbidden/);
  await poller.waitClosed();
});

// ---------- 配信者本人のコメント（include_owner_comments） ----------

test("既定（include_owner_comments 未指定）では配信者本人のコメントも拾う", async () => {
  mockFetch((url) =>
    url.pathname.endsWith("/videos")
      ? videoResponse(LIVE_CHAT_ID)
      : {
          items: [
            message("m1", OWN_CHANNEL, "配信者自身のコメント"),
            message("m2", "UC_viewer", "こんにちは"),
          ],
          pollingIntervalMillis: 1000,
        },
  );

  const received: ChatComment[] = [];
  const poller = makePoller((c) => received.push(c));
  await poller.start();
  await waitFor(() => received.length >= 2);
  poller.stop();
  await poller.waitClosed();

  assert.deepEqual(
    received.map((c) => c.id),
    ["m1", "m2"],
  );
});

test("include_owner_comments: false なら配信者本人のコメントだけ落ちる", async () => {
  mockFetch((url) =>
    url.pathname.endsWith("/videos")
      ? videoResponse(LIVE_CHAT_ID)
      : {
          items: [
            message("m1", OWN_CHANNEL, "配信者自身のコメント"),
            message("m2", "UC_viewer", "こんにちは"),
          ],
          pollingIntervalMillis: 1000,
        },
  );

  const received: ChatComment[] = [];
  const poller = makePoller((c) => received.push(c), VIDEO_ID, { includeOwnerComments: false });
  await poller.start();
  await waitFor(() => received.length > 0);
  poller.stop();
  await poller.waitClosed();

  assert.deepEqual(
    received.map((c) => c.id),
    ["m2"],
  );
});
