# AGENTS.md

このファイルは AI エージェント向けの共通 instructions です。

## 基本方針

- 日本語で応答する
- 推奨案とその理由を提示する
- `.env` ファイルは読み取り・ステージングしない
- 破壊的な Git 操作を避ける

## プロジェクト概要

`@ozzylabs/skills`: OzzyLabs 全リポジトリで共有する正準スキルバンドル。`.agents/skills/{name}/SKILL.md` を SSOT として `dist/{adapter-id}/` 配下に agent 別出力を生成し、npm package + CLI installer（`npx @ozzylabs/skills install`）で end user のマシンに **user skills** として install する（例: `~/.claude/skills/`）。consumer リポ配下への project skills 自動配信は廃止し、例外として Claude mobile / web (cloud) で開発する repo のみ `sync-project` subcommand で project-scope を opt-in 配信する。

## Tech Stack

- Runtime: Node.js (ESM)
- Package manager: pnpm
- Version management: mise (`.mise.toml`)
- Distribution: npm package + CLI installer。既定は **user-scope**（`npx @ozzylabs/skills install`、[handbook ADR-0027](https://github.com/ozzy-labs/handbook/blob/main/adr/0027-skill-distribution-user-only.md)）。Claude mobile / web (cloud) 用に `sync-project` で project-scope を opt-in 配信する経路を持つ。旧 push 型 sync フローおよび Renovate preset は廃止

## 主要コマンド

```bash
pnpm install               # 依存関係インストール
pnpm run build             # src/ → dist/ をビルド（コピー + frontmatter 検証）
pnpm run lint              # Biome
pnpm run lint:all          # Biome + markdownlint + yamllint + gitleaks
```

## CLI Installer (user scope)

`npx @ozzylabs/skills install` で canonical skill バンドルを user-scope（`$HOME` 配下）に install できる。`migrate` subcommand は旧 project-scope レイアウト（汎用 10 件の `.claude/skills/` / `.agents/skills/` と `.commons/sync.yaml` の `skills_adapters` / `skills_commit`）を片付ける:

```bash
npx @ozzylabs/skills install --adapter=claude-code --skills=drive,review
npx @ozzylabs/skills install --adapter=codex-cli --upgrade
npx @ozzylabs/skills migrate --dry-run
```

`sync-project` subcommand は project-scope への opt-in 配信。Claude mobile / web (cloud) は "repo only" 動作で `~/.claude/skills/` を参照できないため、対象 repo へ相対 ref を保った `dist/claude-code-project/`（`.claude/skills/` + canonical `.agents/skills/` + `.claude/agents/`）をコピーする:

```bash
npx @ozzylabs/skills sync-project --target=./my-repo --skills=drive,implement,ship,review,commit,pr,lint,test,commit-conventions,lint-rules
```

詳細は `README.md` の「CLI installer (user-scoped)」セクションを参照。

## 検証（必須）

コード変更後、報告前に以下を通すこと:

1. `pnpm run build` — ビルド成功（dist/ の更新を必ず commit）
2. `pnpm run lint:all` — 全リンター通過

## ディレクトリ構成

- `.agents/skills/{name}/SKILL.md` — 正準スキル（編集はここ）。frontmatter `adapters`（カンマ区切り文字列・任意）で配信先アダプタを限定できる（例: `adapters: claude-code`）。未指定は全アダプタ配信。詳細は README.md「Adapter gating」を参照
- `.agents/skills/{name}/SKILL.claude-code.md` — Claude Code 固有 wrapper（任意）。companion 仕様は README.md を参照
- `.agents/skills/{name}/<extra>.md` — 任意の skill 内アセット（例: `review/perspectives/<axis>.md`）。SSOT に置かれ Codex/Gemini はここを直読みする。`SKILL.md` / `SKILL.{adapter}.md` 以外のファイルは、生成される Claude Code wrapper（`.claude/skills/{name}/<extra>.md`）にも verbatim でコピーされる（`adapters` で限定された skill は限定先のみ）
- `src/agents/{name}.md` — Claude Code 専用 agent（[ADR-0026](https://github.com/ozzy-labs/handbook/blob/main/adr/0026-agent-distribution-via-skills-sync.md)）。`dist/claude-code/.claude/agents/{name}.md` のみに出力される
- `dist/{adapter-id}/` — agent 別 adapter 出力（`claude-code` / `codex-cli` / `gemini-cli` / `copilot`）。これが npm payload の正準ペイロード
- `.agents/skills/{name}/SKILL.md` / `.claude/skills/{name}/SKILL.md` — skills repo 自身が dogfood するための in-repo mirror（npm payload には含めない。`package.json#files` で除外）
- `dist/sync/replace-snippet.sh` — `npx @ozzylabs/skills migrate` / 内部 sync helper 向けマーカー間置換ヘルパー（マーカー欠落時は append でフォールバック）
- `scripts/build.mjs` — ビルドオーケストレータ
- `scripts/adapters/{adapter-id}.mjs` — agent 別 adapter（純粋関数、AdapterBase 継承）
- `scripts/sync/replace-snippet.sh` — `dist/sync/` にコピーされる sync ヘルパーの SSOT
- `scripts/lib/` — 共通 lib（frontmatter, snippet markers, AdapterBase）
- `bin/install.mjs` + `bin/lib/` — CLI installer / migrate サブコマンド本体（npm publish payload に含まれる）
- `action.yaml` — composite GitHub Action `ozzy-labs/skills@v1` (CI integration)
- `.commons/sync.yaml` — このリポ自身が `commons` consumer であるためのメタデータ

## 規約

言語・コミット・ブランチ・PR のルールは README.md を参照すること。

## Adapter Files

| Agent | Configuration |
|-------|---------------|
| Claude Code | `CLAUDE.md`, `.claude/` |
| Gemini CLI | `.gemini/settings.json` → `AGENTS.md` |
| Codex CLI | `AGENTS.md` + `.agents/skills/` |
| GitHub Copilot | `AGENTS.md` + `.agents/skills/` |
