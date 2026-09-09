# エージェント向けの案内

このリポジトリを任意のコーディングエージェント（Claude Code / Codex / Gemini CLI / Cursor など）で
運用するための入口。**手順書の正本は次の 2 ファイル**で、ここには重複したコピーを置かない。

| 用途 | 手順書 |
|---|---|
| セットアップ（依存の導入、`.env`、TTS サーバー、YouTube、キャラクター、動作確認） | `.claude/skills/h3-stream-setup/SKILL.md` |
| 配信の運営（開始、コメント返答、映像演出、セッション再接続、終了） | `.claude/skills/h3-stream-operator/SKILL.md` |

どちらも先頭に YAML frontmatter が付いているが、中身は素の Markdown なので、
どのエージェントでもそのまま読んで従える（Claude Code なら skill として自動で認識される）。

- 「セットアップして」「初期設定して」と言われたら setup 側を読む。
- 「配信開始して」「配信を止めて」と言われたら operator 側を読み、続けて
  `characters/<name>/character.md` と `topics.md` も読む。
- **読まずに `h3` コマンドを叩かない。**

リポジトリ全体の約束ごと（開発ルールを含む）は `AGENTS.md`。
コマンド・設定・エラーの参照資料は `docs/operations.md`、設計は `docs/SPEC.md`。
