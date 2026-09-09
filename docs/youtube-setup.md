# YouTube 連携セットアップ

h3-stream は YouTube Data API v3 を叩いて、ライブチャットのコメント取得と視聴者数の取得を行う。
googleapis などの SDK は使わず `fetch` で直接叩くため、追加の npm 依存は不要。

認証方式は 2 つ。`config/youtube.yaml` の `auth` で切り替える。

| 方式 | `auth` | 必要なもの | 向き |
|---|---|---|---|
| **API キー**（推奨・簡単） | `api_key`（既定） | API キー + 配信の動画 ID | 通常はこちら |
| OAuth | `oauth` | OAuth クライアント + `h3 youtube auth` | 動画 ID を毎回書きたくない場合 |

コメント取得・視聴者数の取得はどちらの方式でもできる。API キー方式は「自分の配信枠を自動で探す」
（`mine=true`）が使えないので、配信ごとに動画 ID を設定する必要がある。

---

# A. API キー方式（推奨・簡単）

## A-1. API キーを作る

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作る（既存でもよい）。
2. **API とサービス → ライブラリ** で **YouTube Data API v3** を「有効にする」。
3. **API とサービス → 認証情報 → 認証情報を作成 → API キー**。
4. 作成されたキーをコピーし、`.env` に書く。

   ```bash
   # .env
   YOUTUBE_API_KEY=AIza...
   ```

5. キーの制限（**キーを編集**）は次を推奨。
   - **アプリケーションの制限**: `なし`
     （HTTP リファラー制限を付けるとサーバー側の `fetch` から使えなくなる）
   - **API の制限**: `キーを制限` → **YouTube Data API v3** のみを選択

> API キーは秘密情報。`.env` は `.gitignore` 済みであることを確認する。OAuth 同意画面の設定や
> `client_secret.json` は不要。

## A-2. 配信枠を作り、動画 ID を設定する

1. [YouTube Studio](https://studio.youtube.com/) → **作成 → ライブ配信を開始** で配信枠を作る
   （詳細は下の「配信枠を作る」を参照。**チャットを有効**にすること）。
2. 配信の**動画 ID**を `config/youtube.yaml` に書く。次はどれも同じ動画 ID (`AbCdEfG1234`)。
   - 視聴ページ `https://www.youtube.com/watch?v=AbCdEfG1234` の `v=` の値
   - YouTube Studio の共有リンク `https://www.youtube.com/live/AbCdEfG1234` の末尾
   - 短縮 URL `https://youtu.be/AbCdEfG1234` の末尾

   URL を丸ごと貼っても動画 ID を自動で取り出すので、`broadcast_id: "https://www.youtube.com/live/AbCdEfG1234"`
   と書いてもよい。

   ```yaml
   enabled: true
   auth: api_key
   broadcast_id: "AbCdEfG1234"
   ```

API キーでは `mine=true` が使えないため **`broadcast_id` は必須**。空のままデーモンを起動すると
エラーログを出したうえで、チャット取得だけ無効にして起動する（配信自体は続く）。

## A-3. 動作の流れ

1. `videos.list?part=liveStreamingDetails,snippet&id=<broadcast_id>&key=…`
   - `liveStreamingDetails.activeLiveChatId` → ライブチャット ID
   - `snippet.channelId` → 配信者自身（`include_owner_comments: false` のときの除外に使う）
   - `liveStreamingDetails.concurrentViewers` → 視聴者数
2. `liveChatMessages.list?part=snippet,authorDetails&liveChatId=…&key=` でコメントを取得

配信開始前やチャット未開始のときは `activeLiveChatId` が返らない。その場合はエラーにせず、
チャットが始まるまで `videos.list` を繰り返して待つ。

配信枠が `upcoming` のあいだは `liveChatMessages.list` が **404（`liveChatNotFound`）** を返すが、
これも致命的には扱わない。チャット ID を捨てて `videos.list` で取り直しながら 10〜15 秒間隔で
再試行し続け、配信が `live` になったら自動でポーリングを始める。
いまどちらの状態かは `h3 status` の `youtube.chat_state` で分かる。

| `chat_state` | 意味 |
|---|---|
| `waiting` | チャットがまだ開いていない（配信枠が `upcoming` など）。`reason` に理由。再試行を続けている |
| `polling` | コメントを取得中 |
| `stopped` | 取得を停止した（`liveChatEnded` / 権限エラー / 設定不足など。`reason` に理由） |

## A-4. 配信者本人のコメント

`config/youtube.yaml`：

```yaml
include_owner_comments: true   # 既定。配信者本人のコメントも拾う
```

- `true`（既定）：配信枠のチャンネル（＝配信者本人）のコメントも他の視聴者と同じように扱う。
  テスト中に自分でコメントを書いて動作確認できる。
- `false`：従来どおり配信者本人のコメントを除外する。

NG ワード・URL のみ・同一ユーザーの連投（直近 3 件以内）の除外は設定に関係なく常に働く。

## A-5. うまくいかないとき

| 症状 | 対処 |
|---|---|
| `YOUTUBE_API_KEY が .env にありません` | `.env` にキーを書く。`.env.example` を参照 |
| `broadcast_id が空です` | `config/youtube.yaml` に配信ページの `v=` の値を書く |
| `API キーが拒否されました (403)` | YouTube Data API v3 が有効か / キーの制限（リファラー制限を外す）を確認 |
| チャットが始まらない | 配信枠のチャットが有効か、配信がまだ `upcoming` でチャット未開始でないか確認 |

---

# B. OAuth 方式

`config/youtube.yaml` に `auth: oauth` を書いた場合の手順。必要なのは次の 3 ステップ。

1. Google Cloud で OAuth クライアントを作る
2. `h3 youtube auth` で認可し、refresh token を保存する
3. YouTube Studio で配信枠を作る

## 1. Google Cloud で OAuth クライアントを作る

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作る（既存でもよい）。
2. **API とサービス → ライブラリ** で **YouTube Data API v3** を「有効にする」。
3. **API とサービス → OAuth 同意画面**
   - User Type: **外部**（個人アカウントなら通常こちら）
   - アプリ名・サポートメール・デベロッパーの連絡先を入力
   - **スコープ**に以下を追加
     - `https://www.googleapis.com/auth/youtube.readonly`
     - `https://www.googleapis.com/auth/youtube.force-ssl`
   - **テストユーザー**に配信に使う Google アカウントを追加する
     （公開ステータスが「テスト」のままでよい。この場合 refresh token は 7 日で失効するので、
     失効したら `h3 youtube auth` をやり直す。長期運用するならアプリを「本番」に公開する）
4. **API とサービス → 認証情報 → 認証情報を作成 → OAuth クライアント ID**
   - アプリケーションの種類: **デスクトップ アプリ**
   - 作成後 **JSON をダウンロード** し、`config/client_secret.json` として保存する
     （`.gitignore` 済みであることを確認。中身は秘密情報）

> リダイレクト URI の登録は不要。デスクトップアプリのクライアントはループバック
> (`http://127.0.0.1:<任意ポート>/callback`) が常に許可される。

`config/youtube.yaml` の `client_secret_path` が保存場所と一致していることを確認する。

## 2. 認可して refresh token を保存する

```bash
h3 youtube auth
```

- ターミナルに認可 URL が出るので、ブラウザで開き、**配信に使う Google アカウント**で許可する。
- 「このアプリは確認されていません」と出たら「詳細」→「（アプリ名）に移動」で進む（自分で作ったアプリのため）。
- 許可すると `http://127.0.0.1:<port>/callback` に戻り、`config/youtube.yaml` の `token_path`
  （既定 `state/youtube_token.json`）に refresh token が `0600` で保存される。

以後 access token は refresh token から自動更新されるので、この操作は原則 1 回でよい。
`invalid_grant` が出るようになったら（パスワード変更・7 日失効・アクセス取り消しなど）もう一度実行する。

再実行しても `refresh_token` が返らない場合は、
[Google アカウントのサードパーティ アプリ設定](https://myaccount.google.com/connections)
から当該アプリのアクセスを削除してから、もう一度 `h3 youtube auth` を実行する。

---

# C. 共通の手順

## 配信枠を作る

1. [YouTube Studio](https://studio.youtube.com/) → 右上 **作成 → ライブ配信を開始**。
   - 初回はライブ配信の有効化に **最大 24 時間** かかる。前日までに済ませておく。
2. **ストリーミング ソフトウェア**（エンコーダ配信）を選び、配信枠を作る。
   - タイトル・公開設定（テスト時は **限定公開** 推奨）を設定
   - **チャット を有効**にする（無効だと `liveChatId` が取れない）
   - 「低遅延」推奨（コメント → 返答の体感遅延が短くなる）
3. **ストリームキー**を控え、`.env` の `RTMP_KEY` に設定する。
4. 配信枠は作成した時点で `upcoming`、エンコーダから映像が届いて開始すると `active` になる。
   配信ページの URL に含まれる動画 ID（`watch?v=` の値、または `live/…` 形式の末尾。どちらも同じ ID）を
   `config/youtube.yaml` の `broadcast_id` に書く（URL 丸ごとでも可）。
   **API キー方式では必須**。OAuth 方式では空にしておけば `active` → `upcoming` の順に自動で選ばれる。

## 動作確認

```bash
h3 daemon start --character <name>
h3 status      # youtube.broadcastId / liveChatId が入っていること
h3 comments    # 自分でチャットに書き込んでから叩くと拾えているか確認できる
```

既定（`include_owner_comments: true`）では自分（配信者アカウント）の書き込みも拾えるので、
自分でコメントするだけで確認できる。`include_owner_comments: false` にしている場合は除外されるため、
別アカウント（またはスマホの別アカウント）からコメントすること。

`h3 comments` が空のときは `h3 status` の `youtube.chat_state` を見る。`waiting` なら
まだチャットが開いていないだけなので、配信を `live` にすれば自動で拾い始める。

## 使用する API とスコープ

| 用途 | エンドポイント | 方式 | 消費クォータ(目安) |
|---|---|---|---|
| liveChatId・配信者チャンネル ID・視聴者数 | `videos.list?part=liveStreamingDetails,snippet&id=<broadcast_id>&key=` | api_key | 1 / 呼び出し |
| 自分のチャンネル ID（`include_owner_comments: false` の除外用） | `channels.list?part=id&mine=true` | oauth | 1 / 起動時 1 回 |
| 配信枠と liveChatId の解決 | `liveBroadcasts.list?part=snippet,status&mine=true&broadcastStatus=active\|upcoming` | oauth | 1 / 起動時 |
| コメント取得 | `liveChatMessages.list?part=snippet,authorDetails&liveChatId=…` | 共通 | 5 / ポーリング 1 回 |
| 視聴者数 | `videos.list?part=liveStreamingDetails&id=<broadcastId>` | 共通 | 1 / 呼び出し |

OAuth 方式のスコープ：`youtube.readonly` と `youtube.force-ssl`
（`liveChatMessages.list` は force-ssl 系スコープを要求するため両方付与している）。

既定クォータは 1 日 10,000 units。5 秒間隔のポーリングは 1 時間あたり約 3,600 units 消費するので、
長時間配信では `config/youtube.yaml` の `poll_interval_ms` を 8000〜10000 に上げるか、
Google Cloud でクォータの引き上げを申請する。

## トラブルシュート

| 症状 | 対処 |
|---|---|
| `token を読めません` | `h3 youtube auth` を実行していない。または `token_path` が違う |
| `invalid_grant` | refresh token 失効。`h3 youtube auth` をやり直す（テストアプリは 7 日で失効） |
| `ライブチャットのある配信枠が見つかりません` | 配信枠が無い / チャット無効 / 別アカウントで認可した |
| `liveChatEnded` でチャット取得が停止 | 配信が終了している。新しい配信枠を作り直す |
| `quotaExceeded` | 当日のクォータ切れ。`poll_interval_ms` を上げるか翌日（太平洋時間 0 時リセット）まで待つ |
| コメントが 1 件も来ない | `h3 status` の `youtube.chat_state` を見る。`waiting` なら配信枠がまだ `live` になっていない。`include_owner_comments: false` なら自分のコメントは除外されるので別アカウントから投稿する |
| `chat_state: waiting` のまま変わらない | 配信枠が `upcoming` のまま。YouTube Studio で配信を開始する（チャットが開けば自動で `polling` になる） |
