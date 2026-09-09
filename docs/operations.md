# 運用リファレンス（コマンド・設定・エラー）

`h3` コマンド、設定ファイル、エラーの意味、トラブルシュートをまとめる。
ここは参照資料。**手順書ではない。**セットアップの手順は
`.claude/skills/h3-stream-setup/SKILL.md`、配信中の判断手順は
`.claude/skills/h3-stream-operator/SKILL.md`、設計は `docs/SPEC.md`。

---

## 1. 起動と停止

```bash
h3 daemon start --character <name>
# → {"ok":true,"character":"<name>","url":"http://127.0.0.1:8777", ...}
h3 status
h3 daemon stop
```

1. `broadcast.enabled: true` なら、デーモンが headless Chromium で
   **http://127.0.0.1:8777/compositor** を開く。ここで Director セッションが開き、
   映像とオーバーレイが canvas に合成されて RTMP へ流れ始める。
   合成結果は同じ URL を普通のブラウザで開けば目視できる
   （**送出中は `?record=0` を付ける**。付けないと送出が二重になる）。
2. 送出しないとき（`broadcast.enabled: false` かつ `preview: false`）は、ブラウザで
   **http://127.0.0.1:8777/viewer** を開くと Director セッションが開く。
   合成せず素の映像だけを見る開発用のページ。
3. 以後はオペレーターが `h3` コマンドで進行する。

**ビューワーは 1 枚だけ。** `/compositor` と `/viewer` を同時に開くと、後から開いた方が
Director セッションを持っていく。

`--no-tts` を付けると起動時の TTS 疎通確認をしない（`h3 status` の `tts` は `skipped`）。

---

## 2. コマンド一覧

| コマンド | 説明 |
|---|---|
| `h3 daemon start [--character <name>] [--no-tts]` | デーモンをデタッチ起動。既に起動中なら何もしない |
| `h3 daemon stop` | 全停止 |
| `h3 status` | 経過時間・視聴者数・キュー残・セッション残り・直近メッセージ・直近エラー・`broadcast`・`youtube.chat_state`・`audio`・`warnings` |
| `h3 comments [--limit N]` | 未使用コメント（新しい順）。取得しても使用済みにはならない |
| `h3 comments skip --id ID [--reason "…"]` | 発話せずに使用済みにする（生成できないコメントを黙って捨てる） |
| `h3 speak --text "…" [--direction "…"] [--emotion happy] [--comment-id ID]` | TTS → fal storage → Director に prompt + audio。`--emotion` は `voice/tts.yaml` の `emotion_instructions` のキー |
| `h3 direct --direction "…"` | 音声なしで映像演出だけ変える |
| `h3 wait [--timeout 60]` | 次のイベントまでブロック |
| `h3 overlay [--highlight ID] [--subtitle "…"] [--comments on\|off]` | オーバーレイ表示の更新 |
| `h3 session restart [--reason "…"]` | セッション上限・エラー時に初期画像で張り直す |
| `h3 reset [--reason "…"]` | 見た目が崩れたときに映像を初期画像・default_scene へ戻す（中身は restart と同じ） |
| `h3 frame [--out path.png]` | 現在フレームを PNG 保存（見た目崩れの確認用） |
| `h3 broadcast status\|start\|stop` | 送出（Chromium + ffmpeg）の状態確認・開始・停止。デーモンは動かしたまま |
| `h3 audio test --wav path [--at-ms N \| --delay-ms N]` | 任意の wav を compositor に直接再生させる（配信音声の経路とタイミングの確認用） |
| `h3 log [--tail N]` | 直近ログ |
| `h3 youtube auth` | YouTube OAuth フロー（`auth: oauth` のときだけ） |

全コマンドが JSON を標準出力に返す。成功で終了コード 0、失敗で 1（`{"ok":false,"error":...}`）。

### `h3 wait` が返すイベント

`new_comment` / `queue_low` / `session_ending` / `session_ended` / `queue_empty` / `error` / `timeout`。

- **返したイベントは消える**（キュー）。
- 同じ内容の `error` は 1 度しか積まれない。
- `elapsed_sec` は返した時点のデーモン経過秒。

### セッションの張り直し

`h3 session restart` と `h3 reset` は同じ処理で、返り値の `trigger` だけが違う。
どちらも積んであった音声キューは失われるので、`queue_cleared: true` と
`queue_lost_sec`（失った秒数）を返す。オーバーレイのコメント一覧と強調は残り、
まだ流れていない字幕の予約だけ捨てる。**直後に 2 発話ぶん積み直すこと。**

---

## 3. エラー

主な `error` の値と対応。

| `error` | 意味 | 対応 |
|---|---|---|
| `direction_blocked` | `--direction` に禁止語がある（HTTP 422）。**何も実行されていない**（TTS も送信もコメント消費もなし） | `hits` の語を消して書き直し再実行。無理なら `h3 comments skip` |
| `tts_unavailable` | TTS サーバーに繋がらない（`h3 status` の `tts` が `unreachable`） | `curl {tts_base_url}/v1/models` で疎通を見る。そのコメントは使用済みになっていない |
| `tts_failed` | TTS サーバーが HTTP エラーを返した（読めない文字など） | 文面を平易にして再試行。駄目なら skip |
| `viewer_not_connected` | compositor / viewer ページが繋がっておらず Director に何も送れない | `h3 broadcast status` → 落ちていれば `h3 broadcast start` |
| `fal_key_missing` | デーモンに `FAL_KEY` が無い | 配信は始められない。`.env` を確認 |
| `comment_already_used` | そのコメントは既に使用済み（speak 済み・skip 済み） | 次のコメントへ |
| `session_ended` | Director セッションが死んでいる（`reason` に理由）。**発話は送られず、TTS もコメント消費も起きていない** | 下記 |
| `daemon_unreachable` | デーモンが落ちている／起動していない | `h3 daemon start` |

### `session_ended`

Director セッションが死んだとき（compositor の data channel 切断 / `stream_exhausted` /
60 秒 chunk が来ない）に `h3 wait` が返す。以後 `h3 speak` / `h3 direct` は
`{"ok":false,"error":"session_ended","reason":…}` を返し、TTS もコメントも消費しない。
復帰は `h3 session restart` / `h3 reset`。

**`reason` が `stream_exhausted` の場合や、`h3 status` の `warnings` に
`director session limit is ...s (fal credit may be low)` が出ている場合は fal の残高切れの可能性が高い**
（残高が無いと張り直しても同じことが起きる）。fal のダッシュボードで残高を確認する。

---

## 4. 設定

### `config/stream.yaml`

解像度・チャンク長・キュー閾値・セッション上限・ポート・TTS・YouTube・`broadcast`・
`direction_blocklist` をまとめて持つ。主なキー：

| キー | 既定 | 意味 |
|---|---|---|
| `resolution` / `aspect_ratio` | `768p` / `16:9` | Director の出力 |
| `chunk_seconds` | 10 | Director のチャンク長（再生に足されるのは 8.5 秒） |
| `memory` | 20 | Director の過去プロンプト保持数（1〜50） |
| `queue_low_sec` | 12 | 音声キュー残がこれ未満で `h3 wait` が `queue_low` を返す |
| `lead_target_sec` | 18 | 先行の目安（生成先行 10 秒 + 1 発話 8 秒） |
| `session_max_min` | 6 | セッション上限のガード。実際は `session_info.max_session_seconds` と短い方が使われる |
| `restart_warn_min` | 1 | 残りこれ以下で `h3 wait` が `session_ending` を返す |
| `voice_mode` | `tts` | `tts` \| `native`（native は縮退用） |
| `audio_source` | `tts_direct` | 配信に乗せる音声の出どころ（`tts_direct` \| `director`） |
| `audio_offset_ms` | 0 | `tts_direct` の再生時刻の補正（正で遅らせる） |
| `ignore_comments_before_start` | true | デーモン起動時刻より前のコメントを捨てる |
| `endpoint` | `minimax/h3-max/director` | fal のエンドポイント |
| `ports.api` / `ports.host` | 8777 / 127.0.0.1 | CLI 向け API・ビューワー・オーバーレイ |
| `tts.base_url` | `http://127.0.0.1:8020` | OpenAI 互換 音声合成 API の接続先。キャラの `voice/tts.yaml: base_url` が優先される |
| `tts.request_timeout_sec` / `tts.ping_timeout_sec` | 120 / 5 | 合成 1 回 / 起動時の疎通確認のタイムアウト |
| `direction_blocklist` | — | 当たった direction は送信をブロックする。**誤爆すると発話が止まる**ので、演出として普通に書きたくなる語は入れない |

`broadcast` セクション：

| キー | 既定 | 意味 |
|---|---|---|
| `enabled` | false | true で headless Chromium + ffmpeg を起動して送出する |
| `preview` | false | `enabled: false` でも Chromium だけ起動して合成を回す（ffmpeg 無し） |
| `output` | `rtmp` | `rtmp` \| `file`（file はローカル確認用に `file_path` へ書く） |
| `rtmp_url` | `rtmp://a.rtmp.youtube.com/live2` | ストリームキーは `.env` の `RTMP_KEY` |
| `file_path` | `./state/preview.flv` | `output: file` の出力先 |
| `encoder` | `auto` | `auto` \| `nvenc` \| `x264`（auto は起動時に NVENC を 1 本試す） |
| `video_bitrate_k` / `audio_bitrate_k` | 4500 / 160 | |
| `fps` / `width` / `height` | 30 / 空 / 空 | 空なら `resolution` から決める（768p/720p→1280x720, 1080p→1920x1080） |
| `headless` / `gpu` | true / false | `gpu: true` で Chromium に GPU を使わせる |
| `chunk_ms` | 500 | MediaRecorder の timeslice |
| `record_director_audio` | false | Director 音声だけ別録りして `state/analysis/` に残す（口パクのずれ計測用） |

### `config/youtube.yaml`

git 管理外。`cp config/youtube.example.yaml config/youtube.yaml` して編集する。
`enabled` / `auth`（`api_key` \| `oauth`）/ `broadcast_id` / `poll_interval_ms` / `ng_words` /
`include_owner_comments`（既定 true。false のときだけ配信者本人のコメントを除外する）。
`stream.yaml` の `youtube:` より**こちらが優先される**。詳細は `docs/youtube-setup.md`。

**`broadcast_id` は配信を止めるたびに変わる。** 配信のたびに書き換えること。

### `.env`

`FAL_KEY` / `RTMP_KEY` / `RTMP_URL` / `YOUTUBE_API_KEY`（`auth: api_key`）/
`YOUTUBE_CLIENT_SECRET` / `YOUTUBE_TOKEN`（`auth: oauth`）/ `TTS_API_KEY`（鍵が要る TTS サーバーのとき）。
雛形は `.env.example`。

yaml に書いた `${VAR}` は環境変数（`.env` 込み）に展開される。
**このリポジトリの外を指すパスは設定ファイルに直書きせず、環境変数にする。**

### `characters/<name>/`

`visual.yaml`（`identity` / `frame_rules` / `style` / `default_scene`。`characters/_default/visual.yaml` を
継承してキャラ側で上書き）、`voice/tts.yaml`（`base_url` / `api_key` / `model` / `voice` / `speed` /
`instructions_default` / `emotion_instructions`、必要なら `instructions_field` と `extra_body`）、
`character.md`、`topics.md`、`image.png`、`voice/reference.wav`。
`_example/` が雛形。書き方は `characters/README.md`。

**`characters/<name>/` は `.gitignore` 済み**（`_default` / `_example` / `README.md` だけ追跡する）。
キャラの設定・画像・声はインスタンス固有の資産として各自の手元に置く。

---

## 5. ローカル確認

```yaml
broadcast:
  enabled: true
  output: file            # rtmp の代わりに state/preview.flv に書く
```

`FAL_KEY` が無くても黒画面 + オーバーレイで動くので、`h3 overlay --subtitle "テスト"` が
映像に乗ることを `ffprobe state/preview.flv` で確認できる。
`enabled: false` + `preview: true` なら ffmpeg を起動せず Chromium だけ動かす（プレビューモード）。

配信音声の経路だけを試すには `h3 audio test --wav <path> --delay-ms 3000`。
Director セッションも fal storage も通らないので、送出中でなくても音とタイミングを確かめられる。

---

## 6. トラブルシュート

| 症状 | 対応 |
|---|---|
| Chromium が起動直後に落ちる | `TMPDIR` が fuse/NTFS だと落ちる。デーモンが `TMPDIR=/tmp` で 1 度だけやり直す（ログに警告が出る） |
| 送出が二重になる | 送出中に `/compositor` を素で開いた。`?record=0` を付ける |
| 映像が止まる／Director が反応しない | `h3 status` の `session_state` と `viewer_connected` を確認 → `h3 session restart` |
| セッションがすぐ切れる | fal の残高切れの可能性（`warnings` を読む） |
| コメントが取れない | `h3 status` の `youtube.chat_state`。`waiting` は配信枠がまだ `live` でないだけ（自動復帰する）。`stopped` は `reason` を読む |
| 声が濁る | `audio_source` が `director` になっていないか確認する（既定は `tts_direct`） |
| 口パクと声がずれる | `config/stream.yaml: audio_offset_ms` を調整（正で遅らせる）。実測手順は `docs/SPEC.md` §5.1 |
| `h3 frame` が黒画（20KB 前後） | 最初のチャンクがまだ来ていない（起動から 17〜20 秒）か、セッションが閉じている |

---

## 7. 開発

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test（タイミング計算とプロンプト組み立て）
npm run build:web   # ブラウザバンドルの再生成（web/ を触ったら実行する）
npm run daemon -- --character <name>  # デーモンをフォアグラウンドで直接起動
```

`overlay/*.js` はビルド生成物なので git 管理外。**`web/` を変更したら `npm run build:web`。**

ブラウザ側は役割ごとに `web/lib/` に分けてある（合成ページを後から足せるようにするため）：

| モジュール | 役割 |
|---|---|
| `web/lib/director-session.ts` | fal の WMA セッションを 1 つ保持する（open / send / close） |
| `web/lib/media-stage.ts` | 届いたトラックを 1 本の MediaStream にまとめて `<video>` に流す。合成の入力・`h3 frame` のキャプチャ元 |
| `web/lib/daemon-socket.ts` | デーモンとの WebSocket（自動再接続、型付き送受信） |
| `web/lib/overlay-state.ts` | オーバーレイのメッセージを 1 つの状態に畳み込む（DOM も canvas も共有） |
| `web/lib/overlay-view.ts` | コメント一覧・強調・字幕の描画（DOM だけ、通信を知らない） |
| `web/lib/overlay-draw.ts` | 同じ見た目を canvas に描く（compositor 用） |
| `web/lib/audio-mix.ts` | 送出音声のミキサー。無音ソースを常時混ぜて音声トラックを絶やさない。`tts_direct` の直接再生と Director 音声のゲイン制御もここ |
| `web/lib/media-uplink.ts` | MediaRecorder → バイナリ WS（`/ws/media`）。切断時は録り直して繋ぎ直す |
| `web/viewer.ts` / `web/overlay.ts` / `web/compositor.ts` | 上記を繋ぐだけのページ本体 |

秘密情報（`FAL_KEY`, `RTMP_KEY`, `config/client_secret.json`, `state/youtube_token.json`）は
コミットしない。
