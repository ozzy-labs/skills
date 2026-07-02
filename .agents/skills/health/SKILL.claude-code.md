---
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

### `--fix` の確認ゲート配線（中央 policy に従う）

`--fix` が指定され、かつ `--yes` が **ない** 場合、エンジンが各アクションの gate を中央 policy（`policy-read.mjs`）で解決する。ホスト側は **gate ごとに** UI を分岐する（gate 判定はエンジンが持つ。ホストで語彙・クラスを再判定しない）:

1. **実行 + 一覧提示:** `node ~/.claude/skills/health/health-check.mjs --fix [--deep]` を実行する。エンジンは `proceed`（reversible-local）アクションを**その場で実行**し「実行結果」（各行 `✔ done` / `✖ failed`）を出力する（audit trail・確認不要）。`ask`（irreversible の stash drop）アクションは「確認が必要なアクション (gate=ask)」として出力し**実行しない**。
2. **`ask` の個別確認:** `ask` 一覧がある場合のみ、`AskUserQuestion` で**アクションごとに**「実行してよいか」を確認する（テキストで選択肢を列挙しない）。
   - 承認 → `node ~/.claude/skills/health/health-check.mjs --fix --yes [--deep]` を実行して残り（承認済み `ask`）を実行し、実行結果と実行後ステータス表をそのまま提示する。
   - 却下 → 何も追加実行せず終了する。
   - `ask` 一覧が空（全て `proceed` で実行済み）→ 実行結果と実行後ステータス表を提示して終了する。

`--fix --yes`（最初から `--yes` あり）の場合は確認を挟まずエンジンをそのまま 1 回実行する。`--yes` は **policy を上書きする明示 opt-out** で、gate が `ask` のアクションも含め全安全アクションを実行する（routine / `/loop` / `schedule` 経由の無人実行）。

エンジンの `--fix` 安全境界（`prune` / `delete` / `fetch` / `--deep` 昇格 `drop` のみ実行、`push` / `要確認` / `要対応` / `abort or continue` は非対象）と gate 解決（reversible-local=proceed / irreversible=ask、policy 不在は fail-safe に ask）は SKILL.md の契約どおりエンジン側で強制される。ホスト側で語彙・gate を再判定しない。

### 完了報告・次のアクション提案

エンジン出力を提示したら終了する。`--fix` の単一確認以外で AskUserQuestion は使わない。次のアクション提案も行わない。
