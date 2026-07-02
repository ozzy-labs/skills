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

## PreToolUse enforcement hook（Claude Code / `policy-hook.mjs`）

prose 層（各 skill の「自アクションを分類して policy を引く」）はあくまで **依頼**であり、モデルが無視・迂回し得る。`policy-hook.mjs`（sibling・`usage-guard-hook.mjs` と同型の PreToolUse hook）は**実行エンジン側の gate 強制**で、これを物理的に塞ぐ。全 tool 呼び出し前（subagent 内含む）に発火し、**特定の不可逆コマンド**を検出したときだけ policy を引いて deny/allow を決める。

| 検出コマンド | 引く action（class） | ゼロコンフィグ既定 gate | hook の挙動 |
| --- | --- | --- | --- |
| `gh pr merge …` | `merge`（`irreversible`） | `ask` | deny（exit 2） |
| `gh release create …` | `release-create`（`irreversible`） | `ask` | deny |
| `git push --force` / `-f` / `--force-with-lease` | `force-push`（`irreversible`） | `ask` | deny |
| `npm` / `pnpm` / `yarn publish` | `publish`（`irreversible`） | `ask` | deny |

- **gate → 判定:** 解決した gate が `ask` なら deny（exit 2 + 理由を stderr）、`proceed` / `batch-confirm` なら allow。hook が hard-block するのは `ask` のみ（batch 確認は caller / prose 層の責務）。
- **narrow gating（全 tool deny 事故の防止）:** policy を引くのは**上表の不可逆コマンドにマッチした時だけ**。それ以外（読取・編集・safe な git/gh/npm・非 Bash tool）は素通し。matcher にバグがあっても「危険コマンドを取りこぼす」方向にしか倒れず、全 tool を deny してセッションを wedge させることはない。
- **一過性で hard-stop させない（`usage-guard-hook.mjs` から踏襲）:**
  - **(a) file kill-switch:** `~/.claude/policy-guard/DISABLE` があれば冒頭で即 no-op allow。`!` シェルから `touch` すれば設定編集不要・セッション内で即解除できる。
  - **(b) policy 読取不能・パース不能 → allow + stderr 警告:** `policy-read.mjs` が `degraded` を返す／resolver が throw する等で **gate を信頼できないとき**は deny せず allow する。gate 対象コマンドの検出はできても gate 値を信頼できないなら通す。**resumable prose-layer checkpoint（drive / health / lessons-triage）が同じ `policy-read.mjs`（fail-safe に `ask`）を引く一次ゲート**であり、hook は二次的な網なので broken policy でセッションを止めない側に倒す。
  - **(c) proceed 上書き（`--merge` 相当）:** すでに gate を解決し自律を委任された caller（例 `drive --merge` は prose で merge を `proceed` に上書き）は `POLICY_GUARD_PROCEED=<action>[,<action>…]`（`all` / `*` も可）を export する。hook はその action を再ゲートせず allow する。これで正当な opt-in マージが強制網に阻まれない。
- **subagent:** payload の `agent_id` を deny メッセージに `[origin: subagent <id>]` として付す（走行中 worker の mid-unit ceiling として機能）。

### 配線（推奨: `hooks add policy`）

hook スクリプトは全 adapter payload に同梱される。settings への配線は CLI が担う（[#174](https://github.com/ozzy-labs/skills/issues/174) PR 3 で `hooks add policy` に対応。`usage-guard` / `observability` と同型）:

```bash
# PreToolUse policy gate を ~/.claude/settings.local.json に配線（絶対パスは自動解決）
npx @ozzylabs/skills hooks add policy

# 配線状態の確認
npx @ozzylabs/skills hooks status

# 配線解除（自分が書いたエントリのみ削除）
npx @ozzylabs/skills hooks remove policy
```

CLI が install 済み skill dir から `policy-hook.mjs` の絶対パスを解決し、diff を提示して確認のうえ書き込む（`--yes` で非対話・`--dry-run` で計画のみ・`--scope=user` で `settings.json`）。冪等（再 add は no-op）で、自分が書いたエントリ以外は触らない。**リポは settings / hooks を配信しない**方針は不変で、CLI がユーザー同意のもとローカル settings を書くだけ。

policy.yaml の雛形は `npx @ozzylabs/skills policy init`（`--scope=repo` で `<repo>/.agents/policy.yaml`）で生成できる（既存ファイルは上書きせず skip）。

**fallback（手動配線）:** CLI を使わない場合は手動で `~/.claude/settings.local.json` に 1 エントリ追加する（settings は mid-session reload されるため再起動不要）:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node /home/<you>/.claude/skills/policy/policy-hook.mjs"
          }
        ]
      }
    ]
  }
}
```

> **hook スクリプトパスは絶対パスを手で埋める**（settings 内では skill-dir 相対参照が効かない）。パスは環境で揺れる:
>
> - **user-scope**（`npx @ozzylabs/skills install`）: `~/.claude/skills/policy/policy-hook.mjs`（`~` は展開されないので `/home/<you>/.claude/…` の形でフルに書く）
> - **dogfood**（skills/commons リポ内）: `<repo>/.claude/skills/policy/policy-hook.mjs`
>
> どちらも「`policy-read.mjs` と同じ階層の `policy-hook.mjs`」を指す。matcher は不可逆コマンドが Bash 経由なので `"Bash"` で十分（`"*"` でも可・非 Bash tool は command が無く素通し）。

**無効化:** `touch ~/.claude/policy-guard/DISABLE`（即時・設定編集不要）、または settings から上記エントリを削除（恒久）。

## 適用範囲

本 skill は **契約（schema）+ 読取 substrate + PreToolUse enforcement hook** を提供する。以下は本契約の上に別 PR で構築する（本 PR には含めない）:

- **各 skill の適用**（implement / lessons-triage / topics 等のゲート記述を「自アクションを分類して policy を引く」に置換。R3 PR2/PR3 で実装済み）。
- **hook の自動配線**（`hooks add policy`。[#174](https://github.com/ozzy-labs/skills/issues/174) PR 3 で実装済み。上記「配線」参照）。

## 注意事項

- `.env` ファイルは読み取らない。
- 本 skill は read-only。policy.yaml の生成・書き換えは行わない（別 PR の `policy init` が担う）。
- fail-safe は「厳しい側に倒す」であり observability の fail-open（素通し）とは逆向き。混同しない。
