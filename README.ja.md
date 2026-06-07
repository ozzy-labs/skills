[English](README.md) | 日本語

# @ozzylabs/skills

Claude Code / GitHub Copilot / Gemini CLI / Codex CLI 向けの OzzyLabs 正準エージェントスキルバンドル。

`src/skills/{name}/SKILL.md` を SSOT とし、`pnpm build` で `dist/.agents/skills/{name}/SKILL.md` を生成する。consumer リポは Renovate 自動同期で取り込む（npm install での参照も可能）。

[OzzyLabs handbook ADR-0016](https://github.com/ozzy-labs/handbook/blob/main/adr/0016-create-skills-repo.md) で決定された、skills を `commons` から切り出して専用リポでバージョニングする方針の実装。配布機構は [ADR-0002](https://github.com/ozzy-labs/handbook/blob/main/adr/0002-skills-distribution-via-renovate.md) の Renovate 同期を継承する。

## v0.x 同梱スキル

OzzyLabs 全リポジトリ共通の 13 件:

| スキル | 用途 |
| --- | --- |
| `commit` | 変更をステージし Conventional Commits でコミット |
| `commit-conventions` | コミット / ブランチ / PR の命名規則 |
| `drive` | Issue → merge-ready な PR まで自律駆動するループ |
| `health` | リポジトリ状態と skill catalog 整合性を 16 領域に渡って確認し、推奨アクションを inline 表示（`--deep` で `要確認` 項目を追加調査） |
| `implement` | Issue または指示をもとに、ブランチ作成・実装 |
| `lint` | 全リンターを自動修正付きで実行 |
| `lint-rules` | リンター設定リファレンス |
| `pr` | 変更を push し PR を作成・更新 |
| `review` | コード変更や PR を 11 観点（正確性 / セキュリティ / 規約 / アーキテクチャ / 互換性 / 保守性 / テスト / パフォーマンス / 可観測性 / ユーザビリティ / ドキュメント整合性）でレビュー。JSON 構造化出力を併載し、`drive` のループ終了判定を機械化する。`--axes` で自動選別を上書き、`--deep` で観点別 subagent 並列起動（Claude Code のみ） |
| `ship` | lint + commit + PR 作成を一括実行 |
| `sync-consumers` | skills / commons の更新を `sync-targets.yaml` の 14 consumer リポへ並列に push（drive 派生）。drive Phase Final-1 の worktree drift 検出 / Phase Final-2 cleanup を踏襲しつつ、追加軸 7（subagent worktree が `refs/heads/main` を握っていないか検出）と Phase Final-2 内の `cd <parent-worktree-root>` 必須化を本 skill で先行導入。`--dry-run` / `--filter <repo,repo>` / `--merge` |
| `test` | ビルド・テスト・型チェックを実行 |
| `topics` | research-driven な GitHub topics 設定（ozzy-labs scope）。公式制約（lowercase / hyphen / 50 chars / max 20）の検証、`gh api search/repositories` で人気度測定（session 内キャッシュ）、broad+narrow / 単数複数比較、ozzy-labs 慣行ハードコード（`claude-code` 例外・`*-cli` 除去・`multi-agent` 形固定）を行い、`--apply` で適用、`--dry-run` で分析のみ |

リポ固有スキル（例: `road` の `improve-loop` / `road-repo-context`）は本パッケージには含まない。

## Consumer セットアップ

`.commons/sync.yaml` に upstream digest と opt-in adapter を記録:

```yaml
skills_commit: <40-char SHA from main>
skills_adapters:
  - claude-code
  - codex-cli
  - gemini-cli
  - copilot
```

更新は `ozzy-labs/skills` 側から `/sync-consumers` skill 経由で push される（[issue #80](https://github.com/ozzy-labs/skills/issues/80) 参照）。本リポの `main` が進んだとき、maintainer が `/sync-consumers --source=skills --auto-merge` を実行すると、各 consumer に 1 件ずつ sync PR が作成される（内部的に `commons/scripts/sync-consumers.sh` が driver）。PR は `.commons/sync.yaml` の `skills_commit` を bump し、[ozzy-labs/commons](https://github.com/ozzy-labs/commons) の `sync-skills.sh -y` で本リポの `dist/.agents/skills/` および opt-in した adapter 出力を consumer へコピーする。

### Adapter opt-in（agent 別出力の取り込み）

agent 別 adapter 出力（`dist/{adapter-id}/`）を取り込む場合は、`skills_adapters` に adapter id を列挙する（上記サンプル参照）。adapter id と出力パスの対応:

| Adapter id | Adapter 出力 |
| --- | --- |
| `claude-code` | `dist/claude-code/.claude/skills/{name}/SKILL.md` |
| `codex-cli` | `dist/codex-cli/.agents/skills/{name}/SKILL.md` + `AGENTS.md.snippet` |
| `gemini-cli` | `dist/gemini-cli/.gemini/settings.json` + `AGENTS.md.snippet` |
| `copilot` | `dist/copilot/.github/copilot-instructions.md.snippet` |

Adapter opt-in は非破壊・加算的で、実際に sync する adapter のみ列挙すればよい。consumer 側のファイルコピーは `commons/sync-skills.sh` が `skills_adapters` の宣言に従って実行する。

### 旧 Renovate preset（削除済み）

旧版では `skills-sync/` Renovate preset（`extends: ["github>ozzy-labs/skills//skills-sync"]`）を提供していた。本 preset は [issue #80](https://github.com/ozzy-labs/skills/issues/80) Step 4 で削除し、上記の push 型 `/sync-consumers` フローに置換した。既存 consumer は `renovate.json` から `extends` 参照を削除する必要がある（transition の Step 3 で consumer 側 cleanup PR を配信予定）。

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
