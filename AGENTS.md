# AGENTS.md

このファイルは AI エージェント向けの共通 instructions です。

## 基本方針

- 日本語で応答する
- 推奨案とその理由を提示する
- `.env` ファイルは読み取り・ステージングしない
- 破壊的な Git 操作を避ける

## プロジェクト概要

`@ozzylabs/skills`: OzzyLabs 全リポジトリで共有する正準スキルバンドル。`src/skills/{name}/SKILL.md` を SSOT として `dist/{adapter-id}/` 配下に agent 別出力を生成し、npm package + CLI installer（`npx @ozzylabs/skills install`）で end user のマシンに **user skills** として install する（例: `~/.claude/skills/`）。consumer リポ配下への project skills 配信は廃止。

## Tech Stack

- Runtime: Node.js (ESM)
- Package manager: pnpm
- Version management: mise (`.mise.toml`)
- Distribution: npm package + CLI installer（`npx @ozzylabs/skills install`）のみ。user skills only モデル（[handbook ADR-0027](https://github.com/ozzy-labs/handbook/blob/main/adr/0027-skill-distribution-user-only.md)）。旧 push 型 sync フローおよび Renovate preset は廃止

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

詳細は `README.md` の「CLI installer (user-scoped)」セクションを参照。

## 検証（必須）

コード変更後、報告前に以下を通すこと:

1. `pnpm run build` — ビルド成功（dist/ の更新を必ず commit）
2. `pnpm run lint:all` — 全リンター通過

## ディレクトリ構成

- `src/skills/{name}/SKILL.md` — 正準スキル（編集はここ）
- `src/skills/{name}/SKILL.claude-code.md` — Claude Code 固有 wrapper（任意）。companion 仕様は README.md を参照
- `src/skills/{name}/<extra>.md` — 任意の skill 内アセット（例: `review/perspectives/<axis>.md`）。`SKILL.md` / `SKILL.{adapter}.md` 以外のファイルは全配信先（`.claude/skills/{name}/<extra>.md`, `.agents/skills/{name}/<extra>.md` 等）に verbatim でコピーされる
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
