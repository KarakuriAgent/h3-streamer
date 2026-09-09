# docs 索引

| ファイル | 内容 |
|---|---|
| [SPEC.md](./SPEC.md) | 設計仕様。全体構成、Director の実測仕様、プロンプト組み立て、タイミングモデル、音声経路、合成と送出 |
| [operations.md](./operations.md) | 運用リファレンス（参照資料）。`h3` コマンド一覧、エラーの意味、設定ファイル、トラブルシュート、開発コマンド |
| [youtube-setup.md](./youtube-setup.md) | YouTube 連携の詳細手順（API キー方式 / OAuth 方式、配信枠の作り方） |
| [agents/README.md](./agents/README.md) | エージェント向けの入口（手順書 2 ファイルへの案内） |

**セットアップと運用の手順書は次の 2 ファイルが正本。**どのコーディングエージェントでも、
人が手で読んで進める場合でも、これに従う（Claude Code なら skill として自動で認識される）。

- `.claude/skills/h3-stream-setup/SKILL.md` — 環境構築（依存の導入、`.env`、TTS サーバー、fal、YouTube、キャラクター、動作確認）
- `.claude/skills/h3-stream-operator/SKILL.md` — 配信運営（開始、コメント返答、映像演出、セッション再接続、終了）

関連するその他のドキュメント：

- `AGENTS.md` — リポジトリ全体の約束ごと。エージェントはまずこれを読む
- `characters/README.md` — キャラクターの追加手順と `visual.yaml` の書き方
- `characters/_example/` — キャラクター設定の雛形（コピーして使う）
