---
description: open issue を `backlog.mjs` エンジンで収集し、依存グラフ（drive の依存記法 SSOT を再利用）と固定語彙の優先度規則で並べ、着手候補を提示して drive 引数形式（例 `#12,#15 -> #18`）で出力する。既定は提示のみ、`--drive[=N]` で確認後 drive へ、`--auto` は `auto-ok` ラベル付き issue のみ無確認で drive へ（HATL）。単一リポのみ。
argument-hint: "[--repo owner/repo] [--label <filter>] [--limit N] [--drive[=N] | --auto]"
disable-model-invocation: true
allowed-tools: Bash, Read, AskUserQuestion, SlashCommand
---

# backlog

`~/.agents/skills/backlog/SKILL.md` を Read し、ワークフロー手順に従う。

**重要:** 決定論（issue 収集 / 依存抽出 / 優先度ソート / `auto-ok` ゲーティング / drive 引数整形）はすべて同梱の **`backlog.mjs` エンジン**が担う。依存記法の SSOT は drive（`drive-plan.mjs`）で、エンジンが import 再利用する。SKILL は「エンジンを呼び、出力をそのまま提示し、policy gate で drive 起動を確認する」判断層に徹する。優先順位を Claude の自由判断で作らない。

## Claude Code 固有の追加事項

### エンジン実行

```bash
node ~/.claude/skills/backlog/backlog.mjs [--repo owner/repo] [--label <filter>] [--limit N] [--drive[=N] | --auto]
```

dogfood（本リポ内）では `<repo>/.claude/skills/backlog/backlog.mjs`。出力は整形済みテキスト（`--json` で構造化 JSON）。引数はユーザー入力をそのまま渡す。

- `--repo owner/repo`: 省略時はエンジンが `git remote get-url origin` から抽出
- `--label <filter>`: `gh issue list` へのラベル絞り込み
- `--limit N`: 収集上限（既定 20）
- `--drive[=N]`: 上位 N 件 + 依存閉包を drive へ handoff（N 省略で全候補）
- `--auto`: 無確認で drive へ。ただし `auto-ok` ラベル付き issue のみ対象（HATL）

### 候補選択と drive 起動（policy の `externally-visible` gate = batch-confirm）

drive 起動は外部可視アクション。`policy-read.mjs --action=drive-launch --class=externally-visible --repo-root="$PWD"` で gate を引く（user-scope では `~/.claude/skills/policy/policy-read.mjs`、dogfood は `<repo>/.claude/skills/policy/policy-read.mjs`）。gate に従って確認する。

**present モード（既定）** — `--drive` / `--auto` なし:

1. エンジン出力（優先度順の候補表 + `drive_args`）をそのまま提示する。
2. AskUserQuestion（`multiSelect: true`）で着手する候補を選択してもらう（候補は `handoff.selected`）。テキストで `Y/n` を列挙しない。
3. 選択された部分集合に対応する drive 引数を（依存閉包を含めて）提示し、起動するか確認する:
   - **「drive を起動する」** → `SlashCommand` で `/drive <drive_args>` を起動する
   - **「引数を出力するだけ」** → `drive_args` を表示して終了する

**drive モード** — `--drive[=N]`:

1. エンジンが選定した上位 N 件 + 依存閉包（`handoff.selected` / `handoff.drive_args`）を提示する。
2. gate=`batch-confirm`（既定）では、起動する drive 引数を **1 回だけ** AskUserQuestion で一括確認する（`answers` は設定しない）:
   - **「起動する」** → `SlashCommand` で `/drive <drive_args>` を起動
   - **「やめる」** → 終了
3. gate=`ask` に厳格化されている場合は drive 引数を 1 件（1 wave）ずつ確認する。

**auto モード** — `--auto`:

1. エンジンが `auto-ok` ラベル付き issue のみに絞った handoff 集合（`handoff.selected`）と、除外内訳（`excluded_no_label` / `excluded_unapproved_dep`）を提示する。
2. `auto-ok` ラベルが standing 承認（境界条件）として機能するため、**個別確認はしない**。gate=`batch-confirm`（既定）では handoff 集合を 1 回提示して `SlashCommand` で `/drive <drive_args>` を起動する。
3. handoff 集合が空（`auto-ok` issue が 0 件）なら drive を起動せず、その旨を報告して終了する。
4. gate が `ask` に厳格化されている場合のみ、`--auto` でも fail-safe に個別確認へ格上げする。

### 定期実行との連携

`schedule`（cron routine）や `/loop` から `/backlog --auto --limit 3` の形で起動すると、「`auto-ok` を付ければ自動消化される」ループが閉じる（ADR-0028 R5）。定期実行の中では AskUserQuestion を挟めないため、`--auto` の `auto-ok` ゲーティングと policy gate が唯一の境界になる（人間はラベル付与のみで境界を設定する）。

### 完了報告・次のアクション提案

候補提示 / 起動した drive 引数 / auto の除外内訳を表示したら終了する。drive 起動後はその報告に委ねる。次のアクション提案は行わない。
