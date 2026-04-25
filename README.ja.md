[English](README.md) | 日本語

# @ozzylabs/skills

Claude Code / GitHub Copilot / Gemini CLI / Codex CLI 向けの OzzyLabs 正準エージェントスキルバンドル。

`src/skills/{name}/SKILL.md` を SSOT とし、`pnpm build` で `dist/.agents/skills/{name}/SKILL.md` を生成する。consumer リポは Renovate 自動同期で取り込む（npm install での参照も可能）。

[OzzyLabs handbook ADR-0016](https://github.com/ozzy-labs/handbook/blob/main/adr/0016-create-skills-repo.md) で決定された、skills を `commons` から切り出して専用リポでバージョニングする方針の実装。配布機構は [ADR-0002](https://github.com/ozzy-labs/handbook/blob/main/adr/0002-skills-distribution-via-renovate.md) の Renovate 同期を継承する。

## v0.x 同梱スキル

OzzyLabs 全リポジトリ共通の 10 件:

| スキル | 用途 |
| --- | --- |
| `commit` | 変更をステージし Conventional Commits でコミット |
| `commit-conventions` | コミット / ブランチ / PR の命名規則 |
| `drive` | Issue → merge-ready な PR まで自律駆動するループ |
| `implement` | Issue または指示をもとに、ブランチ作成・実装 |
| `lint` | 全リンターを自動修正付きで実行 |
| `lint-rules` | リンター設定リファレンス |
| `pr` | 変更を push し PR を作成・更新 |
| `review` | コード変更や PR をレビュー |
| `ship` | lint + commit + PR 作成を一括実行 |
| `test` | ビルド・テスト・型チェックを実行 |

リポ固有スキル（例: `road` の `improve-loop` / `road-repo-context`）は本パッケージには含まない。

## Consumer セットアップ

`renovate.json` に preset を追加:

```json
{
  "extends": [
    "github>ozzy-labs/skills//skills-sync"
  ]
}
```

`.dev-config/sync.yaml` に upstream digest を記録:

```yaml
skills_commit: <40-char SHA from main>
```

Renovate が `ozzy-labs/skills@main` の更新を検知し、`skills_commit` を bump する PR を開く。同梱の `sync.sh`（[ozzy-labs/commons](https://github.com/ozzy-labs/commons) 提供）が本リポの `dist/.agents/skills/` を consumer の `.agents/skills/` へコピーする。

## ローカル開発

```bash
pnpm install
pnpm build         # dist/ を再生成
pnpm lint:all
```

`dist/` は commit 対象で、CI が `pnpm build` の出力と一致することを検証する。`src/skills/*/SKILL.md` を編集したら `pnpm build` を実行し、生成された `dist/` の差分も同じコミットに含める。

## 規約

- Commit: [Conventional Commits](https://www.conventionalcommits.org/)（`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`）
- ブランチ: `<type>/<short-description>`（例: `feat/add-debug-skill`）
- PR: squash merge のみ、タイトルは Conventional Commits 形式

## License

[MIT](./LICENSE)
