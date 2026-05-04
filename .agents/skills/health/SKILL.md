---
name: health
description: リポジトリ改修中に意図せず残る状態（working tree, stash, branch, worktree, PR, issue, actions など）を一発で確認し、各項目に固定語彙の推奨アクションを inline で付与して報告する。検査と提示のみで、削除・close 等の実行は行わない。
---

# health - リポジトリ状態の確認と推奨アクション提示

リポジトリ改修中に意図せず残る状態（中断中の git op、未 push commit、stale branch、open PR/issue、failed CI など）を 15 領域に渡って確認し、各項目に **固定語彙の推奨アクション** を inline で付与して報告する。

判断と実行はユーザーが行う。本スキルは検査と提示のみを担当し、削除・drop・prune・close 等は実行しない。

## 入力

引数なし。常に全 15 領域を確認する。

## 動作原則

- **並列実行:** 全領域のチェックコマンドを **同一メッセージ内の複数 Bash 呼び出し** で並列起動する（直列実行は禁止）
- **per-check error handling:** あるチェックが失敗（gh 未認証、コマンド不在、network エラー等）しても他チェックは継続する。失敗した領域は section 内にエラー行を出力する
- **対話禁止:** AskUserQuestion を使わない
- **実行禁止:** 削除・drop・prune・close 等の解消アクションを実行しない（推奨を表示するのみ）
- **推奨は固定語彙のみ:** 後述の語彙以外は使わない。Claude の自由判断で文言を生成しない
- **section 順序固定:** Broken state → Local artifacts → Triage(mine) → Triage(automation) の順で出力する。順序が暗黙の優先度を表現する
- **section 内ソート:** Routine 実行時の差分を安定化するため、各 section で **決定論的な順序** を採用する。具体的には:
  - 元コマンドが自然順を返すもの（`git stash list`, `git worktree list`, `git status -s`, `git submodule status`, `git tag -l`）は **元コマンドの順序を維持**
  - branch / PR / issue / failed run / draft release は **古い順（最終更新が古いものほど上）** で stale 項目を section 上部に集約する。具体的なソート方法は各 section で指定する（git は `--sort` 等のフラグ、gh は `--json` 結果の client side ソート）

## 推奨アクション語彙（固定）

| ラベル | 意味 / 推奨コマンド | 適用条件 |
|---|---|---|
| `delete` | `git branch -d <name>`（safe。force `-D` は推奨しない） | merged PR と紐づく local branch |
| `drop` | `git stash drop` | 紐づく branch なし、または閾値より古い stash |
| `prune` | `git remote prune origin` / `git worktree remove` | gone な tracking ref / orphaned worktree |
| `push` | `git push` | ahead で未 push、PR 未作成 |
| `fetch` | `git fetch --tags` | remote にあって local 未取得の tag |
| `要確認` | 機械判断不能、ユーザー目視 | 古い stash / 古い branch / failed CI run |
| `要対応` | human decision 必要 | open PR / open issue / review request / draft release |
| `abort or continue` | broken state の解消 | MERGE_HEAD / REBASE_HEAD / CHERRY_PICK_HEAD / BISECT_LOG |
| (なし) | 情報のみ表示 | working tree のファイル一覧 / submodule の通常状態 |

「閾値より古い」の目安は 14 日。

## チェック対象（15 領域）

各領域について「コマンド」「推奨アクションの判定ルール」を定義する。

### Broken state

#### 1. interrupted git ops

- コマンド: `ls .git/MERGE_HEAD .git/REBASE_HEAD .git/CHERRY_PICK_HEAD .git/BISECT_LOG 2>/dev/null`
- 存在するファイル名を表示し、推奨アクション `abort or continue` を付与する

#### 2. conflict markers

- コマンド: `git diff --check`
- 出力されたファイル/行を表示し、推奨アクション `要確認` を付与する

### Local artifacts

#### 3. working tree

- コマンド: `git status -s`
- 出力をそのまま表示する。推奨アクションは付けない（情報のみ）

#### 4. stash

- コマンド: `git stash list --format='%gd %ci %gs'`
- 各 stash について経過日数を計算し:
  - 元 branch が現存しない → `drop`
  - 14 日以上経過 → `要確認`
  - それ以外 → 推奨なし

#### 5. local branch

- コマンド: `git branch -vv` および `git for-each-ref --sort=committerdate --format='%(refname:short) %(upstream:track) %(committerdate:relative)' refs/heads/`（古い順）
- PR 検出（**1 度だけ batch 取得**）: `gh pr list --state all --json number,state,mergedAt,headRefName --limit 100` を 1 回実行し、client side で local branch 名と `headRefName` を join する（branch ごとに gh を呼ばない）
- 各 branch について:
  - merged 済みの PR が存在し、かつ merge base 以降に追加 commit が **ない** → `delete`（PR 番号を表示）
  - merged 済みの PR が存在し、かつ merge base 以降に追加 commit が **ある** → `要確認`（PR 番号と追加 commit 数を表示。merge 後に作業継続したケース）
  - upstream なし、かつ最終 commit から 14 日以上 → `要確認`
  - upstream なし、かつ 1 commit 以上、かつ最終 commit から 14 日未満 → `push`（新規ブランチで未 push のケース）
  - upstream あり、ahead で未 push、関連 PR なし → `push`
  - それ以外 → 推奨なし

「追加 commit の有無」の判定: PR の merge commit と local branch の `git rev-list --count <merge-commit>..<branch>` を比較し、結果が 0 なら追加なし、1 以上なら追加あり。

#### 6. remote tracking

- コマンド: `git remote prune origin --dry-run`
- 表示された ref を列挙し、推奨アクション `prune` を付与する

#### 7. worktree

- コマンド: `git worktree list --porcelain`
- main worktree 以外を列挙する。関連 branch が merged または存在しない → `prune`、それ以外 → 推奨なし

#### 8. submodule

- コマンド: `git submodule status`
- submodule がない場合は `(none)` 表示
- prefix が `+`（uncommitted）/ `-`（uninitialized）/ `U`（merge conflict）の場合は表示し、推奨アクション `要確認` を付与する

#### 9. tag

- コマンド: `git ls-remote --tags origin` と `git tag -l`
- local 側にあって remote にない → `push`
- remote 側にあって local にない → `fetch`

### Triage（mine）

#### 10. open PR (mine)

- コマンド: `gh pr list --author @me --state open --json number,title,isDraft,updatedAt`
- **client side で `updatedAt` 昇順にソート**してから表示する（古いほど上）
- 各 PR について:
  - draft → `要確認`
  - それ以外 → `要対応`

#### 11. open issue (assigned to me)

- コマンド: `gh issue list --assignee @me --state open --json number,title,updatedAt`
- **client side で `updatedAt` 昇順にソート**してから表示する（古いほど上）
- 各 issue を表示し、推奨アクション `要対応` を一律付与する。経過日数は表示行の補足情報として含める

#### 12. review request (waiting on me)

- コマンド: `gh pr list --search "is:open review-requested:@me" --json number,title,author,updatedAt`
- **client side で `updatedAt` 昇順にソート**してから表示する（古いほど上）
- 各 PR を表示し、推奨アクション `要対応` を付与する

#### 13. recent failed actions

- 前提: `git branch --show-current` で現在ブランチを取得する。空文字（detached HEAD）の場合は section に `(skipped: detached HEAD)` を表示し、コマンドを実行しない
- コマンド: `gh run list --branch "<current-branch>" --status failure --limit 5 --json databaseId,name,conclusion,createdAt,url`
- **client side で `createdAt` 昇順にソート**してから表示する（古いほど上）
- 各 run を表示し、推奨アクション `要確認` を付与する

#### 14. draft release

- コマンド: `gh release list --limit 20 --json name,tagName,isDraft,createdAt`
- isDraft=true のみ抽出し、**client side で `createdAt` 昇順にソート**してから表示する
- 推奨アクション `要対応` を付与する

### Triage（automation）

#### 15. automation PR

- コマンド: `gh pr list --state open --limit 100 --json number,title,author,updatedAt`
- **client side で author を判別**する（GitHub search の `author:` は OR 不可、AND になるため別アプローチを採る）。`author.login` が下記のパターンに一致するものを抽出:
  - `app/renovate` / `renovate[bot]`
  - `app/dependabot` / `dependabot[bot]`
  - `app/release-please` / `release-please[bot]`
  - その他 `*[bot]` または `app/*` 形式の機械作者
- 抽出後、**`updatedAt` 昇順にソート**してから表示する（古いほど上）
- 各 PR について author 種別と経過日数を表示し、推奨アクション `要対応` を付与する
- 該当なしの場合は section 自体を `(none)` で表示する

## 明示的に除外する項目

| 項目 | 除外理由 |
|---|---|
| lockfile drift | 「意図せず残る」ではなく correctness 問題。lint/test/CI が拾う領域。言語特化 |
| gitignored-but-tracked file | rare すぎてノイズ源 |
| GitHub Actions caches / artifacts | ストレージ管理の領域、leftover 状態とは別概念 |

## 出力フォーマット

markdown の H2 section を順に出力する。section 順序は固定:

1. Interrupted git ops
2. Conflict markers
3. Working tree
4. Stash
5. Local branches
6. Remote tracking
7. Worktrees
8. Submodules
9. Tags
10. My open PRs
11. Issues assigned to me
12. Review requests on me
13. Recent failed actions
14. Draft releases
15. Automation PRs

各 section 内は「項目情報 → 推奨アクション」を 1 行 1 項目で表示し、推奨アクションは末尾に `→ <ラベル>` 形式で付与する（矢印の前に半角スペース）。

該当なしの section は `(none)` を表示し、section 自体は省略しない（決定論的出力のため）。

エラー section は `(error: <reason>)` を表示する。

### 出力例

```text
## Interrupted git ops
MERGE_HEAD                                → abort or continue

## Conflict markers
src/foo.md:42                             → 要確認

## Working tree
 M src/foo.ts
?? scripts/bar.sh

## Stash (2)
stash@{0}  3d   feat/x      WIP          → drop
stash@{1}  14d  main        temp fix     → 要確認

## Local branches (3)
feat/abandoned   no upstream, 21d         → 要確認
feat/done        merged (PR #42)          → delete
fix/bug          ahead 2, behind 5        → push

## Remote tracking (gone)
origin/feat/old-1                         → prune
origin/feat/old-2                         → prune

## Worktrees
/tmp/wt-abc123   feat/abc (merged)        → prune

## Submodules
(none)

## Tags
v0.2.0           local only                → push
v0.3.0           remote only               → fetch

## My open PRs (2)
#101 draft 5d    fix: typo                → 要確認
#102 awaiting    feat: add health         → 要対応

## Issues assigned to me (2)
#50  open 12d    Bug in foo               → 要対応
#51  open  3d    Feature X                → 要対応

## Review requests on me (1)
#88  open 2d     refactor auth            → 要対応

## Recent failed actions
fix/bug  2h ago  CI failure               → 要確認

## Draft releases
v1.0.0           draft, 7d                → 要対応

## Automation PRs (3)
#201 renovate    chore(deps): bump foo    → 要対応
#202 dependabot  chore(deps): bump bar    → 要対応
#203 release-please  chore: release 0.3.0 → 要対応
```

### エラー時の出力例

```text
## Recent failed actions
(skipped: detached HEAD)

## My open PRs
(error: gh not authenticated)

## Issues assigned to me
(error: gh not authenticated)

## Submodules
(none)
```

エラー / skip / 該当なしは section を省略せず、必ず 1 行で状態を表示する。

## エラーハンドリング

| 状況 | 動作 |
|---|---|
| `gh` コマンド不在 | Triage 系 5 section に `(error: gh not installed)` を表示し、git 系チェックは継続する |
| `gh` 未認証 | Triage 系 5 section に `(error: gh not authenticated)` を表示し、git 系チェックは継続する |
| `git` 個別コマンド失敗 | 該当 section に `(error: <stderr 1 行目>)` を表示し、他 section は継続する |
| GitHub remote なし | Triage 系 5 section に `(error: no GitHub remote)` を表示し、git 系チェックは継続する |
| network エラー | 該当 section に `(error: network)` を表示する |
| detached HEAD | Section 13 に `(skipped: detached HEAD)` を表示し、他 section は継続する |

全 section の実行は **失敗があっても中断しない**。

## 注意事項

- `.env` ファイルは読み取らない
- 削除・drop・prune・close 等の解消コマンドは **実行しない**（推奨表示のみ）
- branch 削除推奨は `git branch -d`（safe）。force delete `-D` は推奨に含めない
- severity ラベル（blocker / warning / info）は付与しない。section 順序が暗黙の優先度を表現する
- 推奨アクション語彙は固定。新規追加は SKILL.md 改訂で行う
