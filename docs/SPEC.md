# h3-stream 設計仕様

MiniMax H3 Max Director（fal.ai）で AI キャラクターの YouTube Live 配信を行うシステムの設計書。
**現在の実装を正とする。** コマンドの使い方・設定値・エラー対応は `docs/operations.md`、
環境構築の手順は `.claude/skills/h3-stream-setup/SKILL.md` にある（このファイルでは重複させない）。

## 基本方針

- **キャラクター非依存の汎用システム。** キャラ固有の情報は `characters/<name>/` に全て閉じ込め、
  `--character` で切り替える。コード側にキャラ名や外見をハードコードしない。
- **AI 動画生成であることを活かす。** 普通の配信の再現ではなく、コメントに応じて背景・小道具・
  演出・仕草を自由に変える。守るのは「キャラの同一性」と「キャラが画面内に映り続けること」だけ。
- 配信の進行・コメント応答・状態監視は、**コーディングエージェントのセッション**（Claude Code /
  Codex / Gemini CLI など。人が手で回すこともできる）が行う。
- アプリ側は「配信を維持するデーモン」「エージェントが叩く CLI」「使い方を教える手順書」を提供する。
- **エージェントが止まってもデーモンは流れ続ける。**
- 実装言語：TypeScript（ESM, Node 24）。TTS は**外部の OpenAI 互換 音声合成 API**を叩く
  （サーバーはこのリポジトリの管理外。`.claude/skills/h3-stream-setup/SKILL.md` §6）。

---

## 0. Director の実測仕様（前提）

2026-09-09 に実物へ接続して確認した内容。ここに書かれた値がタイミングモデルと
セッション管理の根拠になる。生ログは `state/log/director-raw.jsonl`
（Director と往復した JSON を 1 行 1 件、`dir` が `in` / `out`）。

### 0.1 能力表（`session_info`）

接続直後に届く `session_info` が能力表そのもの。

```json
{"type":"session_info","app":"minimax-h3-max-director","protocol_version":1,
 "default_chunk_duration":10,"chunk_seconds":10,"min_chunk_duration":5,"max_chunk_duration":15,
 "continuation_context_frames":39,"continuation_playback_seconds":8.5,"fps":24,
 "audio_sample_rate":48000,"conditioning_audio_sample_rate":32000,
 "aspect_ratios":["16:9","9:16","1:1"],"resolutions":["480p","768p","1080p"],
 "max_session_seconds":372.466,"session_limit_scope":"effective",
 "audio_conditioning":true,"audio_behaviors":["replace","queue"],
 "max_audio_source_seconds":600.0,"prompt_context_segments":12,
 "default_memory":12,"min_memory":1,"max_memory":50,
 "client_message_types":["configure","ping","prompt","stop"],
 "server_message_types":["audio_applied","audio_exhausted","audio_pending","audio_rejected",
   "chunk","chunk_metrics","configured","deadline_missed","error","pong","prompt_applied",
   "prompt_pending","prompt_rejected","session_info","session_metrics","stream_exhausted"]}
```

### 0.2 メッセージ

クライアント → サーバーは `configure` / `prompt` / `ping` / `stop` の 4 つだけ。
セッションを畳むときは WebRTC を切る前に `{"type":"stop"}` を送る（`DirectorController.closeSession`）。

| type（サーバー → クライアント） | いつ来るか | 使い道 |
|---|---|---|
| `session_info` | 接続直後（`configure` の 5〜12 秒後）。以後も時々 | 上の能力表。`max_session_seconds` が唯一の正しいセッション上限 |
| `prompt_pending` → `prompt_applied` | 受付直後 → 生成に反映されたとき | `prompt_version` の追跡 |
| `configured` | 初回の `prompt_applied` と同時 | `has_initial_image` などの確認 |
| `audio_pending` → `audio_applied` | `audio_url` 付き `prompt` の直後 → キューに載ったとき | `audio_applied.remaining_seconds` / `queued_sources` でキュー残を**実測に上書き**する（`StreamState.syncAudioQueue`） |
| `chunk` | 1 チャンク生成完了ごと（およそ 5 秒に 1 回） | §0.3 |
| `chunk_metrics` | `chunk` と別に内訳だけ | 生ログにだけ残す |
| `deadline_missed` | 生成が再生に間に合わなかった | `{"late_by_seconds":0.227,"behavior":"freeze_video_and_silence_audio_until_ready"}` |
| `error` | 拒否されたとき | 理由は `message` ではなく **`code` + `error`**（`describeDirectorError()` が両方拾う） |
| `audio_exhausted` / `stream_exhausted` / `prompt_rejected` / `audio_rejected` / `session_metrics` / `pong` | — | ハンドラを用意してある。`stream_exhausted` はセッション終了として扱う |

### 0.3 `chunk` の読み方

```json
{"type":"chunk","chunk_index":3,"prompt_version":1,"generation_seconds":4.981,
 "playback_seconds":8.5,"requested_duration_seconds":10,"generated_frame_count":243,
 "trimmed_context_frames":39,"buffer_depth_seconds":1.604,"buffer_depth_chunks":2,
 "scheduling_lead_ms":6585.392,"scheduling_slack_ms":1604.499}
```

- `playback_seconds` は**累積の再生位置ではなく、そのチャンクが再生に足す秒数**。
  10 秒ぶん生成して重なりの 39 フレーム（24fps → 1.625 秒）を捨てるので 8.5 秒になる
  （最初のチャンクだけ重なりが無く 10.125 秒）。
- 生成先行分は **`buffer_depth_seconds`**（生成済みでまだ流れていない秒数）。実測 0〜2.5 秒。
  モデルは再生ぎりぎりで生成しており、何十秒も作り置きはしていない。

### 0.4 確定した事実

- **`prompt_version` はセッション内で必ず増やす。** 同じ値で `prompt` を送ると
  `{"code":"stale_prompt_version","error":"prompt_version must increase"}` が返り、
  **プロンプトが丸ごと捨てられる**（映像も音声も変化しない）。採番は `DirectorController` が持つ
  （`configure` で 1、`prompt` ごとに +1、張り直しで 1 に戻す）。
- **セッション上限は固定値ではなく残枠。** `max_session_seconds` は実測 372.466 秒
  （`session_limit_scope: "effective"`）で、約 115 秒使った次のセッションでは 243.341 秒に減っていた。
  **fal アカウントの残高（プロモ枠の残り）を反映しているとみられる。**
  `StreamState.sessionMaxSec()` は「設定の `session_max_min`」と「`max_session_seconds`」の
  短い方を返し、`h3 status` の `session_remaining_sec` と `h3 wait` の `session_ending` はこれに従う。
  上限が極端に短いときは `h3 status` の `warnings` に
  `director session limit is ...s (fal credit may be low)` が出る。
- **48kHz wav をそのまま `audio_url` に渡せる。リサンプル不要。** 48kHz / 6.72 秒の wav を渡して
  `audio_applied`（`duration_seconds` 一致・`audio_rejected` なし）を確認した。
  `conditioning_audio_sample_rate: 32000` はサーバー内部で変換される値であって入力要件ではない。
  上限は `max_audio_source_seconds: 600`。
- **Director が返す音声トラックは配信に使わない**（§5.1「配信音声の出どころ」）。
- **`voice_mode` は `tts` を維持する。** `audio_url` 無しでも音声トラックには音が乗っている
  （平均 -30.6dB）が、Director には声のリファレンスを渡す手段が無く、キャラの声の同一性
  （＝この配信の要）を担保できない。`native` は縮退用としてのみ残す。
- **headless Chromium で WMA セッション + canvas 合成 + MediaRecorder は安定して動く。**
  1280x720@30fps、webm チャンクは 500ms 設定に対し実測 531〜542ms、115 秒の送出で
  ffmpeg・ページとも再起動 0 回。**canvas の汚染は起きない**ので `h3 frame` の `toDataURL()` が通る。
  ただし **Chromium は `TMPDIR` が fuse/NTFS だと起動に失敗する**（`TMPDIR=/tmp` フォールバック済み）。

### 0.5 起動から画が出るまで（実測）

| 経過 | 出来事 |
|---|---|
| 0 秒 | `h3 daemon start`（Chromium 起動、ffmpeg 起動、compositor 接続） |
| 約 5 秒 | compositor が WMA セッションを開き `configure` 送信 |
| 5〜12 秒 | `session_info` + `prompt_pending` |
| 13〜19 秒 | `prompt_applied` + `configured` |
| 17〜20 秒 | 最初の `chunk` が届き、映像・音声が流れ始める |

最初のチャンクが来るまで `h3 frame` は黒画（20KB 前後の PNG）を返す。セッションを閉じたあとも同じ。
画が来ているかは PNG のサイズでも判断できる。

---

## 1. 全体構成

```
 [コーディングエージェントのセッション] ←― 手順書: h3-stream-operator/SKILL.md（運用手順）
          │  bash で CLI を実行      ←― characters/<name>/（キャラ設定・画像・声）
          ▼
 h3 CLI ──HTTP(127.0.0.1:8777)──▶ h3 daemon（常駐）
                                     ├─ director.ts    : Director セッションの状態・prompt 送信・張り直し
                                     ├─ tts.ts         : OpenAI 互換 TTS 呼び出し → fal storage アップロード
                                     ├─ chat.ts        : YouTube Live Chat ポーリング・未使用管理
                                     ├─ overlay.ts     : コメント一覧／強調／字幕を on_air_at で切替
                                     ├─ broadcaster.ts : headless Chromium の compositor → ffmpeg → RTMP
                                     ├─ falproxy.ts    : /api/fal/proxy（FAL_KEY はデーモンにだけ置く）
                                     └─ state.ts       : 状態・イベントキュー
 [OpenAI 互換 音声合成サーバー]（外部プロセス。既定 127.0.0.1:8020）
   POST /v1/audio/speech → wav
```

**Director は WebRTC（WMA）前提なので、セッションの実体はブラウザページが持つ。**
デーモンは `configure` / `prompt` を WebSocket でページへ送り、ページから返る Director の
サーバーメッセージを状態に反映する。ブラウザの fal クライアントは
`createFalClient({ proxyUrl: "/api/fal/proxy" })` を使うので、API キーはブラウザに渡らない。

デーモンが提供するページ：

| パス | 用途 |
|---|---|
| `/compositor` | 送出用。Director セッション + canvas 合成 + MediaRecorder。`h3 frame` のキャプチャ元 |
| `/viewer` | 開発用。合成せず素の映像だけを見る |
| `/overlay` | 透過オーバーレイ（OBS のブラウザソース用。通常の配信経路では使わない） |

**ビューワーは 1 枚だけ。** `/compositor` と `/viewer` を同時に開くと、後から開いた方が
Director セッションを持っていく。送出中に目視するときは `/compositor?record=0`。

---

## 2. ディレクトリ構成

```
h3-stream/
  README.md
  docs/               SPEC.md（この文書）/ operations.md / youtube-setup.md / agents/README.md / README.md（索引）
  bin/h3.js           CLI エントリ（npm link で PATH に入る）
  src/
    daemon/           index.ts / director.ts / tts.ts / chat.ts / overlay.ts / broadcaster.ts
                      state.ts / api.ts / prompt.ts / audio.ts / config.ts / env.ts
                      falproxy.ts / falstorage.ts / youtube-auth.ts
    cli/index.ts      h3 コマンド（デーモンに指示し JSON を返す薄いクライアント）
    shared/           デーモンとブラウザで共有する型（protocol.ts）
  web/                ブラウザ側 TS（esbuild で overlay/*.js にバンドル）
    compositor.ts / viewer.ts / overlay.ts
    lib/              director-session / media-stage / daemon-socket / overlay-state
                      overlay-view / overlay-draw / audio-mix / media-uplink
  characters/         キャラクター設定（_default と <name>/）。詳細は characters/README.md
  config/             stream.yaml / youtube.yaml（youtube.yaml は git 管理外）
  state/              used_comments.json / log/ / analysis/ / preview.flv（git 管理外）
  .claude/skills/     h3-stream-operator/SKILL.md（配信運用）/ h3-stream-setup/SKILL.md（環境構築）
  test/               node:test（タイミング計算・プロンプト組み立て）
```

`overlay/*.js` はビルド生成物。`web/` を変更したら `npm run build:web`。

---

## 3. 映像プロンプトとキャラクター設定

キャラ固有の情報は `characters/<name>/` に閉じ込める（`visual.yaml` / `image.png` /
`voice/tts.yaml` / `voice/reference.wav` / `character.md` / `topics.md`）。
`characters/_default/` の同名キーをキャラ側が上書きする。書き方は `characters/README.md`。

### 3.1 映像プロンプトの組み立て（`src/daemon/prompt.ts`）

```
[IDENTITY]   visual.yaml: identity      外見の不変条件。毎回全文
[FRAME]      visual.yaml: frame_rules   画面内担保の不変条件。毎回全文
[STYLE]      visual.yaml: style         画風
[SCENE]      visual.yaml: default_scene configure のときだけ
[DIRECTION]  --direction                エージェントの自由記述（英語）
[SPEECH]     She says: "<--text>"       speak のときのみ
```

各セクションは改行・連続空白を 1 スペースに畳んでから空白で連結する（`normalizeText`）。

**モデルが参照できるのは直前数秒の映像と過去プロンプト（`memory`）だけで、初期画像は持ち続けない。**
そのため見た目の固定は、`configure.image_url`（最初のフレーム）で開始したうえで、
**毎回のプロンプト先頭に外見を具体的な言葉で全文再記述**して行う。
「最初のフレームと同じ」「前と同じ」という参照表現は意味を持たないので使わない。

ドリフト対策：(1) 外見の全文再記述、(2)「キャラが常にフレーム内・顔が見える」を毎回明記、
(3) セッション張り直しで初期画像に戻す。映像プロンプトは英語（外見記述の再現性が安定する）、
セリフだけ日本語。

**direction の制約：**

- **不変条件（identity / frame_rules / style）はデーモンが必ず付け、エージェントは触らない。**
- **direction は自由。ただしキャラ本人の要素には触れない。版権もの（実在作品のキャラ・作品名・ブランド・実在人物）も出さない。** 版権の判定は blocklist では不可能なのでオペレーター（skill）が担う。 演出の対象は
  「環境・小道具・エフェクト・カメラ・彼女の表情と仕草」に限る。identity に含まれる要素
  （髪、キャップ、サングラス、ヘッドホン、服、アクセサリー、顔）を光らせる・色を変える・外す・
  付け替える演出は禁止。「キャップを光らせる」ではなく「背後にキャップのロゴのホログラムを出す」。
- 禁止語リスト（`config/stream.yaml: direction_blocklist`、部分一致・大文字小文字無視）に
  1 つでも当たると、`h3 speak` / `h3 direct` は **何もせずに**
  `{"ok":false,"error":"direction_blocked","hits":[...]}`（HTTP 422、終了コード 1）を返す。
  **TTS も走らず、Director にも送らず、`--comment-id` も使用済みにしない。**
- 場面を大きく変えたあとは、次の direction の先頭に現在の場面を一言添える
  （モデルは直前数秒しか参照しないため、場面の継続もエージェントが言葉で担保する）。

---

## 4. 手順書（skill）の位置づけ

手順書は素の Markdown で、どのコーディングエージェントでも人でも読んで従える
（Claude Code なら skill として自動で認識される）。

| 手順書 | 役割 |
|---|---|
| `.claude/skills/h3-stream-setup/SKILL.md` | 環境構築を対話的に完了させる。Director には接続しない（課金しない） |
| `.claude/skills/h3-stream-operator/SKILL.md` | 配信の運営。発話・演出・コメント返答・セッション再接続・終了 |

オペレーターに求めること（詳細は SKILL.md）：

1. 発話文（`--text`）は `characters/<name>/character.md` の人格で日本語。1 発話 25〜40 文字、最大 2 文。
2. `--direction` は英語。キャラ本人の外見を変える演出は書かない（§3.1）。
3. 常に 1〜2 発話（15〜25 秒）先行して音声を積み、キューを切らさない。
4. 同じコメントを二度使わない（`--comment-id` を必ず渡す）。
5. 生成できないコメントは謝罪も言い訳もせず `h3 comments skip` で黙って捨てる。
6. 見た目の崩れに気づいても自動でリセットしない（報告するだけ）。リセットは人の指示があったときだけ。

Codex には `AGENTS.md` から同じファイルを参照させる。

---

## 5. Director セッション

### configure（開始・再接続時）

```json
{"type":"configure","protocol_version":1,"prompt_version":1,
 "prompt":"<IDENTITY> <FRAME> <STYLE> <SCENE> <待機の一文>",
 "image_url":"<characters/<name>/image.png を fal storage にアップロードした URL>",
 "aspect_ratio":"16:9","resolution":"768p","memory":20}
```

### prompt（`h3 speak` / `h3 direct` ごと）

```json
{"type":"prompt","prompt_version":<前回より必ず大きい整数>,"prompt":"<組み立て済み>",
 "audio_url":"<TTS wav の URL>","audio_behavior":"queue","replan":true}
```

セッション上限・エラー時は同じ configure で張り直す（`image_url` は初期画像固定）。
張り直すと積んであった音声キューは失われ、映像は初期画像・`default_scene` の場面に戻る。
`h3 session restart` と `h3 reset` は同じ処理で、返り値の `trigger` だけが違う。

受信したメッセージは state に反映し、`h3 status` / `h3 wait` のイベント源にする（§0.2）。
届いた生 JSON は全て `state/log/director-raw.jsonl` に残す。

### 5.1 タイミングモデル

```
h3 speak 送信
  ├─ TTS 生成 + fal storage アップロード                          … 数秒
  ├─ prompt(audio_url, queue) → prompt_applied / audio_applied    … 約 2 秒
  ├─ 映像への反映：次に生成されるチャンクから
  │    ＝ buffer_depth_seconds（0〜2.5 秒）+ チャンク再生尺（8.5 秒） ≒ 10 秒
  ├─ 音声：キューに積まれている音声を流し切ってから（audio_applied.remaining_seconds）
  └─ YouTube 側の配信遅延（低遅延 約 10 秒 / 通常 約 30 秒）
```

- デーモンは `audio_queue_end_at`（音声キュー終端）と `generation_lead_sec`（生成先行分）を常時持つ。
  前者は `audio_applied.remaining_seconds` の実測で上書きし、後者は
  `buffer_depth_seconds + playback_seconds` の EMA で推定する（`estimateGenerationLead`）。
- `h3 speak` は `{duration_sec, on_air_at, queue_remaining_sec}` を返す。
  `on_air_at` = キュー終端 + 生成先行分。
- **オーバーレイの強調・字幕は `on_air_at` にデーモンが自動で切り替える。**
  エージェントは `--comment-id` を渡すだけでよい。
- 視聴者から見た体感：コメント投稿 → 返答が届くまで 30〜60 秒。人間の配信者と同程度として許容する。

#### 配信音声の出どころ（`audio_source`）

**Director が返す音声トラックはモデルが再合成したもので、渡した wav そのものではない。**

初回配信テスト（2026-09-09）のアーカイブを元 TTS wav と突き合わせた実測：

| 比較 | 元 TTS との波形相関 | 16kHz 以上の割合 |
|---|---|---|
| 元 TTS | 1.000 | 0.00025 |
| 送出コーデック経路のみ（WebAudio → Opus → AAC → YouTube AAC） | 0.999 | 0.00022 |
| 実配信音声（Director 経由） | **0.175** | **0.0** |

送出経路は波形をほぼ完全に保つので、劣化の原因は Director の音声再合成
（`conditioning_audio_sample_rate: 32000` と整合）。そこで配信に乗せる音声を
`config/stream.yaml: audio_source` で選べるようにしてある。

| 値 | 挙動 |
|---|---|
| `tts_direct`（既定） | Director の音声トラックは compositor でゲイン 0 にし、**口パクの条件付けにだけ**使う。配信音声は TTS の wav を compositor 内の WebAudio で直接再生する |
| `director` | Director の音声トラックをそのまま流す |

`tts_direct` の流れ：

```
h3 speak
  ├─ TTS → wav
  ├─ fal storage へアップロード → prompt(audio_url, queue)   … 口パクの条件付け
  └─ 同じ wav をデーモンが /audio/<id>.wav で配り、compositor へ
       {type:"play_audio", id, url, at_ms: on_air_at_ms + audio_offset_ms, duration_sec}
[compositor]
  fetch → decodeAudioData → AudioBufferSourceNode.start(when)
     when = AudioContext.currentTime + (at_ms − (performance.timeOrigin + performance.now()))/1000
```

- `at_ms` を過ぎて届いたら**遅れた分だけ頭を切って**すぐ鳴らす（頭から鳴らすと以降の発話が全部ずれる）。
  丸ごと過ぎていたら鳴らさない。
- `audio_applied.remaining_seconds` で on_air 推定が動いたら、**同じ `id` で `play_audio` を
  送り直して時刻を上書きする**（150ms 以上ずれたときだけ）。
- `h3 session restart` / `h3 reset` は `{type:"cancel_audio"}` で未再生の予約を全部捨てる。
- `audio_offset_ms` は口パクとのずれの微調整用（正で遅らせる）。

ローカル実測（`h3 audio test` で同じ wav を 12 秒間隔で 3 回、`broadcast.output: file`）：

| 再生 | 元 wav との波形相関 |
|---|---|
| 1 回目 | 0.9987 |
| 2 回目 | 0.9981 |
| 3 回目 | 0.9947 |

`audio_scheduled` は 3 本とも `starts_at_ms == at_ms`（誤差 0ms）。録音から測った再生間隔は
11.9909s / 11.9923s（指示は 12.000s）で誤差 −9.1ms / −7.7ms ＝ 約 −0.07%
（`AudioContext` の 48kHz クロックと壁時計の差）。実運用の先行 10〜30 秒でも 25ms 以内に収まる。

口パクとのずれを実測したいときは `broadcast.record_director_audio: true`。compositor が
ゲインより手前の `tap` から Director 音声だけを別の MediaRecorder で録って `/ws/director-audio` へ流し、
デーモンが `state/analysis/director-audio-<run>-s<seq>.webm`（録画開始の絶対時刻は同名の `.meta.json`）に
保存する。同時に鳴らす指示が `state/analysis/tts-schedule-<run>.jsonl` に残る。解析専用で送出には影響しない。

---

## 6. TTS（OpenAI 互換 音声合成 API）

- `src/daemon/tts.ts` は**汎用クライアント**。サーバーはこのリポジトリの管理外で、
  デーモンは起動も停止もしない（立て方は `.claude/skills/h3-stream-setup/SKILL.md` §6）。
- 合成：`POST {base_url}/v1/audio/speech`
  （JSON `{model, voice, input, instructions?, response_format:"wav", speed?}` → `audio/wav`）。
- 疎通：起動時に `GET {base_url}/v1/models`（無ければ `GET {base_url}/health`）。
  **失敗してもデーモンの起動は続け**、`h3 status` の `tts` に `unreachable` を出す。
- 接続先と声は `characters/<name>/voice/tts.yaml`
  （`base_url` / `api_key` / `model` / `voice` / `speed` / `instructions_default` /
  `emotion_instructions`）。鍵は `.env` の `TTS_API_KEY` が優先される。
- `--emotion` は `emotion_instructions` で instructions に変換する
  （`instructions_default` + `emotion_instructions[emotion]`）。
- サーバー独自の入力が要るときは `instructions_field`（instructions を入れるキーのドット表記）と
  `extra_body`（リクエスト本文にマージされる追加フィールド）で渡す。
  yaml の `${VAR}` は環境変数に展開され、空になった値は送られない。
- 返ってきた wav の**再生秒数とサンプリングレートはヘッダから読む**（48kHz 決め打ちにしない）。
  生成 wav を fal storage にアップロードして `audio_url` に渡す（リサンプル不要。§0.4）。
- 実測（Irodori-TTS-Server v3 600M + LoRA, RTX 系 GPU）：5.3 秒の音声で生成 1.8 秒。
  **配信で検証済みなのは 48kHz wav の経路のみ。**他のサンプリングレートを返すサーバーは
  compositor（WebAudio は 48kHz で動く）まで含めた確認が要る。

---

## 7. コメント取得（YouTube）

- YouTube Data API v3。`fetch` で直接叩く（SDK 依存なし）。認証は API キー方式（推奨）と OAuth 方式。
  手順は `docs/youtube-setup.md`。
- API キー方式は `mine=true` が使えないため `config/youtube.yaml: broadcast_id` が必須。
  **配信枠は配信を止めるたびに ID が変わるので、配信のたびに更新する。**
- `videos.list` → `liveChatId` → `liveChatMessages.list` を `pollingIntervalMillis` に従いポーリング。
- 除外：NG ワード、URL のみ、同一ユーザーの直近 3 件以内の連投。配信者本人は
  `include_owner_comments: false` のときだけ除外する（既定は拾う）。
- `ignore_comments_before_start: true` なら、デーモン起動時刻より前のコメントは未使用バッファに入れない
  （初回ポーリングが過去のコメントを全部返すため）。
- 使用済み ID は `state/used_comments.json` に永続化する。

---

## 8. 合成と送出（自前。OBS は使わない）

```
[headless Chromium (Playwright)]
   /compositor
     ├─ fal WMA セッション（video/audio トラック受信）  ← /api/fal/proxy 経由で認証
     ├─ <video> → canvas（既定 1280x720）に描画 + コメント一覧・強調・字幕を合成
     ├─ 音声：WebAudio でミックス（Director 音声 + tts_direct の直接再生）
     ├─ MediaRecorder(canvas.captureStream(30) + audio, webm/vp8+opus, 500ms)
     └─ バイナリ WebSocket（/ws/media）→ デーモン
[daemon] broadcaster.ts
   ffmpeg -i pipe:0 -c:v h264_nvenc -preset p4 -b:v 4500k -maxrate 4500k -bufsize 9000k \
          -g 60 -r 30 -pix_fmt yuv420p -c:a aac -b:a 160k -ar 48000 -ac 2 \
          -f flv rtmp://a.rtmp.youtube.com/live2/<RTMP_KEY>
```

- 制御（configure / prompt）とイベント（chunk / audio_exhausted / error など）も同じ WebSocket で中継する。
- オーバーレイ（コメント一覧・強調・字幕）はデーモンから WS で受け取って canvas に描画する。
  切替タイミングは `on_air_at`（§5.1）。
- 音声ミキサー（`web/lib/audio-mix.ts`）は `Director tracks → tap → directorGain → destination` と
  `play_audio の wav → ttsGain → destination` の 2 系統。**無音ソースを常時混ぜてあるので
  音声トラックは絶えない**（Director 未接続でも送出が止まらない）。
- エンコーダは `encoder: auto` なら起動時に NVENC を 1 本試して判定し、駄目なら
  `libx264 -preset veryfast -tune zerolatency` に落とす。
- **ffmpeg が落ちたら自動で張り直す。** webm はヘッダが先頭チャンクにしか無く途中から読ませられないので、
  media の WebSocket を切ってページに録り直させ、その新しい接続で ffmpeg を起動する（実測で復帰まで約 2 秒）。
- **ページが落ちたら 3 秒後に開き直す。**
- `h3 frame` はこの canvas を PNG 化して返す（オーバーレイ込み）。
- Chromium 起動フラグ：`--autoplay-policy=no-user-gesture-required`、
  `--use-fake-ui-for-media-stream`。`TMPDIR` が fuse/NTFS のときは `TMPDIR=/tmp` で 1 度だけやり直す。

---

## 9. 費用

- Director $0.02/秒（プロモ、通常 $0.08）、最低 $1.20/セッション、1080p は 2 倍。
- **セッション上限は残高で決まる**（§0.4）。残高が少ないとセッションがすぐ切れる。
- TTS は外部サーバー次第（自前ホストなら無料、商用 API なら従量）。YouTube Data API v3 は無料枠内。
