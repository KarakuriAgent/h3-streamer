# h3-stream

MiniMax H3 Max Director（fal.ai）で AI キャラクターの YouTube Live 配信を行うシステム。
配信の進行・コメント応答・状態監視は **CLI エージェントのセッション**が行い、映像生成・TTS・
RTMP 送出・コメント取得は常駐デーモンが担当する。

## skill（依頼されたら必ず起動する）

| 依頼 | skill |
|---|---|
| 「配信開始」「配信して」「配信を止めて」など配信の操作 | `h3-stream-operator`（`.claude/skills/h3-stream-operator/SKILL.md`） |
| 「セットアップ」「初期設定」「環境構築」 | `h3-stream-setup`（`.claude/skills/h3-stream-setup/SKILL.md`） |

**手順書を読まずに `h3` コマンドを叩かない。**
配信 skill に入ったら、対象キャラの `characters/<name>/character.md` と `topics.md` を必ず読み、
以後その人格で発話文を書く（キャラ名が指定されなければ `ls characters/` の候補から選ぶ。
`_default` と `_example` はキャラではない）。

守るべき要点（詳細は SKILL.md）：

- 発話文（`--text`）は日本語・キャラの人格・1 発話 25〜40 文字、最大 2 文。
- 映像演出（`--direction`）は**英語**で書く。
- **キャラ本人の外見（髪・帽子・眼鏡・ヘッドホン・服・アクセサリー・顔）を変える演出は禁止。**
  演出は環境・小道具・エフェクト・カメラワークと、表情・仕草で行う。
- 外見の不変条件（identity / frame_rules）はデーモンが毎回自動で付ける。エージェントは書かない。
- 常に 1〜2 発話（15〜25 秒）先行して音声を積む。同じコメントは二度使わない。

## ドキュメント

- 設計：`docs/SPEC.md`
- コマンド・設定・エラー：`docs/operations.md`
- セットアップ：`docs/setup.md` ／ YouTube 連携：`docs/youtube-setup.md`
- キャラクターの追加：`characters/README.md`

```
src/daemon/   常駐プロセス（Director セッション・TTS・チャット取得・オーバーレイ・RTMP・状態）
src/cli/      h3 コマンド（デーモンに指示し JSON を返す薄いクライアント）
web/          ブラウザ側（compositor / viewer / overlay）。変更したら npm run build:web
characters/   キャラクター設定（1 キャラ 1 フォルダ。--character で切替）
config/       stream.yaml / youtube.yaml
```

## 開発ルール

- TypeScript（ESM, Node 24）。**コードを変えたら `npm run typecheck && npm test`。**
  `web/` を変えたら `npm run build:web` も実行する。
- **キャラ名・外見・声の設定をコードにハードコードしない。** 全て `characters/<name>/` に置き、
  `--character` で切り替えられる状態を保つ。
- 秘密情報（`FAL_KEY`, `RTMP_KEY`, `config/client_secret.json`, `state/youtube_token.json`）は
  コミットしない。
