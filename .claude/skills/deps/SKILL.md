---
description: renovate / dependabot 等の automation PR を `deps.mjs` エンジンで列挙し、semver 区分（PR タイトル / branch / manifest diff、grouped は最大 bump）・CI 状態・lockfile 整合・peer / engines 変更で固定語彙判定する。patch/minor + CI green + lockfile 整合 → auto-merge 候補、major / CI red / pending / peer / engines → 要確認。author 判定は health 領域 15 と同一（`*[bot]` / `app/*`、release-please は除外＝ /release の責務）。`--dry-run` は判定のみ、`--auto` は確認なし実行。merge は中央 autonomy policy の irreversible gate に従う（`--auto` は policy 上書き）。
argument-hint: "[--repo owner/repo] [--limit N] [--dry-run | --auto]"
disable-model-invocation: true
allowed-tools: Bash, Read, AskUserQuestion
---

# deps

`.agents/skills/deps/SKILL.md` を Read し、ワークフロー手順に従う。

**重要:** 決定論（automation PR 列挙 / author 判定 / semver 区分 / CI 判定 / lockfile 整合 / peer・engines 検出 / 固定語彙の判定表 / merge 実行）はすべて同梱の **`deps.mjs` エンジン**が担う。SKILL は「エンジンを呼び、出力をそのまま提示し、policy gate で merge 確認する」判断層に徹する。「安全そう」という Claude の自由判断で merge しない（判定はエンジンの固定語彙が決める）。

## Claude Code 固有の追加事項

### エンジン実行

```bash
node ~/.claude/skills/deps/deps.mjs [--repo owner/repo] [--limit N] [--dry-run | --auto]
```

dogfood（本リポ内）では `<repo>/.claude/skills/deps/deps.mjs`。出力は整形済みテキスト（`--json` で構造化 JSON）。引数はユーザー入力をそのまま渡す。

- `--repo owner/repo`: 省略時はエンジンが `git remote get-url origin` から抽出
- `--limit N`: 列挙上限（既定 50）
- `--dry-run`: 判定のみ。merge も確認もしない
- `--auto`: 確認なしで merge（irreversible gate の明示 opt-out）
- `--dry-run` と `--auto` 同時指定時はエンジンが `--dry-run` を優先する（誤 merge 防止）

### merge 確認（policy の `irreversible` gate = ask）

`--dry-run` / `--auto` どちらも未指定（`plan` モード）の場合、エンジンは merge せず `merge_plan`（実行予定の `gh pr merge <N> --squash`）と auto-merge 候補を返す。merge は不可逆アクションなので policy の gate に従う。`policy-read.mjs --action=merge --repo-root="$PWD"` で gate を引く（user-scope では `~/.claude/skills/policy/policy-read.mjs`、dogfood は `<repo>/.claude/skills/policy/policy-read.mjs`）。

- gate=`ask`（ゼロコンフィグ既定）: auto-merge 候補を **1 件ずつ** AskUserQuestion で確認する（テキストで `Y/n` を列挙しない）。承認された PR のみ `gh pr merge <N> --squash` を実行する（`merge_plan` の該当コマンド）。`要確認` 群は merge せず、理由付きで提示するのみ
- gate=`batch-confirm` に緩めている場合: auto-merge 候補を 1 回まとめて提示し AskUserQuestion で一括確認 → 承認されたら同じ引数に `--auto` を付けて `deps.mjs` を再実行する
- gate=`proceed`: 確認なしで `--auto` 付き再実行

`--auto` 指定時は **AskUserQuestion を挟まない**（irreversible gate の明示 opt-out）。エンジンが直列 merge し、結果（`merge_results`）を各行に併記する。

### 定期実行との連携

`schedule`（cron routine）や `/loop` から `/deps --auto` の形で起動すると、「毎朝 automation PR を消化する」ループが閉じる（ADR-0028 R5）。定期実行の中では AskUserQuestion を挟めないため、エンジンの保守的な判定表（迷ったら `要確認`）と policy gate が唯一の境界になる。

### 完了報告・次のアクション提案

triage 表 / merge した PR / `要確認` の内訳を表示したら終了する。次のアクション提案は行わない。
