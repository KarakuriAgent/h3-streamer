# セットアップ（手動手順）

Claude Code なら `/h3-stream-setup` を実行すればエージェントがこの手順を対話的に進める。
ここは手で進める場合の同じ内容。設定値の意味は `docs/operations.md` §4、設計は `docs/SPEC.md`。

---

## 1. 前提

| 必要なもの | 確認 | 備考 |
|---|---|---|
| Node 24 / npm | `node -v` | ESM。24 未満は未検証 |
| ffmpeg | `ffmpeg -version` | 送出に使う。NVENC が使えると GPU エンコードになる |
| OpenAI 互換の音声合成サーバー | `curl <base_url>/v1/models` | 別プロセスで用意する（§4）。ローカルで自前ホストするなら Python + uv と NVIDIA GPU も |
| fal.ai の API キー | | Director の課金あり（§5） |
| YouTube Data API v3 のキー | | コメント取得・視聴者数 |
| YouTube のストリームキー | | RTMP 送出 |

---

## 2. インストール

```bash
npm install
npx playwright install chromium   # 送出に使う headless Chromium
npm run build:web                 # web/*.ts → overlay/*.js
npm link                          # h3 コマンドを PATH に入れる（任意。無ければ node bin/h3.js）
h3 --help
```

---

## 3. `.env`

```bash
cp .env.example .env
```

`FAL_KEY` / `YOUTUBE_API_KEY` / `RTMP_KEY` を書く。`.env` は `.gitignore` 済み。
書けたら `cut -d= -f1 .env` でキー名だけ確認する（値は表示しない）。

| キー | 取得元 |
|---|---|
| `FAL_KEY` | https://fal.ai/dashboard/keys |
| `YOUTUBE_API_KEY` | Google Cloud → API とサービス → 認証情報 → API キー（`docs/youtube-setup.md`） |
| `RTMP_KEY` | YouTube Studio → ライブ配信 → ストリームキー |

`RTMP_URL` は既定で `rtmp://a.rtmp.youtube.com/live2`。
OAuth 方式を使うときだけ `YOUTUBE_CLIENT_SECRET` / `YOUTUBE_TOKEN` を使う。
TTS サーバーが鍵を要求するなら `TTS_API_KEY` も書く。

設定 yaml に書いた `${VAR}` は環境変数（`.env` 込み）に展開される。
**このリポジトリの外を指すパス（TTS の LoRA など）は yaml に直書きせず、`.env` に置く。**

---

## 4. TTS サーバー（OpenAI 互換）

音声合成は**このリポジトリの外**にある OpenAI 互換 API を叩く。デーモンは
`POST {base_url}/v1/audio/speech` に
`{model, voice, input, instructions, response_format: "wav", speed}` を送り、返ってきた wav を使う。
デーモンはサーバーの起動も停止もしない（**先に立てておく**）。

接続先は `config/stream.yaml: tts.base_url`（既定 `http://127.0.0.1:8020`）。
キャラごとに変えるなら `characters/<name>/voice/tts.yaml: base_url` が優先される。
鍵が要るサーバーなら `.env` の `TTS_API_KEY`。

OpenAI の TTS でも、同じ API を話す自前サーバーでもよい。以下は日本語の声を
ローカルで作れる **Irodori-TTS-Server** を立てる場合の手順。

### 4-1. Irodori-TTS-Server を立てる

<https://github.com/Aratako/Irodori-TTS-Server>（**このリポジトリの外**に置く）。

```bash
git clone https://github.com/Aratako/Irodori-TTS-Server.git <path-to-tts-server>
cd <path-to-tts-server>
uv sync --extra cu128     # NVIDIA CUDA 12.8。AMD は --extra rocm、CPU のみは --extra cpu
cp .env.example .env

# 起動（常駐させる。ポートは h3-stream の tts.base_url と合わせる）
uv run --no-sync python -m irodori_openai_tts --host 127.0.0.1 --port 8020
```

```bash
curl -s localhost:8020/health     # モデルを読まずに設定だけ返す
curl -s localhost:8020/v1/models  # → {"data":[{"id":"irodori-tts",...}]}
```

`IRODORI_PRELOAD=false`（既定）だと**最初の合成リクエストでモデルを読む**ので、
1 発目だけ数十秒〜数分かかる（HuggingFace からのダウンロードを含む）。2 発目以降は
実測で 5.3 秒の音声に 1.8 秒。VRAM は 600M モデルで 5GB 程度を見ておく。

### 4-2. `voice` と `model` に何を書くか

| tts.yaml | 書く値 |
|---|---|
| `model` | `irodori-tts`（`IRODORI_MODEL_NAME` の既定。`GET /v1/models` で確認する） |
| `voice` | サーバーの `voices/` に置いた参照音声のファイル名（拡張子なし）。`voices/mychar.wav` なら `mychar`。参照音声を使わず instructions だけで作るなら `none` |
| `speed` | 0.25〜4.0 |

キャラの `voice/reference.wav`（10〜20 秒、単一話者、無音・BGM なし）を
**サーバーの `voices/<voice-id>.wav` にコピーする**（サーバーはこのリポジトリを読まない）。

### 4-3. instructions（話し方）と LoRA

Irodori-TTS-Server は OpenAI の `instructions` フィールドを見ない。話し方の指示は
**`irodori.caption`** で受ける。`voice/tts.yaml` にこう書くと、そこに入れて送られる。

```yaml
instructions_field: irodori.caption
```

キャラ専用に学習した LoRA アダプタがあるなら `extra_body` で渡す
（パスは**サーバー側から見えるパス**。環境変数にして yaml には直書きしない）。

```yaml
extra_body:
  irodori:
    lora_adapter: ${MY_CHARACTER_LORA}   # .env に絶対パスを書く
    cfg_scale_caption: 3.0
```

`${VAR}` が未設定なら空になり、その項目は送られない（= 指定なし）。
LoRA は**ベースのチェックポイントと対で学習されている**ので、LoRA を使うなら
サーバー側も対応するチェックポイントで起動する（`IRODORI_CHECKPOINT=<path-to-model.safetensors>`）。
サーバー側の環境変数（`IRODORI_*`）は Irodori-TTS-Server の `.env.example` を参照。

**要確認：** ここに書いた `voices/` の扱い・`irodori.caption`・`lora_adapter` は
Irodori-TTS-Server の README と実機（v3 600M + LoRA, 48kHz wav）で確認した範囲。
それ以外のチェックポイントやオプションの挙動は未検証。

### 4-4. 疎通の確認

```bash
curl -s localhost:8020/v1/audio/speech -H 'Content-Type: application/json' -d '{
  "model":"irodori-tts","input":"こんにちは。テスト発話だよ。","voice":"none",
  "response_format":"wav","irodori":{"caption":"明るく元気な若い女性の声。"}
}' --output /tmp/tts-test.wav
ffprobe -hide_banner /tmp/tts-test.wav
```

**サンプリングレートについて：** デーモンは返ってきた wav のヘッダをそのまま読むので
48kHz 固定ではない。ただし**配信経路まで検証済みなのは 48kHz wav のみ**。
他のレートを返すサーバーを使うときは compositor での再生まで確認すること。

---

## 5. fal（課金の確認）

- Director は **$0.02/秒**（プロモ価格、通常 $0.08）、**最低 $1.20/セッション**。1080p は 2 倍。
- **セッション上限は残高で決まる。** `session_info.max_session_seconds` は固定値ではなく
  「使った秒数だけ減る残枠」で、残高が少ないとセッションが数分で切れる（`docs/SPEC.md` §0.4）。
- 配信を始める前に https://fal.ai/dashboard/billing で残高を確認する。
  10 分配信したいなら最低でも $12 相当の枠が要る。

TTS は使うサーバー次第（自前ホストなら無料、商用 API なら従量）。YouTube Data API v3 は無料枠内。

---

## 6. YouTube

手順の詳細は `docs/youtube-setup.md`。API キー方式（推奨）の要点：

1. Google Cloud Console でプロジェクトを作り、**YouTube Data API v3** を有効化。
2. **認証情報 → API キー**を作成し、`.env` の `YOUTUBE_API_KEY` に書く。
   キーの制限は「アプリケーションの制限: なし」「API の制限: YouTube Data API v3 のみ」。
   （HTTP リファラー制限を付けるとサーバー側の `fetch` から使えなくなる。）
3. 設定ファイルを用意する。

   ```bash
   cp config/youtube.example.yaml config/youtube.yaml
   ```

4. YouTube Studio → **作成 → ライブ配信を開始**で配信枠を作る（**チャットを有効にする**）。
5. 配信の動画 ID を `config/youtube.yaml: broadcast_id` に書く。URL を丸ごと貼ってもよい
   （`watch?v=` / `live/` / `youtu.be/` から自動で取り出す）。

   ```yaml
   enabled: true
   auth: api_key
   broadcast_id: "https://www.youtube.com/live/AbCdEfG1234"
   ```

**配信枠は配信を止めるたびに ID が変わる。** 配信のたびに `broadcast_id` を更新すること。
API キー方式では `mine=true` が使えないため `broadcast_id` は必須（空だとチャット取得だけ無効になる）。

API キーの検証（課金なし。`videos.list` を叩くだけ）：

```bash
source .env
curl -s "https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=<動画ID>&key=$YOUTUBE_API_KEY" | head -40
```

`liveStreamingDetails.activeLiveChatId` が返れば、コメント取得まで通る。
`API key expired` / `keyInvalid` が返ったらキーを作り直す。

---

## 7. キャラクター

`characters/_example/` をコピーして作る。**`characters/<name>/` は `.gitignore` 済み**で、
git に載るのは `_default/` / `_example/` / `README.md` だけ。

```bash
cp -r characters/_example characters/<name>
```

雛形の `<...>` を全部埋める。手順とチェックリストは `characters/README.md`。

- `image.png`（自分で用意して `characters/<name>/image.png` に置く）：最初のフレーム。
  16:9 で、頭・肩・両手・上半身が**余裕を持って**収まる構図。
- `voice/reference.wav`（同じく自分で置く）：目的の声で 10〜20 秒、単一話者、無音・BGM なし。
  §4 のとおり TTS サーバーの `voices/` にもコピーし、`voice/tts.yaml: voice` にその ID を書く。
- `visual.yaml` の要点：
  - `identity`：**`image.png` に映っている外見を全て言葉で書き切る。**
    モデルは初期画像を持ち続けないので、毎回のプロンプトでこの全文が再送される。
    「最初の画像と同じ」のような参照表現は効かないので使わない。
  - `frame_rules`：**`image.png` に映る要素を具体名で列挙**し、それらが常にフレーム内に残ること、
    初期構図より寄らないこと、他の人物を出さないこと、画面に文字・UI を出さないことを明記する。
    `_default` の汎用文は雛形なので、必ずキャラごとに具体化して上書きする。
  - `default_scene`：初期の場面を**否定も含めて具体的に**書く
    （例：ラボの棚やフラスコは出さない、など出したくないものも明記する）。

---

## 8. 動作確認（Director に接続しないので課金なし）

`config/stream.yaml` の `broadcast.enabled` は `false` のままで行う。

```bash
h3 daemon start --character <name> --no-tts
h3 status
h3 daemon stop
```

`h3 status` が JSON を返し、`character` が意図したキャラなら OK。
失敗したら `h3 log --tail 30`。

TTS まで確かめたいときは `--no-tts` を外して起動し、`h3 status` の `tts` を見る
（`ready` / `unreachable`。`unreachable` でもデーモンは起動する）。
**`h3 speak` と compositor の起動（`broadcast.enabled: true` / `h3 broadcast start`）は
Director に接続して課金されるので、セットアップ段階では実行しない。**

---

## 9. 次

配信を始めるには `h3-stream-operator` skill を使う（Claude Code で「<キャラ名> で配信開始して」）。
手順は `.claude/skills/h3-stream-operator/SKILL.md`。
