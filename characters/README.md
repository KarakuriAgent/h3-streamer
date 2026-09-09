# characters/ — キャラクター設定

キャラ固有の情報は全てこのディレクトリに閉じ込める。**コード側にキャラ名や外見をハードコードしない。**
`h3 daemon start --character <name>` で `characters/<name>/` が読み込まれる。
プロンプトの組み立て方は `docs/SPEC.md` §3.1。

**`characters/<name>/` は `.gitignore` 済み。** git に載るのは `_default/` と `_example/` と
この README だけで、キャラの設定・画像・声はインスタンス固有の資産として各自の手元に置く。

## ディレクトリ構成

```
characters/
  _default/            # 全キャラ共通の既定値。各キャラのファイルが同名キーを上書きする
    visual.yaml        # style / default_scene / frame_rules の汎用文（identity は各キャラ必須）
    tts.yaml           # TTS の既定値（model / emotion → instructions 変換表など）
  _example/            # 雛形。cp -r して新しいキャラを作る（git 管理内）
  <name>/              # 実際のキャラ（git 管理外）
    character.md       # 人格設定書（配信オペレーター向け・日本語）。発話文はこれに従って書く
    topics.md          # コメントが無いときの話題ヒント（30 個以上）
    visual.yaml        # identity / frame_rules / style / default_scene（Director 向け・英語）
    image.png          # 最初のフレーム。16:9 推奨、キャラ全身が余裕を持って収まる構図
    voice/
      reference.wav    # 声のリファレンス（10〜20 秒、単一話者、無音・BGM なし）
      tts.yaml         # OpenAI 互換 TTS API の接続先・model・voice・instructions
```

## 新しいキャラを追加する手順

1. **フォルダを作る**

   ```bash
   cp -r characters/_example characters/<name>
   ```

   `_example/` の各ファイルは `<...>` のプレースホルダと書き方のコメントだけが入っている。
   全部埋める。`image.png` と `voice/reference.wav` は雛形に含まれないので自分で用意して置く。

2. **`image.png` を用意する**
   最初のフレームであり、`visual.yaml` の identity / frame_rules はこの画像の内容を言葉にしたもの。
   16:9 で、頭・肩・両手・上半身が**余裕を持って**収まる構図にする（ギリギリだと崩れやすい）。

3. **`visual.yaml` を書く（英語）**
   - `identity`：**image.png に映っている外見を全て言葉で書き切る。** 髪型・髪色・帽子・眼鏡・
     ヘッドホン・服・アクセサリー・座り方・机の上のもの。モデルは初期画像を持ち続けないため、
     毎回のプロンプトでこの全文が再送される。「最初の画像と同じ」のような参照表現は**効かないので使わない**。
     末尾は "Continue the current shot: the same ... with this exact face, hair, ... and outfit." で締める。
   - `frame_rules`：**image.png に映っている要素を具体名で列挙**し、それらが常にフレーム内に残ること、
     初期構図より寄らないこと、他の人物を出さないこと、画面上に文字・UI を出さないことを明記する。
     `_default` の汎用文は雛形であり、**必ずキャラごとに具体化して上書きする**。
   - `style`：画風と照明。`default_scene`：初期の場面。
   - identity / frame_rules はデーモンが毎回プロンプト先頭に付ける不変条件で、オペレーターは触らない。
     `--direction` でこれらの要素を変える演出（髪を光らせる、帽子を外す等）は禁止（SPEC §3.1）。

4. **声を用意する**
   - `voice/reference.wav`：目的の声で 10〜20 秒、雑音・BGM なしの単一話者。
     **TTS サーバー側の参照音声置き場にもコピーする**（Irodori-TTS-Server なら
     `voices/<voice-id>.wav`）。デーモンはこのファイルをサーバーに送らない。
   - `voice/tts.yaml`：`base_url` / `model`（`GET {base_url}/v1/models` の ID）/ `voice`
     （サーバー側のボイス ID）/ `speed` / `instructions_default` / `emotion_instructions`。
     `emotion_instructions` は `_default/tts.yaml` にマージされるので、変えたい感情だけ書けばよい。
   - サーバーが OpenAI の `instructions` を見ない場合は `instructions_field` に入れ先を書く
     （Irodori-TTS-Server は `irodori.caption`）。LoRA などサーバー固有の指定は `extra_body`。
   - **リポジトリの外を指すパスは yaml に直書きせず、`.env` に置いて `${VAR}` で参照する。**
     未設定の `${VAR}` は空になり、その項目は送られない。
   - サーバーの立て方は `.claude/skills/h3-stream-setup/SKILL.md` §6。

5. **`character.md` を書く（日本語）**
   プロフィール、世界観、性格、**口調ルール**（一人称・語尾・口癖・1 発話 25〜40 文字）、
   **コメント主の呼び方**、**NG 事項**、セリフ例。配信オペレーター（エージェントでも人でも）は
   これを読んで発話文を書くので、「こう書け」という具体的な指示の形で書く。
   抽象的な性格描写だけでは足りない。

6. **`topics.md` を書く（日本語）**
   コメントが無いときの話題を 30 個以上。設定由来のものと雑談を混ぜる。
   映像で見せられる話題には direction のヒントを添える。

7. **動作確認**

   `h3 speak` は Director セッションに接続するので **fal の課金が発生する**（$0.02/秒、
   最低 $1.20/セッション）。見た目の確認までやるときだけ実行する。

   ```bash
   h3 daemon start --character <name>
   h3 status
   h3 speak --text "テスト発話だよ" --direction "She waves at the camera with a small smile." --emotion happy
   h3 frame --out /tmp/f.png     # 保存した画像を開き、見た目が image.png と一致しているか確認
   ```

## チェックリスト

- [ ] `identity` に image.png の外見要素が漏れなく書かれている
- [ ] `frame_rules` が image.png の要素を具体名で列挙している
- [ ] `visual.yaml` は英語、`character.md` / `topics.md` は日本語
- [ ] `character.md` に 1 発話の文字数・一人称・語尾・NG が明記されている
- [ ] `voice/reference.wav` が単一話者・無音区間なし、TTS サーバーの `voices/` にも置いた
- [ ] `voice/tts.yaml` に絶対パスを直書きしていない（`${VAR}` + `.env`）
- [ ] `topics.md` が 30 個以上ある
