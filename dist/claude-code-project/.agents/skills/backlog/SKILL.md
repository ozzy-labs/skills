---
name: backlog
description: open issue を `backlog.mjs` エンジンで収集し、依存グラフ（drive の依存記法 SSOT を再利用）と固定語彙の優先度規則で並べ、着手候補を提示して drive 引数形式（例 `#12,#15 -> #18`）で出力する。既定は提示のみ、`--drive[=N]` で確認後 drive へ、`--auto` は `auto-ok` ラベル付き issue のみ無確認で drive へ（HATL）。単一リポのみ。
---

# backlog - open issue を優先度整理して drive へ接続

drive は「着手する issue 番号を人間が与える」前提で、自律ループの**上流**（何に着手するかの選定）が skill 化されていなかった。本スキルはその断絶を埋める: open issue を収集し、依存グラフと優先度で並べ、着手候補を drive 引数形式で提示・接続する。

決定論（issue 収集・依存抽出・優先度ソート・`auto-ok` ゲーティング・drive 引数の整形・レンダリング）は同梱の **`backlog.mjs` エンジン**が担う（[ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R1、先行例 `drive-plan.mjs` / `topics.mjs` / `health-check.mjs` / `policy-read.mjs`）。本 SKILL.md は判断層 — **いつエンジンを呼ぶか・候補をどう提示するか・どこで人に確認するか（policy gate）** — に絞る。Claude が自由判断で優先順位を作らない（順位はエンジンの固定語彙が決める）。

**スコープ**: 単一リポジトリのみ。cross-repo backlog は将来検討（[スコープ外](#スコープ外)参照）。

## 入力

```text
backlog
  --repo owner/repo   (省略時は cwd の origin から解決)
  --label <filter>    (gh issue list へ渡すラベル絞り込み)
  --limit N           (収集上限。既定 20)
  --drive[=N]         (上位 N 件 + 依存閉包を確認後 drive へ。N 省略で全候補)
  --auto              (無確認で drive へ。ただし `auto-ok` ラベル付き issue のみ対象)
```

`--dry-run` 相当（提示のみ・副作用なし）は **既定挙動**なのでフラグ不要。

## 手順

1. **本 SKILL.md と同じディレクトリ**の `backlog.mjs` を Bash で実行する（引数はそのまま渡す）。Claude Code では `~/.claude/skills/backlog/backlog.mjs`（dogfood は `<repo>/.claude/skills/backlog/backlog.mjs`、Codex/Gemini は `.agents/skills/backlog/backlog.mjs`）:

   ```bash
   node <この skill のディレクトリ>/backlog.mjs [--repo owner/repo] [--label <filter>] [--limit N] [--drive[=N] | --auto]
   ```

   エンジンは既定で **整形済みテキスト**（優先度順の候補表 + blocker 一覧 + drive 引数形式）を stdout に出力する。`--json` で構造化 JSON を得られる。

2. エンジンの出力を **そのまま提示**する（再整形・再解釈・再ソートしない — 収集・依存抽出・優先度規則はすべてエンジンの責務）。
3. `repo_error` が立っている（GitHub remote 不在）場合は、その旨を提示し `--repo owner/repo` の明示を促す。`fetch_error`（gh 未認証 / rate limit / network）が立っている場合はエンジンの分類をそのまま伝える。
4. drive への接続は下記モード分岐と **policy の `externally-visible` gate** に従う。

## 依存記法（SSOT は drive）

依存抽出の文法（`depends on #X` 系）と抽出規則、そして依存を wave に分割するロジックは **drive 側の SSOT**（`drive-plan.mjs` の `detectBodyDeps` / `topoWaves`、canonical は drive SKILL.md「明示依存記法」「Phase 0」）。`backlog.mjs` はそれを **import して再利用**する。本 SKILL.md でも `backlog.mjs` 内でも規則を**再掲しない**（drift 防止）。依存グラフの意味を確認したいときは drive SKILL.md を参照する。

「blocker」= 収集した他 issue から依存されている issue（`detectBodyDeps` が検出した被依存先）。エンジンはこれを優先度規則 (a) と drive 引数の wave 順の両方に反映する。

## 優先度規則（固定語彙・上から優先）

エンジンが下表の固定語彙で決定論的にソートする。Claude はこの順位を**再解釈・上書きしない**。

| 順位 | 規則 | 判定 |
| --- | --- | --- |
| (a) | **blocker**（他 issue から依存される） | 被依存先を先に |
| (b) | **milestone 期限 昇順** | `milestone.dueOn` が早い順。期限なし / milestone なしは最後 |
| (c) | **`priority:high` 等のラベル** | 固定語彙 `priority:high` / `priority: high` / `p0` / `p1`（case 無視）を持つ issue を先に |
| (d) | **updatedAt 古い順** | 最終更新が古い（放置された）issue を先に |
| tie-break | **issue 番号 昇順** | 上記すべて同点なら番号の小さい順（完全決定論） |

この固定語彙は `backlog.mjs` に実装されている。語彙を増減する場合は `backlog.mjs` + 本表の同時改訂で行う（Claude の自由判断でラベル語彙を足さない）。

## 出力（drive 引数形式）

エンジンは選定結果を drive がそのまま解釈できる引数文字列で返す（`handoff.drive_args`）:

- 依存のない候補群 → カンマ列 `#1,#2,#3`
- クリーンな依存構造（各 wave のノードが直前までの全ノードに（推移的に）依存する）→ drive の依存記法 `->` で wave 表現 `#12,#15 -> #18`（#18 は #12,#15 の完了後）

wave 分割は drive の `topoWaves` を再利用する。ただし独立ノードと依存ノードが混在し、wave 表現が**偽の依存辺を捏造してしまう**場合（drive は `A,B -> C` を「C は A と B 両方に依存」と解釈するため、無関係な wave-mate の失敗で C が誤って skip され得る）は、`->` を使わず**優先度順のフラットなカンマ列**にフォールバックする。この場合 drive 側の Phase 0 が同じ `detectBodyDeps`（`drive-plan.mjs`）で issue 本文から実 DAG を再構築するため、偽の辺は生まれない。いずれの形式もそのまま `/drive <drive_args>` に渡せる（`handoff.faithful` がどちらを出力したか示す）。

## drive への接続（モード分岐）

| モード | 起動条件 | 挙動 |
| --- | --- | --- |
| **present**（既定） | `--drive` / `--auto` なし | 候補表 + `drive_args` を提示するのみ。drive は起動しない。ホストの確認 UI でユーザーが選択したら、その部分集合の drive 引数を出力するか `/drive` を起動する |
| **drive** | `--drive[=N]` | 上位 N 件（依存を含む閉包に拡張）を確認 UI で提示 → 承認後 `/drive <drive_args>` を起動 |
| **auto** | `--auto` | 個別確認なしで drive へ。ただし対象は `auto-ok` ラベル付き issue のみ（下記 HATL）。policy gate に従う |

## `--auto` の HATL ゲーティング（`auto-ok` ラベル必須）

`--auto` は「無確認で drive を起動する」が、**対象は `auto-ok` ラベルの付いた issue に限る**。これは HATL（human-at-the-loop）: **人間は個別承認をせず、代わりにラベルで境界条件を設定する**。

- ラベル規約: `auto-ok` は **人間のみ**が付与する。誰が・いつ付けるかを運用で固定し、自動付与経路を作らない。ラベル付与 = その issue を無確認で drive に流してよいという standing 承認。
- エンジンの強制: `--auto` 時、エンジンは `auto-ok` ラベルのない issue を handoff 集合から**必ず除外**する（`handoff.excluded_no_label`）。さらに、`auto-ok` issue が **`auto-ok` でない issue に依存**している場合はその issue も除外する（`excluded_unapproved_dep`・カスケード）。承認されていない issue を drive が着手することはない。
- **ゲーティングなしの `--auto` は存在しない**。`auto-ok` ラベルの issue が 1 件もなければ handoff 集合は空になり、drive は起動されない。

## 接続時の policy 参照（`externally-visible` gate）

backlog が drive を起動すると、drive は PR 作成・（`--merge` 時）マージ等の**外部可視・不可逆アクション**を行う。したがって backlog からの **drive 起動そのものを外部可視アクションとして分類**し、個別の承認ゲートを prose にハードコードせず、中央 autonomy policy（`policy` skill が定義する 3 クラス・gate 語彙の SSOT）に従う。分類とゼロコンフィグ既定:

| 本 skill のアクション | クラス | policy 参照 | ゼロコンフィグ既定 gate |
| --- | --- | --- | --- |
| drive 起動（`--drive` / `--auto`） | `externally-visible` | `--action=drive-launch --class=externally-visible` | `batch-confirm`（起動する drive 引数を 1 回提示して一括確認） |

有効 gate は sibling の `policy` skill の `policy-read.mjs` で引く（Claude Code の user-scope では `~/.claude/skills/policy/policy-read.mjs`、dogfood は `<repo>/.claude/skills/policy/policy-read.mjs`、Codex/Gemini は `.agents/skills/policy/policy-read.mjs`）:

```bash
node <policy skill のディレクトリ>/policy-read.mjs --action=drive-launch --class=externally-visible --repo-root="$PWD"
# => .resolved.gate（既定 batch-confirm）
```

gate ごとの挙動:

- gate=`batch-confirm`（ゼロコンフィグ既定）:
  - `--drive`: 起動する drive 引数を 1 回提示して一括確認 → 承認後 `/drive` 起動
  - `--auto`: `auto-ok` ラベルが standing 承認（境界条件）として機能するため、handoff 集合（= `auto-ok` issue のみ）を 1 回提示して起動する。個別確認はしない
- gate=`proceed`: 確認なしで起動
- gate=`ask`: drive 引数を 1 件ずつ確認する（`--auto` でも fail-safe に個別確認へ格上げ）

**policy 不在でも壊れない:** `policy-read.mjs` は fail-safe 設計で、読めない・不正な値は厳しい側（`ask`）へ倒す。`policy` skill 未配置の環境では上表のゼロコンフィグ既定 gate（`externally-visible`=`batch-confirm`）を直接適用する。いずれの場合も `--auto` の `auto-ok` ゲーティングは常に効く。

## 定期実行との連携（`schedule` / `/loop`）

`--auto` + `--limit` を `schedule`（cron routine）や `/loop` から起動すると、「`auto-ok` を付ければ自動で消化される」ループが閉じる（[ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R5）。例: `/backlog --auto --limit 3`。人間の関与は「`auto-ok` ラベル付与」の 1 点に収束する。

## エラーハンドリング（エンジンが JSON に載せる）

| 状況 | エンジンの動作 |
| --- | --- |
| `--repo` 未指定で GitHub remote 不在 | `repo_error` を立てる。gh のデフォルトリポ解決に委ねず明示を促す |
| `gh` 未認証 / rate limit / network | `fetch_error` に分類を載せる。候補は空 |
| open issue 0 件 | `issues: []`。handoff は空 |
| 循環依存 | drive 引数をフラットなカンマ列にフォールバックし `warnings` に記録 |

## スコープ外

| 項目 | 除外理由 |
| --- | --- |
| 1. cross-repo backlog | 現時点では単一リポのみ。複数リポ横断の選定は別 issue で検討 |
| 2. 優先度規則の自由化 | 順位は固定語彙のみ。LLM の自由判断で順位を作らない（再現性・信頼性のため） |
| 3. drive 実行の内部 | 本 skill は選定と起動のみ。実装・review・マージは drive の責務 |

## 注意事項

- `.env` ファイルは読み取り・ステージングしない
- 依存記法の SSOT は drive（`drive-plan.mjs`）。backlog は import で再利用し、規則を再掲しない
- **`drive` skill を同階層に要する**: `backlog.mjs` は sibling の `drive/drive-plan.mjs` を import する（依存規則の重複を避けるため）。backlog は drive へ handoff する skill なので drive は常に併存する前提。単体 install（backlog のみ）は想定しない
- 優先度は固定語彙（上表）でエンジンが決定する。Claude は再ソートしない
- `--auto` は必ず `auto-ok` ラベルでゲートする（ゲーティングなしの無確認起動は存在しない）
- drive 起動は policy の `externally-visible` gate（既定 `batch-confirm`）に従う
