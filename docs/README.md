# docs 索引

| ファイル | 内容 |
|---|---|
| [SPEC.md](./SPEC.md) | 設計仕様。全体構成、Director の実測仕様、プロンプト組み立て、タイミングモデル、音声経路、合成と送出 |
| [setup.md](./setup.md) | 手動セットアップ手順（依存の導入、`.env`、TTS サーバー、fal、YouTube、動作確認） |
| [operations.md](./operations.md) | 運用リファレンス。`h3` コマンド一覧、エラーの意味、設定ファイル、トラブルシュート、開発コマンド |
| [youtube-setup.md](./youtube-setup.md) | YouTube 連携の詳細手順（API キー方式 / OAuth 方式、配信枠の作り方） |

関連するその他のドキュメント：

- `characters/README.md` — キャラクターの追加手順と `visual.yaml` の書き方
- `characters/_example/` — キャラクター設定の雛形（コピーして使う）
- `.claude/skills/h3-stream-setup/SKILL.md` — 環境構築の手順書（エージェント用）
- `.claude/skills/h3-stream-operator/SKILL.md` — 配信運営の手順書（エージェント用）
