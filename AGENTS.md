# AGENTS.md

このリポジトリは、AI キャラクターの YouTube Live 配信をコーディングエージェントが運営する
システム（h3-stream）です。Claude Code / Codex / Gemini CLI / Cursor など、どのエージェントでも、
また人が手で読んで進める場合でも、このファイルと下記の手順書に従ってください。

コマンド・設定・エラーの参照資料は `docs/operations.md`、設計は `docs/SPEC.md`。

## 手順書（正本）

| 依頼 | 読むファイル |
|---|---|
| 「配信開始」「配信して」「配信を止めて」など配信の操作 | `.claude/skills/h3-stream-operator/SKILL.md` |
| 「セットアップ」「初期設定」「環境構築」 | `.claude/skills/h3-stream-setup/SKILL.md` |

**この 2 ファイルが唯一の手順書です。読まずに `h3` コマンドを叩かないでください。**
どちらも先頭に YAML frontmatter が付いていますが、中身は素の Markdown です
（Claude Code なら skill として自動で認識されます）。`docs/agents/README.md` にも同じ案内があります。

## 配信を運営するとき

手順書に加えて、対象キャラクターの設定も必ず読みます（キャラ名が指定されなければ
`ls characters/` の候補から選びます。`_default` と `_example` はキャラではありません）。

```
characters/<name>/character.md   # 人格・口調・NG。発話文はこの人格で書く
characters/<name>/topics.md      # コメントが無いときの話題
```

要点だけ先に：

- 発話文（`--text`）は日本語で `character.md` の人格。1 発話 25〜40 文字、最大 2 文。
- 映像演出（`--direction`）は**英語**。キャラ本人の外見（髪・帽子・眼鏡・ヘッドホン・服・顔）は
  絶対に変えない。演出は環境・小道具・エフェクト・カメラ・表情と仕草で行う。
- 常に 1〜2 発話（15〜25 秒）先行して音声を積み、キューを切らさない。
- 同じコメントを二度使わない（`--comment-id` を必ず渡す）。

詳細・イベント別の対応表・トラブル対応は SKILL.md と `docs/operations.md` を参照してください。

## セットアップを頼まれたとき

`.claude/skills/h3-stream-setup/SKILL.md` に従ってください。依存の導入、`.env` とキー、
TTS サーバー、YouTube 連携、キャラクター、動作確認まで、そこに全部書いてあります。

- **API キーの値を会話に出させないでください。** ユーザー自身にターミナルで
  `printf 'FAL_KEY=xxx\n' >> .env` を実行してもらいます。
- **セットアップの中で Director に接続する操作（`h3 speak`、compositor の起動）はしないでください**
  （fal の課金が発生します）。

## 開発するとき

- 実装言語は TypeScript（ESM, Node 24）。**コードを変えたら `npm run typecheck && npm test`。**
  `web/` を変えたら `npm run build:web` も実行します。
- キャラ固有の情報をコードに書かないでください。全て `characters/<name>/` に置きます。
- 秘密情報（`FAL_KEY`, `RTMP_KEY`, `config/client_secret.json`, `state/youtube_token.json`）は
  コミットしないでください。
- YouTube 連携の詳細手順は `docs/youtube-setup.md` を参照。
