# AGENTS.md（Codex 用）

このリポジトリは、AI キャラクターの YouTube Live 配信を CLI エージェントが運営するシステム
（h3-stream）です。設計は `docs/SPEC.md`、コマンドと設定は `docs/operations.md` にあります。

## 配信を運営するとき

**「配信開始」「配信して」「配信を止めて」など配信操作を頼まれたら、必ず次のファイルを読み、
そこに書かれた手順どおりに実行してください。**

```
.claude/skills/h3-stream-operator/SKILL.md
```

このファイルが配信オペレーターの唯一の手順書です。読まずに `h3` コマンドを叩かないでください。
続けて、対象キャラクターの設定も必ず読みます（キャラ名が指定されなければ `ls characters/` の
候補から選びます。`_default` と `_example` はキャラではありません）。

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

「セットアップ」「初期設定」「環境構築」と言われたら、次の手順書に従ってください。

```
.claude/skills/h3-stream-setup/SKILL.md
```

手で進める場合の同じ内容が `docs/setup.md` にあります。
**セットアップの中で Director に接続する操作（`h3 speak`、compositor の起動）はしないでください**
（fal の課金が発生します）。

## 開発するとき

- 実装言語は TypeScript（ESM, Node 24）。**コードを変えたら `npm run typecheck && npm test`。**
  `web/` を変えたら `npm run build:web` も実行します。
- キャラ固有の情報をコードに書かないでください。全て `characters/<name>/` に置きます。
- YouTube 連携のセットアップは `docs/youtube-setup.md` を参照。
