# h3-stream

MiniMax H3 Max Director（fal.ai）で AI キャラクターの YouTube Live 配信を回すシステム。

## 前提

- Node 24 / npm、ffmpeg
- fal.ai の API キー、YouTube Data API v3 のキー、YouTube のストリームキー
- **OpenAI 互換の音声合成 API**（`POST /v1/audio/speech`）。別途用意する。
  ローカルで日本語の声を作るなら [Irodori-TTS-Server](https://github.com/Aratako/Irodori-TTS-Server)
  （その場合は Python + uv と NVIDIA GPU も要る）

## 使い方

お使いのコーディングエージェント（Claude Code、Codex、Gemini CLI、Cursor など）に
[`AGENTS.md`](./AGENTS.md) を読ませたうえで、「セットアップして」「<キャラ名> で配信開始して」と指示する
（Claude Code なら `/h3-stream-setup` と `h3-stream-operator` skill として自動で認識される）。

手順書の正本は `.claude/skills/h3-stream-{setup,operator}/SKILL.md` の 2 ファイル。
AGENTS.md と [`docs/agents/README.md`](./docs/agents/README.md) がそこへ案内する。
素の Markdown なので、エージェントを使わず人が読んで進めることもできる。

キャラクターは `characters/_example/` をコピーして作る（[`characters/README.md`](./characters/README.md)）。
`characters/<name>/` は git 管理外なので、設定・画像・声は各自の手元に置く。

## ドキュメント

設計は [`docs/SPEC.md`](./docs/SPEC.md)、コマンド・設定・エラーの参照資料は
[`docs/operations.md`](./docs/operations.md)、索引は [`docs/README.md`](./docs/README.md)。
