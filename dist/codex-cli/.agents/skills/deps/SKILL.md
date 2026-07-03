---
name: deps
description: renovate / dependabot 等の automation PR を `deps.mjs` エンジンで列挙し、semver 区分（PR タイトル / branch / manifest diff、grouped は最大 bump）・CI 状態・lockfile 整合・peer / engines 変更で固定語彙判定する。patch/minor + CI green + lockfile 整合 → auto-merge 候補、major / CI red / pending / peer / engines → 要確認。author 判定は health 領域 15 と同一（`*[bot]` / `app/*`、release-please は除外＝ /release の責務）。`--dry-run` は判定のみ、`--auto` は確認なし実行。merge は中央 autonomy policy の irreversible gate に従う（`--auto` は policy 上書き）。
---

# deps - automation PR の policy-based triage

renovate / dependabot 等の automation PR は、health（領域 15）が `要対応` として積むだけで、処理は毎回人手だった。定常的 HITL の最大源泉の一つで、semver 区分 + CI 状態で機械判定できる。本スキルはその triage を一本化する: automation PR を列挙し、固定語彙で `auto-merge 候補` / `要確認` に分類し、policy に従って merge する。

決定論（PR 列挙・author 判定・semver 区分・CI 判定・lockfile 整合・peer / engines 検出・固定語彙の判定表・merge 実行・レンダリング）は同梱の **`deps.mjs` エンジン**が担う（[ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R1、先行例 `health-check.mjs` / `backlog.mjs` / `topics.mjs` / `policy-read.mjs`）。本 SKILL.md は判断層 — **いつエンジンを呼ぶか・triage をどう提示するか・どこで人に確認するか（policy gate）** — に絞る。Claude が自由判断で「安全そう」と merge しない（判定はエンジンの固定語彙が決める）。

**スコープ**: 単一リポジトリの automation PR triage。release PR は対象外（`/release` の責務）。cross-repo は将来検討。

## 入力

```text
deps
  --repo owner/repo   (省略時は cwd の origin から解決)
  --limit N           (列挙上限。既定 50)
  --dry-run           (判定のみ。merge も確認もしない)
  --auto              (確認なしで merge。policy の irreversible gate を明示 opt-out)
```

- `--dry-run` と `--auto` を同時指定した場合は `--dry-run` を優先する（誤 merge 防止。topics と同じ規則。エンジンが強制する）
- どちらも未指定時（`plan` モード）: エンジンは判定して `merge_plan`（実行予定の `gh pr merge --squash`）を返し、merge は行わない。gate に従って人に確認する

## 手順

1. **本 SKILL.md と同じディレクトリ**の `deps.mjs` を Bash で実行する（引数はそのまま渡す）。Claude Code では `~/.claude/skills/deps/deps.mjs`（dogfood は `<repo>/.claude/skills/deps/deps.mjs`、Codex/Gemini は `~/.agents/skills/deps/deps.mjs`）:

   ```bash
   node <この skill のディレクトリ>/deps.mjs [--repo owner/repo] [--limit N] [--dry-run | --auto]
   ```

   エンジンは既定で **整形済みテキスト**（triage 表 + auto-merge 候補 / 要確認 + merge plan）を stdout に出力する。`--json` で構造化 JSON を得られる。

2. エンジンの出力を **そのまま提示**する（再整形・再解釈・再判定しない — 列挙・区分・判定表はすべてエンジンの責務）。`要確認` 群には各 PR の理由（bump 幅 / CI 状態 / lockfile / peer / engines）が併記されている。
3. `repo_error` が立っている（GitHub remote 不在）場合はその旨を提示し `--repo owner/repo` の明示を促す。`fetch_error`（gh 未認証 / rate limit / network）が立っている場合はエンジンの分類をそのまま伝える。
4. merge は下記 **policy の `irreversible` gate** に従う。

## author 判定（health 領域 15 と同一パターン・release-please は除外）

automation PR の author 判定は **health skill の領域 15（`health-check.mjs` の `isBotAuthor`）と同一パターン**を使う: `*[bot]` で終わる login / `app/*`（GitHub App）/ `is_bot` フラグ。両者の一致は `tests/deps.test.mjs` の sync assertion で強制し、drift を防ぐ（片方だけ変えると CI が落ちる）。

**release-please は除外する**: release-please は bot だが、その PR は `/release` の責務であり deps triage の対象外。エンジンが `isReleasePlease` で必ず除外する。

## 判定表（固定語彙・エンジンが決定論的に判定）

エンジンが下表の固定語彙で判定する。Claude はこの判定を**再解釈・上書きしない**。

| 条件 | 判定 |
| --- | --- |
| semver **patch / minor** + CI **green** + lockfile 整合 + peer なし + engines なし | **`auto-merge`**（候補） |
| semver **major** | `要確認` |
| CI **red** / **pending** / **no checks** / 状態取得不能 | `要確認` |
| semver **区分不能（unknown）** | `要確認`（保守側） |
| **lockfile drift**（manifest 変更に対し lockfile 未更新） | `要確認` |
| **peer 依存**変更 / **engines** 変更 | `要確認` |

判定材料の取り方:

- **semver 区分**: PR タイトル / branch 名 / manifest diff の `from→to` バージョン対から判定する。**grouped PR は含まれる最大 bump** で判定する（major が 1 つでも含まれれば major）。区分不能な場合は保守的に `unknown` → `要確認`
- **CI**: `gh pr checks <N>` の全 check が green のときのみ green。fail / cancel → red、running / queued → pending。check が 1 つもなければ `no-checks`（いずれも `要確認`）
- **lockfile 整合**: manifest（`package.json` / `pyproject.toml` / `go.mod` 等）が変更されているのに対応する lockfile が未更新なら drift（`要確認`）。lockfile のみ変更（lockfile-maintenance / transitive）や manifest/lockfile を触らない PR（例: GitHub Actions のバージョン bump）は整合扱い

この固定語彙は `deps.mjs` に実装されている。語彙・判定条件を増減する場合は `deps.mjs` + 本表の同時改訂で行う（Claude の自由判断で条件を足さない）。

## merge（policy の `irreversible` gate に従う）

`gh pr merge --squash` は **不可逆アクション**（irreversible）。個別の承認ゲートを prose にハードコードせず、中央 autonomy policy（`policy` skill が定義する 3 クラス・gate 語彙の SSOT）に従う。分類とゼロコンフィグ既定:

| 本 skill のアクション | クラス | policy 参照 | ゼロコンフィグ既定 gate |
| --- | --- | --- | --- |
| PR merge（`gh pr merge --squash`） | `irreversible` | `--action=merge` | `ask`（auto-merge 候補を 1 件ずつ確認） |

有効 gate は sibling の `policy` skill の `policy-read.mjs` で引く（user-scope では `~/.claude/skills/policy/policy-read.mjs`、dogfood は `<repo>/.claude/skills/policy/policy-read.mjs`、Codex/Gemini は `~/.agents/skills/policy/policy-read.mjs`）:

```bash
node <policy skill のディレクトリ>/policy-read.mjs --action=merge --repo-root="$PWD"
# => .resolved.gate（既定 ask）
```

flag は policy と整合させる:

- `--dry-run` 指定時: エンジンは判定のみ出力し、merge も確認もしない（`gh pr merge` を呼ばない）
- `--auto` 指定時: **irreversible gate の明示 opt-out**。エンジンが確認なしで各 auto-merge 候補に対し `gh pr merge <N> --squash` を直列実行する（routine / `/loop` / `schedule` 経由の無人実行に必須）
- どちらも未指定時（`plan` モード）: エンジンは merge せず `merge_plan`（実行予定コマンド）を返す。gate に従って人に確認する:
  - gate=`ask`（ゼロコンフィグ既定）: auto-merge 候補を **1 件ずつ**確認する。承認された PR のみ `gh pr merge <N> --squash` を実行する
  - gate=`batch-confirm`: auto-merge 候補を 1 回まとめて提示・一括確認し、承認されたら同じ引数に `--auto` を付けて再実行する
  - gate=`proceed`: 確認なしで `--auto` 付き再実行

**policy 不在でも壊れない:** `policy-read.mjs` は fail-safe 設計で、読めない・不正な値は厳しい側（`ask`）へ倒す。`policy` skill 未配置の環境では上表のゼロコンフィグ既定 gate（`irreversible`=`ask`）を直接適用する。

## エラーハンドリング（エンジンが JSON に載せる）

| 状況 | エンジンの動作 |
| --- | --- |
| `--repo` 未指定で GitHub remote 不在 | `repo_error` を立てる。merge は行わない |
| `gh` 未認証 / rate limit / network（PR 列挙） | `fetch_error` に分類を載せる。候補は空 |
| PR 個別の CI 状態 / diff 取得失敗 | 該当 PR のみ `要確認` に降格（`ci: error` / `diff_error`）。他 PR は継続 |
| merge 失敗（branch protection 等・`--auto` 時） | 該当 PR のみ `要確認` に降格して継続（`merge_results` に記録） |
| automation PR 0 件 | `candidates: []`。merge plan は空 |

## `/loop` / `schedule` との連携

`--auto` を `schedule`（cron routine）や `/loop` から起動すると、「毎朝 automation PR を消化する」ループが閉じる（[ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R5）。例: `/deps --auto`。無人実行では対話できないため、判定表（保守側 = 迷ったら `要確認`）と policy gate が唯一の境界になる。

## スコープ外

| 項目 | 除外理由 |
| --- | --- |
| 1. release PR の処理 | `/release` の責務。release-please 作者は必ず除外する |
| 2. 判定条件の自由化 | 判定は固定語彙のみ。LLM の自由判断で「安全そう」と merge しない（再現性・信頼性のため） |
| 3. cross-repo triage | 現時点では単一リポのみ。複数リポ横断は別 issue で検討 |
| 4. `--delete-branch` / `--auto`（GitHub auto-merge） | 本スキルは即時 squash merge のみ。branch 削除・GitHub auto-merge は行わない |

## 注意事項

- `.env` ファイルは読み取り・ステージングしない
- author 判定は health 領域 15 と同一パターン（`tests/deps.test.mjs` の sync assertion が drift を防ぐ）。release-please は必ず除外する
- 判定は固定語彙（上表）でエンジンが決定する。Claude は再判定しない（迷ったら `要確認`）
- merge は policy の `irreversible` gate（既定 `ask`）に従う。`--auto` は明示 opt-out として確認をスキップするため、まず `--dry-run` で内容を確認してから使う運用を推奨する
- 新規 runtime 依存は追加しない（Node stdlib + `gh` / `git` のみ）
