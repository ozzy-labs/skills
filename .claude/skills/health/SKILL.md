---
description: リポジトリ改修中に意図せず残る状態（working tree, stash, branch, worktree, PR, issue, actions など）と skill catalog 整合性を `health-check.mjs` エンジンで一発確認し、16 領域のステータス表と固定語彙の推奨アクションを提示する。`--deep` で `要確認` 項目を read-only 追加調査、`--fix` で安全語彙（prune / delete / fetch、`--deep` 昇格した drop）のみ確認付きで実行する。既定は read-only。
argument-hint: "[--deep] [--fix] [--yes]"
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, AskUserQuestion
---

# health

`.agents/skills/health/SKILL.md` を Read し、ワークフロー手順に従う。

**重要:** レンダリング（ステータス表・非 clean section・実行結果）は `health-check.mjs` エンジンが担う。エンジンの stdout をそのまま提示し、再整形・再解釈しない。

## Claude Code 固有の追加事項

### エンジンの実行

同階層の `health-check.mjs` を Bash で実行する（`$ARGUMENTS` をそのまま渡す）。user-scope では `~/.claude/skills/health/health-check.mjs`、dogfood では `<repo>/.claude/skills/health/health-check.mjs`:

```bash
node ~/.claude/skills/health/health-check.mjs $ARGUMENTS
```

### 引数解析

`--deep` / `--fix` / `--yes` の有無を判定する。`--fix` なし（引数なし / `--deep`）はエンジンが read-only で完結するため、出力をそのまま提示して終了する。それ以外のフラグは無視する（将来の拡張用）。

### `--fix` の確認ゲート配線（単一確認）

`--fix` が指定され、かつ `--yes` が **ない** 場合のみ、以下の 2 段で実行する:

1. **一覧提示（未実行）:** `node ~/.claude/skills/health/health-check.mjs --fix [--deep]` を実行する。エンジンは「実行予定の安全アクション」一覧を出力して**実行せず終了**する。
2. **単一確認:** その一覧を提示し、`AskUserQuestion` で **1 回だけ**「実行してよいか」を確認する（テキストで選択肢を列挙しない）。
   - 承認 → `node ~/.claude/skills/health/health-check.mjs --fix --yes [--deep]` を実行し、実行結果（各行の `✔ done` / `✖ failed`）と実行後ステータス表をそのまま提示する。
   - 却下 → 何も実行せず一覧のみ提示して終了する。

`--fix --yes`（最初から `--yes` あり）の場合は確認を挟まずエンジンをそのまま 1 回実行する（routine / `/loop` / `schedule` 経由の無人実行）。

エンジンの `--fix` 安全境界（`prune` / `delete` / `fetch` / `--deep` 昇格 `drop` のみ実行、`push` / `要確認` / `要対応` / `abort or continue` は非対象）は SKILL.md の契約どおりエンジン側で強制される。ホスト側で語彙を再判定しない。

### 完了報告・次のアクション提案

エンジン出力を提示したら終了する。`--fix` の単一確認以外で AskUserQuestion は使わない。次のアクション提案も行わない。
