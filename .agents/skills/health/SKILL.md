---
name: health
description: リポジトリ改修中に意図せず残る状態（working tree, stash, branch, worktree, PR, issue, actions など）と skill catalog 整合性を `health-check.mjs` エンジンで一発確認し、16 領域のステータス表と固定語彙の推奨アクションを提示する。`--deep` で `要確認` 項目を read-only 追加調査、`--fix` で安全語彙（prune / delete / fetch、`--deep` 昇格した drop）のみ確認付きで実行する。既定は read-only。
---

# health - リポジトリ状態の確認と推奨アクション提示

リポジトリ改修中に意図せず残る状態（中断中の git op、未 push commit、stale branch、open PR/issue、failed CI など）と skill catalog の整合性を 16 領域に渡って確認し、各項目に **固定語彙の推奨アクション** を付与して報告する。

決定論（16 領域の検査・固定語彙判定・section ソート・ステータス表/非 clean section のレンダリング・`--fix` 実行）は同梱の **`health-check.mjs` エンジン**が担う（[ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R1、先行例 `usage-check.mjs` / `skill-metrics.mjs` / `policy-read.mjs`）。本 SKILL.md は判断層 — **いつエンジンを呼ぶか・結果をどう提示するか・どこで人に確認するか** — に絞る。

## 原則

- **既定は read-only:** 引数なし / `--deep` のみの経路は一切 mutation しない（検査と提示のみ）。実行は `--fix` 明示時の安全語彙に限る。
- **fail-open:** あるチェックが失敗（gh 未認証・不在、コマンド不在、network 等）しても他チェックは継続する。エンジンは失敗領域を JSON の per-check `error` に載せ、git 系チェックは常に続行する。
- **固定語彙のみ:** 推奨アクションは後述の 8 語彙に限る。エンジンが判定するため、自由文言を生成しない。
- **health と skill-metrics の責務分離:** `health` は repo 状態、`skill-metrics` は skill 挙動。

## 入力

- 引数なし → Phase 1 のみ（routine 互換・決定論的・read-only）
- `--deep` → Phase 1 完了後、`要確認` 項目を read-only コマンドで追加調査し、機械判定可能な範囲でラベルを格上げする
- `--fix` → 安全語彙の推奨アクションを **一覧提示**（この時点では未実行）。人の確認後 `--fix --yes` で直列実行する
- `--yes` → `--fix` 併用時のみ有効。確認をスキップして実行する（routine / `/loop` / `schedule` 経由の無人実行に必須）
- `--json` → 人間可読レポートの代わりに構造化 JSON を出力（プログラム連携・デバッグ用）

`--deep` / `--fix` は明示時のみ有効。

## 手順

1. **本 SKILL.md と同じディレクトリ**の `health-check.mjs` を Bash で実行する（引数はそのまま渡す）。Claude Code では `~/.claude/skills/health/health-check.mjs`（dogfood は `<repo>/.claude/skills/health/health-check.mjs`）:

   ```bash
   node <この skill のディレクトリ>/health-check.mjs [--deep] [--fix] [--yes]
   ```

2. エンジンは既定で **ステータス表 + 非 clean section** を整形済みテキストで stdout に出力する。**その出力をそのまま提示**する（再整形・再解釈しない — レンダリングはエンジンの責務）。
3. `--fix`（`--yes` なし）の場合、エンジンは「実行予定の安全アクション」一覧を出力して**実行せず終了**する。この一覧を人に提示し、**確認を 1 回だけ取る**（確認ゲートの配線はホスト依存 — Claude Code は `SKILL.claude-code.md` 参照）。承認されたら `--fix --yes` で再実行し、実行結果（各行に `✔ done` / `✖ failed`）と実行後ステータス表を提示する。
4. gh 未認証・不在などで Triage 系 section が `error` の場合は、その旨をそのまま提示する（git 系の結果は有効）。

## 推奨アクション語彙（固定・人間可読契約）

エンジンはこの 8 語彙以外を出力しない。

| ラベル | 意味 / 推奨コマンド | 適用条件（代表例） |
|---|---|---|
| `delete` | `git branch -d <name>`（safe。force `-D` は使わない） | merged PR と紐づく追加 commit なしの local branch |
| `drop` | `git stash drop` | 紐づく branch なし、または `--deep` で HEAD に clean apply 不可と判定された stash |
| `prune` | `git remote prune origin` / `git worktree remove` / orphan synthetic branch の `git branch -D` | gone tracking ref / orphaned worktree / 親 worktree 消失の drive synthetic branch |
| `push` | `git push` | ahead で未 push、PR 未作成 |
| `fetch` | `git fetch --tags` | remote にあって local 未取得の tag |
| `要確認` | 機械判断不能、ユーザー目視 | 古い stash / 古い branch / conflict marker / failed CI run |
| `要対応` | human decision 必要 | open PR / open issue / review request / draft release / automation PR |
| `abort or continue` | broken state の解消 | MERGE_HEAD / REBASE_HEAD / CHERRY_PICK_HEAD / BISECT_LOG |

「古い」の閾値は 14 日。section 順序（Broken state → Local artifacts → Triage(mine) → Triage(automation) → Catalog）が暗黙の優先度を表す。

## `--fix` の安全境界（人間可読契約）

`--fix` で自動実行するのは **決定論的・可逆・低リスク** な安全語彙に限る（HITL の Audit Trail with Lazy Review パターン）。

| ラベル | `--fix` 対象 | 根拠 |
|---|---|---|
| `prune` | ○ | remote prune / orphan worktree remove / orphan synthetic branch の `-D` は決定論的 |
| `delete` | ○ | `git branch -d`（safe）のみ。未 merge branch は git 自身が拒否する |
| `fetch` | ○ | 読み取り方向で無害 |
| `drop` | △ | **`--deep` Phase 2 で `drop` に格上げされた stash（HEAD へ clean apply 不可）のみ**。Phase 1 の閾値ベース `drop`（元 branch 消滅）は対象外 |
| `push` / `要確認` / `要対応` / `abort or continue` | × | 外向き副作用または人間判断領域。エンジンは実行対象にしない |

- **確認ゲートは暫定的に単一確認:** 対象一覧を提示 → 1 回確認 → 直列実行。`--yes` でスキップ。
- **policy 連携は本 PR 対象外:** externally-visible / irreversible の gate を中央 policy（`policy-read.mjs`）へ委譲する差し替えは **[#181](https://github.com/ozzy-labs/skills/issues/181)-PR3 で実施予定**。本 PR は policy に依存しない単一確認で先行する。
- **実行は直列・per-action 継続:** git 状態を変えるため並列にしない。個別アクションの失敗は継続し、結果を各行に併記する（audit trail）。
- **既定不変:** 引数なし / `--deep` のみの経路は完全に read-only。

## チェック対象（16 領域）

判定ロジックの詳細はエンジン（`health-check.mjs`）にある。領域と section 順序は以下で固定:

1. Interrupted git ops（MERGE/REBASE/CHERRY_PICK/BISECT） — `abort or continue`
2. Conflict markers（`git diff --check`） — `要確認`
3. Working tree（`git status -s`） — 情報のみ
4. Stash（経過日数 / 元 branch 有無 / `--deep` で apply 可否） — `drop` / `要確認`
5. Local branches（synthetic / merged PR / upstream / ahead） — `prune` / `delete` / `push` / `要確認`
6. Remote tracking（gone ref） — `prune`
7. Worktrees（drive orphan / locked / merged） — `prune`
8. Submodules（`+` / `-` / `U`） — `要確認`
9. Tags（local-only / remote-only） — `push` / `fetch`
10. My open PRs（draft / それ以外） — `要確認` / `要対応`
11. Issues assigned to me — `要対応`
12. Review requests on me — `要対応`
13. Recent failed actions（`--deep` で same-error グルーピング） — `要確認` / `要対応`
14. Draft releases — `要対応`
15. Automation PRs（bot 作者） — `要対応`
16. Perspective MD frontmatter（review skill の観点 MD スキーマ / SSOT⇄配信先 drift） — `要確認`

## 明示的に除外する項目

| 項目 | 除外理由 |
|---|---|
| lockfile drift | correctness 問題。lint/test/CI が拾う領域。言語特化 |
| gitignored-but-tracked file | rare すぎてノイズ源 |
| GitHub Actions caches / artifacts | ストレージ管理の領域、leftover 状態とは別概念 |

## 注意事項

- `.env` ファイルは読み取らない。
- 既定・`--deep` のみは read-only。実行は `--fix` の安全語彙に限る（`push` / `要確認` / `要対応` / `abort or continue` は絶対に実行しない）。
- severity ラベル（blocker / warning / info）は付与しない。section 順序が暗黙の優先度を表す。
- 推奨アクション語彙は固定。新規追加はエンジン + 本 SKILL.md の同時改訂で行う。
- routine 経路（`/loop` / `schedule`）で `--fix` を使う場合は対話不能なので `--yes` を必須とする。
