---
name: h3-stream-setup
description: h3-stream（AIキャラクターの YouTube Live 配信システム）の環境構築を対話的に完了させる手順書。依存の導入、.env とキーの設定、OpenAI 互換 TTS サーバー、YouTube 連携、キャラクター設定、課金なしの動作確認までを行う。「セットアップ」「初期設定」「環境構築」「setup」「セットアップして」「初期設定したい」などと言われたらこの手順に従う。
---

# h3-stream セットアップ

あなたは h3-stream の**セットアップ担当**。ユーザーと対話しながら、配信を始められる状態まで
環境を作る。手順は上から順に進め、**各節の確認コマンドが通ってから次へ進む。**

## 大原則

1. **API キーの値を会話に出させない。** キーが必要なときは、ユーザー自身に
   `! printf 'FAL_KEY=xxx\n' >> .env` の形で書いてもらう（Claude Code の `!` はシェル実行。
   入力はモデルに渡らない）。書けたかどうかは `cut -d= -f1 .env` でキー名だけ見て確認する。
   **`cat .env` はしない。**
2. **Director に接続する操作はしない。** `h3 speak`、compositor の起動
   （`broadcast.enabled: true` / `h3 broadcast start`）は fal の課金が発生する。
   セットアップの動作確認は `--no-tts` + `broadcast.enabled: false` の範囲で行う。
3. 足りないものが見つかったら、勝手に入れずに**導入コマンドを提示して確認を取る**。
   `sudo` が要るものは特に。
4. 判断に迷ったらユーザーに聞く。黙って設定を書き換えない。

---

## 1. 前提チェック

```bash
node -v          # v24 以上
npm -v
ffmpeg -version | head -1
uv --version     # TTS サーバーを自前ホストする場合のみ
nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv   # 同上
```

不足していたら次を提示する（ユーザーの OS に合わせて調整する）。

| 不足 | 導入 |
|---|---|
| Node 24 | `curl -fsSL https://fnm.vercel.app/install \| bash` → `fnm install 24 && fnm use 24`（または nvm / apt の nodesource） |
| ffmpeg | Ubuntu/Debian: `sudo apt install ffmpeg` ／ macOS: `brew install ffmpeg` |
| uv | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| NVIDIA ドライバ | GPU 無しでも動くが TTS が実用にならない。ユーザーに確認する |

TTS を**ローカルで自前ホストする場合だけ** uv と GPU が要る。既に立っている
OpenAI 互換の TTS サーバー（社内・クラウド・OpenAI 本家）を使うなら不要なので、
まず「TTS はどこのサーバーを使うか」をユーザーに聞く。
自前ホストするなら `nvidia-smi` の**空き VRAM が 5GB 以上**あることを確認する。

Playwright の Chromium は次の節で入れる。

---

## 2. インストール

```bash
npm install
npx playwright install chromium
npm run build:web
npm link
h3 --help
```

- `npm link` が権限エラーになる場合：`npm config set prefix ~/.local` してから再実行するか、
  `h3` の代わりに `node bin/h3.js` を使う（ユーザーに選んでもらう）。
- `npx playwright install chromium` は数百 MB のダウンロードがある。時間がかかることを伝える。
- `npm run build:web` が `overlay/*.js` を作る。ここでエラーが出たら typecheck も確認する
  （`npm run typecheck && npm test`）。

---

## 3. `.env` を作る

```bash
test -f .env || cp .env.example .env
cut -d= -f1 .env
```

必要なキーは 3 つ（＋ TTS サーバーが鍵を要求するなら `TTS_API_KEY`）。
**値はユーザーに自分で書いてもらう。**

| キー | 取得元 |
|---|---|
| `FAL_KEY` | https://fal.ai/dashboard/keys |
| `YOUTUBE_API_KEY` | Google Cloud → API とサービス → 認証情報 → API キー（§5） |
| `RTMP_KEY` | YouTube Studio → ライブ配信 → ストリームキー |
| `TTS_API_KEY` | TTS サーバーが Bearer 認証を要求するときだけ（§6） |

`.env` は秘密だけでなく、**リポジトリ外を指すパス**の置き場でもある
（yaml の `${VAR}` が展開される）。設定 yaml にマシン固有の絶対パスを書かせない。

ユーザーへの案内（そのまま出してよい）：

```
以下をコピーして、xxx の部分を実際のキーに置き換えて実行してください。
キーの値は私（Claude）には渡りません。

! printf 'FAL_KEY=xxx\n' >> .env
! printf 'YOUTUBE_API_KEY=xxx\n' >> .env
! printf 'RTMP_KEY=xxx\n' >> .env
```

`.env.example` をコピーした直後は `FAL_KEY=` のような空行があるので、
**追記した行が後に来て上書きされる**ことを確認する。心配なら空行を消してから追記してもらう。

書けたら確認する。**値は見ない。**

```bash
cut -d= -f1 .env                       # キー名だけ
awk -F= 'length($2)>0 {print $1" set"}' .env   # 値が入っているキーだけ
```

`.env` は `.gitignore` 済み。念のため `git check-ignore -v .env` で確認する。

---

## 4. fal（課金の説明と残高確認）

**始める前に必ず伝える。**

- Director は **$0.02/秒**（プロモ価格、通常 $0.08）、**最低 $1.20/セッション**。1080p は 2 倍。
- **セッションの長さは残高で決まる。** `session_info.max_session_seconds` は固定値ではなく
  「使った秒数だけ減る残枠」で、残高が少ないとセッションが数分で切れる。
  実測で 372 秒 → 次のセッションでは 243 秒に減っていた。
- 10 分配信したいなら最低でも $12 相当の枠が要る。

https://fal.ai/dashboard/billing で残高を確認してもらう。
残高が少ないときは「配信中に `session_ended` で止まる」ことを伝えておく。

---

## 5. YouTube 連携

詳細な画面手順は `docs/youtube-setup.md`。API キー方式（推奨）で進める。

### 5-1. API キー

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作る（既存でもよい）。
2. **API とサービス → ライブラリ** で **YouTube Data API v3** を有効にする。
3. **認証情報 → 認証情報を作成 → API キー**。
4. キーの制限は
   - アプリケーションの制限: **なし**（HTTP リファラー制限を付けるとサーバー側の `fetch` から使えない）
   - API の制限: **YouTube Data API v3 のみ**
5. `.env` の `YOUTUBE_API_KEY` に書く（§3 の方法で）。

### 5-2. 設定ファイル

```bash
test -f config/youtube.yaml || cp config/youtube.example.yaml config/youtube.yaml
```

`config/youtube.yaml` は git 管理外。`enabled: true` / `auth: api_key` を確認する。

### 5-3. 配信枠と `broadcast_id`

YouTube Studio → **作成 → ライブ配信を開始**で配信枠を作ってもらう（**チャットを有効にする**）。
配信の URL をユーザーからもらい、`config/youtube.yaml: broadcast_id` に書く。
**URL を丸ごと貼ってよい**（`watch?v=` / `live/` / `youtu.be/` から動画 ID を自動で取り出す）。

```yaml
broadcast_id: "https://www.youtube.com/live/AbCdEfG1234"
```

**必ず伝えること：配信枠は配信を止めるたびに ID が変わる。配信のたびに `broadcast_id` を
更新しないとコメントが取れない。** API キー方式では `mine=true` が使えないため必須で、
空のままだとチャット取得だけ無効になって起動する。

### 5-4. API キーの検証（課金なし）

`videos.list` を叩くだけ。無料枠内で、Director には触れない。

```bash
source .env
curl -s "https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=<動画ID>&key=$YOUTUBE_API_KEY" | head -40
```

- `liveStreamingDetails.activeLiveChatId` が返る → コメント取得まで通る。
- `items: []` → 動画 ID が違う。
- `API key expired` / `keyInvalid` → キーを作り直す。
- `accessNotConfigured` → YouTube Data API v3 が有効になっていない。

**キーが URL に出るので、この curl はエージェントが直接実行せずユーザーに `!` で実行してもらうか、
`source .env` した上で変数のまま渡す**（上のコマンドは変数のままなので、そのまま実行してよい）。

---

## 6. TTS サーバー（OpenAI 互換）

音声合成は**このリポジトリの外**のサーバーを叩く。デーモンは
`POST {base_url}/v1/audio/speech`（JSON → wav）を使うだけで、**サーバーの起動も停止もしない。**
手順の詳細は `docs/setup.md` §4。

### 6-1. どのサーバーを使うか聞く

1. 既に OpenAI 互換の TTS サーバーがある → その URL（と鍵）を `config/stream.yaml: tts.base_url`
   と `.env: TTS_API_KEY` に設定するだけ。
2. ローカルで日本語の声を作りたい → **Irodori-TTS-Server** を立てる（6-2）。

### 6-2. Irodori-TTS-Server を立てる（希望する場合）

**このリポジトリの外**に置く。置き場所はユーザーに決めてもらう。

```bash
git clone https://github.com/Aratako/Irodori-TTS-Server.git <path-to-tts-server>
cd <path-to-tts-server>
uv sync --extra cu128     # AMD は --extra rocm、CPU のみは --extra cpu
cp .env.example .env
```

常駐起動（`run_in_background` か別ターミナル。ポートは `tts.base_url` と合わせる）：

```bash
uv run --no-sync python -m irodori_openai_tts --host 127.0.0.1 --port 8020
```

```bash
curl -s localhost:8020/health
curl -s localhost:8020/v1/models
```

- `/health` はモデルを読まずに返る。**最初の合成リクエストでモデルを読む**ので、
  1 発目だけ数十秒〜数分（HuggingFace のダウンロード込み）かかることを伝える。
- 実測：2 発目以降は 5.3 秒の音声で 1.8 秒。

### 6-3. 疎通（課金なし）

```bash
curl -s localhost:8020/v1/audio/speech -H 'Content-Type: application/json' -d '{
  "model":"irodori-tts","input":"こんにちは。テスト発話だよ。","voice":"none",
  "response_format":"wav","irodori":{"caption":"明るく元気な若い女性の声。"}
}' --output /tmp/tts-test.wav
ffprobe -hide_banner /tmp/tts-test.wav
```

wav が返れば OK。**Irodori-TTS-Server は OpenAI の `instructions` を見ない**ので、
キャラの `voice/tts.yaml` には `instructions_field: irodori.caption` を書く（§7）。

---

## 7. キャラクター

**`characters/<name>/` は `.gitignore` 済み**（git に載るのは `_default/` / `_example/` /
`README.md` だけ）。キャラの設定・画像・声はユーザーの資産として手元に置く。

雛形をコピーして作る。手順とチェックリストは `characters/README.md` に全部ある。

```bash
cp -r characters/_example characters/<name>
```

`_example/` の `<...>` を全部埋める。要点：

- `image.png`：最初のフレーム。ユーザーに用意してもらい `characters/<name>/image.png` に置く。
  16:9 で、頭・肩・両手・上半身が**余裕を持って**収まる構図。
- `visual.yaml`（英語）
  - `identity`：**`image.png` に映る外見を全て言葉で書き切る。**髪型・髪色・帽子・眼鏡・
    ヘッドホン・服・アクセサリー・座り方・机の上のもの。モデルは初期画像を持ち続けないので、
    毎回のプロンプトでこの全文が再送される。
    「最初の画像と同じ」のような**参照表現は効かないので使わない**。
    末尾は `Continue the current shot: the same ... with this exact face, hair, ... and outfit.` で締める。
  - `frame_rules`：**`image.png` に映る要素を具体名で列挙**し、それらが常にフレーム内に残ること、
    初期構図より寄らないこと、他の人物を出さないこと、画面に文字・字幕・UI・ロゴを出さないことを明記する。
    `_default` の汎用文は雛形なので**必ずキャラごとに具体化して上書きする**。
  - `default_scene`：初期の場面を**否定も含めて具体的に**書く（出したくないものも明記する）。
  - `style`：画風と照明。
- `voice/reference.wav`（10〜20 秒、単一話者、無音・BGM なし）をユーザーに用意してもらう。
  **TTS サーバーの `voices/<voice-id>.wav` にもコピーし**、`voice/tts.yaml: voice` にその ID を書く。
- `voice/tts.yaml`：`model`（`GET /v1/models` の ID）/ `voice` / `instructions_default` /
  `emotion_instructions`。Irodori-TTS-Server なら `instructions_field: irodori.caption` も。
  LoRA など**リポジトリ外のパスは `.env` に置いて `${VAR}` で参照する。**
- `character.md`（日本語・人格と口調ルール）、`topics.md`（話題 30 個以上）。

---

## 8. 動作確認（課金なし）

`config/stream.yaml` の `broadcast.enabled` が `false` であることを確認してから行う。

```bash
grep -n -A2 '^broadcast:' config/stream.yaml
```

```bash
h3 daemon start --character <name> --no-tts
h3 status
h3 daemon stop
```

- `h3 status` が JSON を返し、`character` が意図したキャラなら OK。
- `--no-tts` と `broadcast.enabled: false` により、TTS も compositor も Director も起動しない。
  **課金は発生しない。**
- 失敗したら `h3 log --tail 30` を読む。
- TTS まで確かめるなら `--no-tts` を外して起動し、`h3 status` の `tts` を見る
  （`ready` / `unreachable`。`unreachable` でもデーモンは起動する。それでも Director には繋がらない）。

最後に typecheck とテストも通しておく。

```bash
npm run typecheck && npm test
```

---

## 9. 完了報告と次の案内

ユーザーに次を報告する。

- 揃ったもの（node / ffmpeg / Chromium / TTS サーバーの URL と疎通 / `.env` のキー名 / `config/youtube.yaml`）
- まだ足りないもの、次にユーザーがやること
- **配信のたびに `config/youtube.yaml: broadcast_id` を更新する必要があること**
- fal の残高とセッション長の関係

そして次を案内する。

> 配信を始めるには `h3-stream-operator` skill を使います。
> Claude Code に「<キャラ名> で配信開始して」と言ってください。

**セットアップの一部として配信を始めない。** 送出（`broadcast.enabled: true`）を有効にするのも、
配信開始のタイミングでオペレーター側が行う。
