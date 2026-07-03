---
name: lessons-triage
description: セッション教訓 queue（~/.agents/lessons/queue.jsonl）を消化し、transcript から User Skills に関する教訓を抽出して、承認された分のみ ozzy-labs/skills へ issue 起票する。「教訓を整理して」「lessons を消化して」「セッションの振り返り」で発火。
---

# lessons-triage - セッション教訓の HITL トリアージ

セッション終了時に capture hook（dotfiles の `lesson-capture.sh`）が `~/.agents/lessons/queue.jsonl` へ蓄積したセッションメタ情報を消化し、transcript から **User Skills の改善に関する教訓のみ** を抽出して、ユーザー承認済みの教訓を ozzy-labs/skills の issue として起票する。

## 前提と原則

- **v1 のスコープは User Skills の改善のみ。** 一般的な教訓（ユーザー好み・コーディング規約等）は対象外
- **auto-apply 経路なし。** issue 起票は中央 autonomy policy の `externally-visible` gate（ゼロコンフィグ既定 `batch-confirm`）に従い、一括確認で承認された分のみ行う
- **metrics-primed な反映チャネル。** `skill-metrics` の rollup（`/skill-metrics --snapshot` が出力する skill 別発火件数 + 注目イベント）を triage の**優先付け起点**として受け取れる。起票する `[lessons]` issue は「fix を運ぶ器」ではなく **backlog ポインタ（どこを見るかの優先 index）** — rollup を定量的根拠として添えるが、**診断・修正は transcript のあるローカルで行い** fix-PR を生む（issue 自体は fix を運ばない。[#162](https://github.com/ozzy-labs/skills/issues/162)）
- **反映（送信）は常に明示 opt-in・HITL。** ローカルでの rollup 集計・優先付けは自動でよいが、issue 起票（外部反映）は下記 policy gate で承認された分のみ。**rollup 引用にも逐語トランスクリプト・payload・secret・raw repo 名/cwd/PR 生値を含めない**（`skill-metrics` の rollup は `event.schema.json` の `additionalProperties: false` により既に metadata のみ）
- **transcript の内容を外部 CLI / 外部サービスへ渡さない。** gemini-delegate 等への委譲は禁止（transcript は private リポの内容や端末出力中の秘密情報を含みうる）
- **issue 起票以外の外部反映を行わない。** リポ編集・PR 作成・メモリ書き込みは本 skill のスコープ外
- queue / processed への書き込みは**追記のみ**。queue 自体は書き換えない（capture hook との競合回避）

## アクション分類と policy 参照

本 skill は個別の承認ゲートを prose にハードコードせず、中央 autonomy policy（`policy` skill が定義する 3 クラス・gate 語彙の SSOT）に従う。自分の唯一の外部反映アクションを次のように分類する:

| 本 skill のアクション | クラス | policy 参照 | ゼロコンフィグ既定 gate |
| --- | --- | --- | --- |
| issue 起票（`gh issue create`） | `externally-visible` | `--action=issue-create` | `batch-confirm`（全教訓を一覧提示し 1 回の一括選択） |

有効 gate は sibling の `policy` skill の `policy-read.mjs` で引く（Claude Code の user-scope では `~/.claude/skills/policy/policy-read.mjs`、dogfood は `<repo>/.claude/skills/policy/policy-read.mjs`、Codex/Gemini は `~/.agents/skills/policy/policy-read.mjs`）:

```bash
node <policy skill のディレクトリ>/policy-read.mjs --action=issue-create --repo-root="$PWD"
# => .resolved.gate（既定 batch-confirm）
```

- `batch-confirm`（既定）: 抽出した全教訓を 1 回の一覧で提示し、起票する分をまとめて選択（一括確認）する
- `ask`: 教訓 1 件ごとに明示承認を得る（policy で厳格化された場合のフォールバック）
- `proceed`: 承認なしで起票（自動起票を望む場合のみ policy で明示 opt-in）

**policy 不在でも壊れない:** `policy-read.mjs` は fail-safe 設計で、読めない・不正な値は厳しい側（`ask`）へ倒す。`policy` skill 自体が未配置の環境では、上表のゼロコンフィグ既定 gate（`externally-visible`=`batch-confirm`）を直接適用する。いずれの場合も auto-apply（無確認起票）にはならない。

## 入力

| ファイル | 役割 |
| --- | --- |
| `~/.agents/lessons/queue.jsonl` | capture hook の出力。1 行 = 1 セッション終了イベント（`queued_at` / `cli` / `session_id` / `cwd` / `transcript_path` / `reason`） |
| `~/.agents/lessons/processed.jsonl` | 本 skill の処理済み記録。1 行 = 1 セッション（`processed_at` / `session_id` / `cli` / `outcome`） |
| `/skill-metrics --snapshot` の rollup（任意） | `skill-observability` が捕捉したイベントを `skill-metrics` が集計した JSON（`window` / skill 別 `invocations`・`outcomes` / `signals` / `notable`）。triage の**優先付け起点**（metrics-primed）。既に metadata のみに洗浄済みで、逐語ログ・payload・raw repo 名/cwd/PR 生値を含まない |

引数: `--limit N` で 1 回に処理する最大セッション数を指定（デフォルト 10、古い順 = FIFO。transcript の失効前に消化するため）。

## 手順

### 1. 未処理セッションの特定

1. `~/.agents/lessons/queue.jsonl` が存在しない・空の場合は「queue は空」と報告して終了する
2. queue の `session_id` 集合から `processed.jsonl` に記録済みの `session_id` を除外する
3. 同一 `session_id` の重複行（resume 往復等で発生）は最新の 1 行に集約する
4. 古い順に最大 `--limit` 件を処理対象とする

### 2. プレフィルタ（破棄候補の一括処理)

以下に該当するセッションは教訓抽出をスキップし、破棄候補としてまとめてユーザーに提示する。確認後 `processed.jsonl` へ記録する:

- `transcript_path` のファイルが存在しない（失効）→ `outcome: transcript-missing`
- transcript に skill 呼び出しの痕跡がない（インストール済み skill の実行記録が見当たらない）→ `outcome: no-skill-usage`
- lessons-triage 自身を実行したセッション → `outcome: self`

### 3. 教訓抽出

#### 3.0 metrics-primed 優先付け（任意・推奨）

observability layer（`skill-observability` が捕捉 → `skill-metrics` が集計）が敷かれている環境では、transcript 精読の**順序付け**に `skill-metrics` の rollup を使う（metrics-primed）。まず rollup を取得する:

```bash
node <skill-metrics のディレクトリ>/skill-metrics.mjs --snapshot
# => window / skills[].invocations・outcomes / signals / notable
```

rollup の **notable（fallback / HITL 却下 / loop 上限到達 / 中断）** と **abort・fallback 件数の多い skill** を優先精読対象にする。件数主義（小 n では率を出さない）に従い、rollup は「どの skill をどの順で見るか」の index として使い、原因の断定には使わない（診断は transcript で行う）。rollup が空・未蓄積・取得失敗でも triage は通常どおり全セッションを古い順に読む（fail-open）。

残った各セッションの transcript を読み、以下に該当する出来事を抽出する:

1. **skill の誤発火 / 不発火**: 意図しない skill が起動した、または発火すべき場面で起動しなかった
2. **手順の曖昧さ・誤り**: skill の手順どおりに進めた結果、ユーザーの修正・差し戻しが発生した
3. **実行中の摩擦**: skill 実行中の繰り返しエラー、再試行、手順の迂回
4. **新 skill / 機能候補**: 既存 skill でカバーされていない反復的な手作業

transcript が大きい場合は skill 実行区間を優先して読む（全文の逐語読解は不要）。各教訓は以下に整理する:

- **対象 skill**: skill 名（新規候補の場合は「新規」）
- **事象**: 何が起きたか
- **根拠**: transcript 内の該当箇所の要約（逐語引用は最小限）
- **改善案**: SKILL.md / アダプタ wrapper のどこをどう変えるか

### 4. HITL 承認と issue 起票

抽出した教訓を **policy の `externally-visible` gate に従って一括確認** する（issue 起票 = 外部可視アクション。「アクション分類と policy 参照」参照）。gate=`batch-confirm`（ゼロコンフィグ既定）では、全教訓を 1 回の一覧で提示し、起票する教訓をまとめて選択（multiSelect）してもらう。gate=`ask` に厳格化されている場合のみ 1 件ずつの承認にフォールバックする。auto-apply（無確認の一括起票）は行わない。

一括確認で承認された教訓のみ、以下の形式で issue を起票する:

```bash
gh issue create --repo ozzy-labs/skills --title "[lessons] <skill>: <要約>" --body "<本文>"
```

本文テンプレート（**backlog ポインタ**形式 — 「どこを見るか」に絞り、fix・診断詳細は載せない）:

```markdown
## 教訓（backlog ポインタ）

<事象の説明。どの skill のどこを見るべきかに絞る>

## 定量ベースライン（metrics-primed の場合）

- 対象 skill: <skill> — 発火 <N> 件 / notable <fallback|hitl.rejected|loop.hit_cap|aborted> <M> 件
- window: <since> 〜 <until>（rollup は metadata のみ・逐語ログ / payload / raw path なし）

## 根拠

- セッション: <cli> / <queued_at>
- <該当箇所の要約（逐語引用なし）>

## 次アクション（ローカルで実施）

<transcript のあるローカルで診断し fix-PR を作る。この issue は fix を運ばず、優先 index として機能する>

---
Filed by lessons-triage (session: <session_id>)
```

**issue 本文に transcript の逐語引用・機密情報（トークン、内部パス、private リポの内容等）を含めない。** rollup を引用する場合も **metadata（件数・window）のみ**とし、逐語ログ・payload・secret・raw repo 名/cwd/PR 生値は載せない。要約のみを記載する。

### 5. 処理済み記録

教訓抽出まで終えたセッションの `session_id` を `processed.jsonl` へ追記する:

```json
{"processed_at": "<ISO 8601>", "session_id": "<id>", "cli": "<cli>", "outcome": "issues-created:<N>" }
```

`outcome` は `issues-created:<N>` / `no-findings` / `discarded` / `transcript-missing` / `no-skill-usage` / `self` のいずれか。

### 6. 完了報告

```text
lessons-triage 完了:
  処理セッション: N 件（プレフィルタ破棄: M 件）
  抽出教訓:      K 件
  起票 issue:    J 件
    - <issue URL> [lessons] <skill>: <要約>
  残 queue:      L 件（次回 --limit で消化）
```

## backlog への接続（`auto-ok` ラベル運用・HATL 第 2 点）

起票した `[lessons]` issue は backlog ポインタ（優先 index）であり、`/backlog --auto`（[#175](https://github.com/ozzy-labs/skills/issues/175)）の消化対象に接続することで改善ループの反映（reflect）→ 消化（consume）が閉じる。接続は `auto-ok` ラベルで境界制御する（HATL）。

- **`auto-ok` は人間のみが付与する。** これは backlog のラベル規約と一致する（backlog SKILL.md「`--auto` の HATL ゲーティング」= `auto-ok` は人間のみ付与・自動付与経路を作らない）。**lessons-triage は起票時に `auto-ok` を付けない**（`gh issue create` に `--label auto-ok` を渡さない）。自動付与経路を本 skill に作らないことが HATL の要。
- **人間の境界制御は 2 点に収束する（HATL）:**
  1. **起票承認** — 手順 4 の `externally-visible` gate（既定 batch-confirm）。どの教訓を issue 化するかを人間が選ぶ。
  2. **`auto-ok` ラベル付与** — 起票済み `[lessons]` issue を人間が見て、無確認で drive に流してよいものだけに `auto-ok` を付ける（standing 承認 = 境界条件の設定）。
- **接続の流れ:** `auto-ok` 付与後、`/backlog --auto`（cron routine や `/loop` から起動可）が `auto-ok` issue のみを無確認で `drive` に流し fix-PR を生む。`auto-ok` の無い `[lessons]` issue は `--auto` の消化対象にならず、通常の backlog 提示（既定モード）で人間が着手を選ぶ。
- ラベルを付けない限りループは自動で回らない（**ゲーティングなしの自動消化は存在しない**）。auto-ok を付けるか否かが、自己改善ループを自動で回すかの唯一の意思決定点になる。

週次 routine（`skill-metrics --snapshot` → metrics-primed lessons-triage → `/backlog --auto`）でループ全体を定期起動する構成は README「Observability」の routine recipe を参照する。

## 注意事項

- `.env` ファイルは読み取らない
- `gh` CLI が未認証の場合はエラーメッセージを表示して中断する
- `skill-metrics` の rollup は read-only な**優先付け起点**にすぎない（原因の断定には使わず、診断・修正は transcript のあるローカルで行う）。rollup のトレンド比較（前週比）は `skill-metrics` の責務、週次 routine 化は README「Observability」の routine recipe の責務。本 skill は起票（reflect）と `auto-ok` ラベル運用による backlog 接続を担う（[#184](https://github.com/ozzy-labs/skills/issues/184)）
- 将来拡張（メモリ / AGENTS.md / CLAUDE.md への反映ルート）は本 skill のスコープ外。手順 4 の分類ロジックに反映先ルートを後付けできる設計とする
