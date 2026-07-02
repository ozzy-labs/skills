---
name: policy
description: 中央 autonomy policy の契約（policy.schema.json）と読取 substrate（policy-read.mjs）の定義。アクション 3 クラス・gate 語彙・policy.yaml 階層・ゼロコンフィグ既定の SSOT。他スキル・hook から参照される。
user-invocable: false
---

# policy - 中央 autonomy policy の契約と読取 substrate

HITL ゲートが各 skill の prose に分散していた状態を、**1 ファイルの宣言**へ集約する被参照 companion（ADR-0028 R3）。**アクション分類と gate 決定の契約（policy.schema.json）と、その有効値を読み出す all-adapter CLI（policy-read.mjs）の SSOT** を提供する。集計や適用（各 skill / hook 側）は本契約の上に別途構築する。

## 原則

- **契約の一元化**: 「どのアクションが承認を要するか」を skill ごとの prose ではなく policy 1 ファイルで宣言する。skill は自アクションを 3 クラスのいずれかに分類し、policy を引くだけにする。
- **fail-safe（fail-open ではない）**: 壊れた／敵対的な policy は自律度を**緩めてはならない**。`policy-read.mjs` は throw しないが、信頼できない値は必ず**厳しい側（`ask`）**へ倒す。observability の fail-open（失敗しても素通し）とは逆向きの安全側フォールバック。
- **ゼロコンフィグ = 現行挙動相当**: policy.yaml が無いときの既定は現状の挙動と等価（受け入れ条件）。設定を増やしても「設定して忘れる」で壊れない。

## アクションの 3 クラス

skill は自分のアクションを次の固定語彙のいずれかに分類する:

| クラス | 例 | ゼロコンフィグ既定 |
| --- | --- | --- |
| `reversible-local`（可逆ローカル） | branch 上の編集、safe branch delete、worktree prune | `proceed`（+ audit trail） |
| `externally-visible`（外部可視） | issue 起票、PR 作成、topics 適用、PR コメント | `batch-confirm`（1 回の一括確認） |
| `irreversible`（不可逆・破壊的） | merge、publish、stash drop、force 系 | `ask`（常時 Approval Gate） |

## gate の語彙

各クラス / アクションに割り当てる値は次の 3 つのみ:

| gate | 意味 |
| --- | --- |
| `proceed` | そのまま実行し audit trail を残す（確認しない） |
| `batch-confirm` | 実行前に 1 回だけ一括確認する |
| `ask` | 1 操作ごとに Approval Gate（明示承認）を通す |

## policy ファイルの階層

```text
~/.agents/policy.yaml          # user 既定（HOME-anchored）
<repo>/.agents/policy.yaml     # repo 上書き（user を上書き）
```

repo が user を上書きし、user がゼロコンフィグ既定を上書きする。ファイル形式（`policy.schema.json` が SSOT）:

```yaml
schema_version: 1
classes:
  reversible-local: proceed
  externally-visible: batch-confirm
  irreversible: ask
actions:
  merge: ask            # アクション個別上書き（クラス既定より優先）
  issue-create: proceed
```

`classes` は 3 クラスの gate を宣言し、`actions` は kebab-case のアクション名ごとに gate を上書きする（クラス既定より優先）。未知の**トップレベルキー**は `additionalProperties: false` で機械的に拒否される。アクション名は各 skill が自前で宣言するため開いており、値（gate 語彙）とキー形状のみ検証する。

## 契約（policy.schema.json が SSOT）

`policy.schema.json`（本 skill の sibling）が唯一の SSOT。`policy-read.mjs` も test も**このファイルを読んで**検証するため doc とコードの drift が起きない。skill-observability の `event.schema.json` と同方式で、`additionalProperties: false`（トップレベル）が typo / 未知キーによる「意図しない自律度の緩み」を機械的に防ぐ。`schema_version` は `1` に固定。

## 読取 substrate（policy-read.mjs）

`policy-read.mjs`（sibling・全 adapter で動く CLI）が user + repo の policy.yaml を読んでマージし、**マージ済みの有効値を JSON で stdout に返す**。YAML は新規 runtime 依存を避けるため、policy.yaml が要する最小サブセット（ネストした mapping + `key: value` + コメント）を自前パースする。

```bash
# マージ済み有効 policy（classes / actions / sources / degraded）を JSON で返す
node policy-read.mjs

# 単一アクションの有効 gate を解決（action 個別上書き → クラス既定 → 厳しい側）
node policy-read.mjs --action=merge          # => resolved.gate（既定 ask）
node policy-read.mjs --action=issue-create   # => resolved.gate（既定 batch-confirm）
node policy-read.mjs --class=reversible-local

# repo ルートを明示（既定は cwd）
node policy-read.mjs --repo-root=/path/to/repo
```

出力（例・ゼロコンフィグ時）:

```json
{
  "schema_version": 1,
  "classes": { "reversible-local": "proceed", "externally-visible": "batch-confirm", "irreversible": "ask" },
  "actions": {},
  "sources": { "user": false, "repo": false },
  "degraded": false
}
```

fail-safe の作法:

- **ファイル不在** → ゼロコンフィグ既定（現行挙動相当）。`degraded: false`。
- **不正な gate 値**（schema 不一致）→ その class / action の有効値を `ask` に倒す。下位優先度の緩い値に落ちない。
- **parse 不能なファイル** → そのファイルを無視し `degraded: true`。もう一方のファイル + 既定で解決する（危険クラスの既定は元々 `ask`）。
- あらゆる失敗で throw せず exit 0。`&&` で連結した caller を壊さない。

## 適用範囲

本 skill は **契約（schema）+ 読取 substrate** のみを提供する。以下は本契約の上に別 PR で構築する（本 PR には含めない）:

- **各 skill の適用**（implement / lessons-triage / topics 等のゲート記述を「自アクションを分類して policy を引く」に置換）。
- **Claude Code の PreToolUse hook**（`policy-hook.mjs`。`gh pr merge` / `gh release` 等を実行エンジン側で policy 参照して deny/allow）。

## 注意事項

- `.env` ファイルは読み取らない。
- 本 skill は read-only。policy.yaml の生成・書き換えは行わない（別 PR の `policy init` が担う）。
- fail-safe は「厳しい側に倒す」であり observability の fail-open（素通し）とは逆向き。混同しない。
