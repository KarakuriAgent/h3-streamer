# h3-stream（Claude Code 向けの補足）

**このリポジトリの約束ごとは `AGENTS.md` に書いてある。まずそれを読むこと。**
ここには Claude Code 固有の事情だけを書く。

## skill

`AGENTS.md` が示す 2 つの手順書は、Claude Code では skill として自動で発見される。
依頼されたら必ず起動する（skill を経由しても、ファイルを直接読んでも内容は同じ）。

| 依頼 | skill / ファイル |
|---|---|
| 「配信開始」「配信して」「配信を止めて」など配信の操作 | `h3-stream-operator`（`.claude/skills/h3-stream-operator/SKILL.md`） |
| 「セットアップ」「初期設定」「環境構築」 | `h3-stream-setup`（`.claude/skills/h3-stream-setup/SKILL.md`） |

**手順書を読まずに `h3` コマンドを叩かない。**
配信に入ったら、対象キャラの `characters/<name>/character.md` と `topics.md` を必ず読み、
以後その人格で発話文を書く。

## Claude Code 固有の注意

- `.env` にキーを書いてもらうときは、ユーザーに行頭 `!` 付きで
  `! printf 'FAL_KEY=xxx\n' >> .env` を送ってもらう（シェルで実行され、入力はモデルに渡らない）。
  自分でキーを聞き出さない。`cat .env` もしない。
- `h3 frame --out <path>` で保存した PNG は Read ツールでそのまま開いて目視確認できる。
- TTS サーバーのような常駐プロセスは、Bash ツールの `run_in_background` で立てる。

## 構成（詳細は `AGENTS.md` / `docs/SPEC.md`）

```
src/daemon/   常駐プロセス（Director セッション・TTS・チャット取得・オーバーレイ・RTMP・状態）
src/cli/      h3 コマンド（デーモンに指示し JSON を返す薄いクライアント）
web/          ブラウザ側（compositor / viewer / overlay）。変更したら npm run build:web
characters/   キャラクター設定（1 キャラ 1 フォルダ。--character で切替）
config/       stream.yaml / youtube.yaml
```
