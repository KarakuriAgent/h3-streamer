# h3-stream

MiniMax H3 Max Director（fal.ai）で AI キャラクターの YouTube Live 配信を回すシステム。

## 前提

- Node 24 / npm、ffmpeg
- fal.ai の API キー、YouTube Data API v3 のキー、YouTube のストリームキー
- **OpenAI 互換の音声合成 API**（`POST /v1/audio/speech`）。別途用意する。
  ローカルで日本語の声を作るなら [Irodori-TTS-Server](https://github.com/Aratako/Irodori-TTS-Server)
  （その場合は Python + uv と NVIDIA GPU も要る）

## セットアップ

Claude Code で `/h3-stream-setup` を実行する（対話的に環境構築まで進む）。
手で進めるなら [`docs/setup.md`](./docs/setup.md)。

## 配信

Claude Code で「<キャラ名> で配信開始して」と言う（`h3-stream-operator` skill が動く）。
キャラクターは `characters/_example/` をコピーして作る（`characters/README.md`）。
`characters/<name>/` は git 管理外なので、設定・画像・声は各自の手元に置く。

## ドキュメント

設計は [`docs/SPEC.md`](./docs/SPEC.md)、コマンドと設定は [`docs/operations.md`](./docs/operations.md)、
索引は [`docs/README.md`](./docs/README.md)。
