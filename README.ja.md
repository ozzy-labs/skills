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

`.commons/sync.yaml` に upstream digest を記録:

```yaml
skills_commit: <40-char SHA from main>
```

Renovate が `ozzy-labs/skills@main` の更新を検知し、`skills_commit` を bump する PR を開く。同梱の `sync.sh`（[ozzy-labs/commons](https://github.com/ozzy-labs/commons) 提供）が本リポの `dist/.agents/skills/` を consumer の `.agents/skills/` へコピーする。

### Adapter opt-in（agent 別出力の取り込み）

agent 別 adapter 出力（`dist/{adapter-id}/`）を取り込む場合は、ルート preset と並べて該当する adapter sub-preset を extends する:

```json
{
  "extends": [
    "github>ozzy-labs/skills//skills-sync",
    "github>ozzy-labs/skills//skills-sync/claude-code",
    "github>ozzy-labs/skills//skills-sync/codex-cli",
    "github>ozzy-labs/skills//skills-sync/gemini-cli",
    "github>ozzy-labs/skills//skills-sync/copilot"
  ]
}
```

各 adapter sub-preset は Renovate sync PR に `adapter:<id>` ラベルを付与する。sub-preset は加算的で、実際に sync する adapter のみ extends すればよい。

| Sub-preset | Adapter 出力 |
| --- | --- |
| `skills-sync/claude-code` | `dist/claude-code/.claude/skills/{name}/SKILL.md` |
| `skills-sync/codex-cli` | `dist/codex-cli/.agents/skills/{name}/SKILL.md` + `AGENTS.md.snippet` |
| `skills-sync/gemini-cli` | `dist/gemini-cli/.gemini/settings.json` + `AGENTS.md.snippet` |
| `skills-sync/copilot` | `dist/copilot/.github/copilot-instructions.md.snippet` |

既存 consumer は `extends: ["github>ozzy-labs/skills//skills-sync"]` のみでこれまで通り動作する（adapter opt-in は非破壊・加算的）。consumer 側の adapter-id ベースファイルコピーは別途 `commons/sync.sh` の拡張として提供され（[commons](https://github.com/ozzy-labs/commons) リポの sub-issue で追跡）、本 preset と `sync.sh` の接続仕様は commons 側で定義される。

### Snippet sync ヘルパー

`dist/sync/replace-snippet.sh` は、snippet ファイル（`AGENTS.md.snippet` / `copilot-instructions.md.snippet`）を consumer 所有ファイルへマージする下流 sync workflow 向けのドロップインヘルパーとして配布される:

```bash
.sync-skills/dist/sync/replace-snippet.sh \
  AGENTS.md \
  .sync-skills/dist/codex-cli/AGENTS.md.snippet
```

挙動:

- ターゲットに begin マーカーがある場合 → マーカーブロック（begin..end 包括）を snippet 内容で置換する
- マーカーが欠落している場合（別 sync — 典型的には `commons` — がファイルを上書きしてマネージド領域を消した場合）→ ファイル末尾に snippet を append する。snippet 自体がマーカーを含むため、次回以降は in-place 置換に戻る
- ターゲットファイルが存在しない場合 → snippet から新規作成する

この自動復旧により、下流 workflow がマーカー処理ロジックを自前で持つ必要がなくなり、`.github/copilot-instructions.md` のような共有ファイルの所有権が複数の sync 元にまたがる場合でも hard failure を回避できる。

## Adapter 出力

`pnpm build` は `scripts/adapters/` 配下の各 adapter を実行し、`dist/{adapter-id}/` に書き出す:

| Adapter | 出力 | ソース |
| --- | --- | --- |
| `claude-code` | `dist/claude-code/.claude/skills/{name}/SKILL.md` | `SKILL.claude-code.md`（あれば）/ なければ canonical `SKILL.md` |
| `codex-cli` | `dist/codex-cli/.agents/skills/{name}/SKILL.md` + `AGENTS.md.snippet` | canonical `SKILL.md` |
| `gemini-cli` | `dist/gemini-cli/.gemini/settings.json` + `AGENTS.md.snippet` | canonical `SKILL.md` |
| `copilot` | `dist/copilot/.github/copilot-instructions.md.snippet` | canonical `SKILL.md` |

### Claude Code コンパニオンファイル

skill は canonical `SKILL.md` に加えて、任意で `src/skills/{name}/SKILL.claude-code.md` を持てる。Claude Code adapter は companion が存在すればそのまま出力し、各 skill が Claude Code 固有の wrapper（次アクション `AskUserQuestion` / `argument-hint` / `disable-model-invocation` / `allowed-tools` 等）を canonical `SKILL.md` を汚さずに同梱できる。

Companion frontmatter contract:

| フィールド | 必須 | 備考 |
| --- | --- | --- |
| `description` | ◯ | canonical の `description` を Claude Code 向けに短縮してもよい |
| `disable-model-invocation` | 任意 | boolean — 自動呼び出しを抑止 |
| `allowed-tools` | 任意 | カンマ区切りツール一覧 |
| `argument-hint` | 任意 | `/skill-name <hint>` 形式のヒント |
| `user-invocable` | 任意 | `false` で reference-only skill 扱い |

`name` はディレクトリ名から導出するため、companion frontmatter に含めない。

## ローカル開発

```bash
pnpm install
pnpm build         # dist/ を再生成
pnpm test          # adapter ユニット + 統合テスト
pnpm lint:all
```

`dist/` は commit 対象で、CI が `pnpm build` の出力と一致することを検証する。`src/skills/*/SKILL.md` または `src/skills/*/SKILL.claude-code.md` を編集したら `pnpm build` を実行し、生成された `dist/` の差分も同じコミットに含める。

## 規約

- Commit: [Conventional Commits](https://www.conventionalcommits.org/)（`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`）
- ブランチ: `<type>/<short-description>`（例: `feat/add-debug-skill`）
- PR: squash merge のみ、タイトルは Conventional Commits 形式

## License

[MIT](./LICENSE)
