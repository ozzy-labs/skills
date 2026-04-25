# AGENTS.md

このファイルは AI エージェント向けの共通 instructions です。

## 基本方針

- 日本語で応答する
- 推奨案とその理由を提示する
- `.env` ファイルは読み取り・ステージングしない
- 破壊的な Git 操作を避ける

## プロジェクト概要

`@ozzylabs/skills`: OzzyLabs 全リポジトリで共有する正準スキルバンドル。`src/skills/{name}/SKILL.md` を SSOT として `dist/.agents/skills/{name}/SKILL.md` を生成し、Renovate sync（`skills-sync.json`）で各 consumer リポへ配信する。

## Tech Stack

- Runtime: Node.js (ESM)
- Package manager: pnpm
- Version management: mise (`.mise.toml`)
- Distribution: Renovate customManagers + git-refs（npm publish も提供）

## 主要コマンド

```bash
pnpm install               # 依存関係インストール
pnpm run build             # src/ → dist/ をビルド（コピー + frontmatter 検証）
pnpm run lint              # Biome
pnpm run lint:all          # Biome + markdownlint + yamllint + gitleaks
```

## 検証（必須）

コード変更後、報告前に以下を通すこと:

1. `pnpm run build` — ビルド成功（dist/ の更新を必ず commit）
2. `pnpm run lint:all` — 全リンター通過

## ディレクトリ構成

- `src/skills/{name}/SKILL.md` — 正準スキル（編集はここ）
- `src/skills/{name}/SKILL.claude-code.md` — Claude Code 固有 wrapper（任意）。companion 仕様は README.md を参照
- `dist/.agents/skills/{name}/SKILL.md` — npm payload / Renovate consumer 向けビルド出力（commit 対象）
- `dist/{adapter-id}/` — agent 別 adapter 出力（`claude-code` / `codex-cli` / `gemini-cli` / `copilot`）
- `scripts/build.mjs` — ビルドオーケストレータ
- `scripts/adapters/{adapter-id}.mjs` — agent 別 adapter（純粋関数、AdapterBase 継承）
- `scripts/lib/` — 共通 lib（frontmatter, snippet markers, AdapterBase）
- `skills-sync.json` — consumer 向け Renovate preset
- `.dev-config/sync.yaml` — このリポ自身が `commons` consumer であるためのメタデータ

## 規約

言語・コミット・ブランチ・PR のルールは README.md を参照すること。

## Adapter Files

| Agent | Configuration |
|-------|---------------|
| Claude Code | `CLAUDE.md`, `.claude/` |
| Gemini CLI | `.gemini/settings.json` → `AGENTS.md` |
| Codex CLI | `AGENTS.md` + `.agents/skills/` |
| GitHub Copilot | `AGENTS.md` + `.agents/skills/` |
