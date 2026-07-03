---
description: release-please PR を検出（`gh pr list --author app/release-please --state open`）し、固定チェックリスト（version bump と含有 commit type の SemVer 整合 feat→minor / fix→patch / `!` or BREAKING CHANGE→major、CHANGELOG 整合、CI 全 green）で検証してから、既定は承認ゲート（外部可視・実質不可逆）を通して `gh pr merge --squash` する。マージ後は publish workflow を polling（30s 間隔・上限 20 分）で監視し `npm view <pkg> version` で反映確認する（npm 配布リポのみ）。`--auto` は全検証 pass 時のみゲートを skip（fail 時は停止）。npm publish は OIDC Trusted Publishers 前提（`NPM_TOKEN` 不使用）。
argument-hint: "[--repo owner/repo] [--auto]"
disable-model-invocation: true
allowed-tools: Bash, Read, AskUserQuestion
---

# release

`~/.agents/skills/release/SKILL.md` を Read し、ワークフロー手順に従う。

**重要:** リリースは外部可視・実質不可逆（公開済みバージョンは撤回できない）。マージ可否は SKILL.md の**固定チェックリスト**（SemVer 整合 / CHANGELOG / CI green）でのみ判定し、「良さそう」という Claude の自由判断でマージしない。承認は中央 autonomy policy の `irreversible` gate に従う。

## Claude Code 固有の追加事項

### 検出・検証・監視

SKILL.md の手順どおり Bash で実行する:

```bash
gh pr list --author app/release-please --state open --json number,title,url,headRefName
gh pr checks <N>            # CI 全 green の確認
gh pr view <N> --json commits   # 含有 commit の type / breaking 抽出（SemVer 整合）
```

- `--repo owner/repo`: 省略時は `git remote get-url origin` から解決
- `--auto`: 全検証 pass 時のみ承認ゲートを skip（検証 fail 時は停止）

### 承認ゲート（policy の `irreversible` gate = ask）— AskUserQuestion で配線

**検証結果サマリを提示して承認を得る**のが本ゲートの中核。テキストで `Y/n` を列挙せず、必ず `AskUserQuestion` を使う。

1. まず SKILL.md の検証チェックリストを全項目確認する。**1 項目でも fail なら AskUserQuestion を出さず、失敗項目を提示して停止**する（マージしない。`--auto` でも停止）。
2. 全検証 pass の場合、merge は不可逆アクションなので policy の gate に従う。`policy-read.mjs --action=merge --repo-root="$PWD"` で gate を引く（user-scope は `~/.claude/skills/policy/policy-read.mjs`、dogfood は `<repo>/.claude/skills/policy/policy-read.mjs`）。
   - gate=`ask`（ゼロコンフィグ既定）: **検証結果サマリ**（version bump / 主要変更 / チェックリストの pass 状況 / CI 状態）を提示し、`AskUserQuestion` で「この release PR をマージするか」を確認する。承認された場合のみ `gh pr merge <N> --squash` を実行する。
   - gate=`batch-confirm`: 検証結果サマリを 1 回まとめて提示し `AskUserQuestion` で一括確認 → 承認で `gh pr merge <N> --squash`。
   - gate=`proceed`: 確認なしで `gh pr merge <N> --squash`。
3. `--auto` 指定時（かつ全検証 pass）は **AskUserQuestion を挟まない**（irreversible gate の明示 opt-out）。直接 `gh pr merge <N> --squash` を実行する。

マージ後は SKILL.md 4.（publish workflow の polling・30s 間隔・上限 20 分）→ `npm view <pkg> version` 反映確認（npm 配布リポのみ）。publish workflow が無いリポは 6.（tag / Release 確認）で完了。

### 定期実行との連携

`schedule`（cron routine）や `/loop` から `/release --auto` の形で起動すると、「release-please PR が立ったら検証して配布まで回す」ループが閉じる。定期実行では AskUserQuestion を挟めないため、SKILL.md の固定チェックリスト（fail なら停止）と policy gate が唯一の境界になる。

### 完了報告・次のアクション提案

検証結果サマリ / マージした PR / publish workflow の結果 / npm 反映（または tag / Release 確認）を表示したら終了する。次のアクション提案は行わない。
