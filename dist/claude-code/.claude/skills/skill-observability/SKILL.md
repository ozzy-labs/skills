---
name: skill-observability
description: skill observability のイベント契約（event.schema.json）と emit substrate（obs-emit.mjs）の定義。skill 改善ループの計測層の SSOT。他スキル・hook から参照される。
user-invocable: false
---

# skill-observability - 計測イベント契約と emit substrate

skill 改善ループ（install→利用→反映）の **計測層** を支える契約とツールを定義する被参照 companion。本 skill 自身は計測を行わず、**イベントの形（schema）と書き込みの作法（emit）の SSOT** を提供する。発火・outcome の実捕捉（痕跡導出 hook）や集計（`/skill-metrics`）は本契約の上に別途構築する。

## 原則

- **痕跡導出を主軸**: 計測は可能な限り `gh`/`git` の ground truth と transcript 痕跡から事後導出する（自己申告バイアスの回避）。skill prompt 内からの inline emit は、痕跡に出ない意味論シグナル（fallback・HITL 却下・loop 上限到達等）に限る従。
- **fail-open**: emit の失敗で被計測 skill を止めない。`obs-emit.mjs` は不在・失敗・検証エラーのいずれでも throw せず、警告を stderr に出して exit 0。
- **privacy（最厳格モード）**: イベントは metadata のみ。`event.schema.json` の `additionalProperties: false` が payload / diff / token / path 等の未知フィールドを**機械的に拒否**する。repo 識別子は raw を保存せず hash（`repo_hash`）のみ。送信（reflection）は常に明示 opt-in・HITL（本 skill は送信経路を持たない）。
- **件数主義**: 単一作者・低頻度のデータ量では統計的有意性に届かないため、本契約は率や信頼区間を強制しない。集計側は件数 + 注目イベントを基本とする。

## イベントログ

```text
~/.agents/observability/events.jsonl   # 追記専用・1 行 1 イベント・OTel 非依存で自己完結
```

HOME-anchored（skills dir の外）。dogfood mirror の再ビルドで消えない。任意の consumer / hook が読める。

## イベント契約（event.schema.json が SSOT）

`event.schema.json`（本 skill の sibling）が唯一の SSOT。`obs-emit.mjs` も test も**このファイルを読んで**検証するため doc とコードの drift が起きない。フィールド名は OpenTelemetry GenAI セマンティック規約の**「形」**に寄せる（`skill`≈`gen_ai.agent.name` / `operation`≈`gen_ai.operation.name`）。規約は experimental なので密結合はしない。

必須フィールド: `schema_version`(=1) / `ts`(ISO 8601) / `adapter` / `session_id` / `skill` / `event`。

`event` の種別:

| event | 用途 | 追加必須 |
| --- | --- | --- |
| `start` | skill 発火 | — |
| `phase` | フェーズ遷移（implement / ship / review 等） | — |
| `outcome` | 終了状態 | `status` ∈ {completed, aborted, fallback} |
| `signal` | 意味論カウンタ（痕跡に出ない遷移） | `name`（固定語彙） |
| `heartbeat` | 「観測が走った」記録（データ不在＝成功の誤読を防ぐ） | — |

`signal.name` の固定語彙（初期）: `review.loop_iter` / `review.deep_to_quick_fallback` / `usage_guard.fail_open` / `hitl.rejected` / `loop.hit_cap`。

privacy: `repo_hash` は 12 桁 hex（sha256 prefix）のみ。raw repo 名・cwd・PR 番号生値は契約上書けない（`additionalProperties: false`）。

## emit substrate（obs-emit.mjs）

`obs-emit.mjs`（sibling・全 adapter で動く CLI）が build→validate→append の write primitive。痕跡導出 hook も inline emit も、最終的にこれを通して 1 イベントを追記する。

```bash
# 例
node obs-emit.mjs --skill=drive  --event=outcome --status=completed
node obs-emit.mjs --skill=review --event=signal  --name=review.loop_iter --value=2
node obs-emit.mjs --skill=drive  --event=heartbeat
node obs-emit.mjs --skill=drive  --event=outcome --status=merged --repo="$(git rev-parse --show-toplevel)"
```

引数: `--skill` / `--event`（必須相当）、`--status` / `--name` / `--value` / `--phase` / `--operation` / `--reason` / `--run`（任意）、`--repo`（hash して `repo_hash` に格納）、`--adapter` / `--session`（既定は env から解決）。

検証に通らないイベント・あらゆる失敗は**追記せず警告して exit 0**（fail-open）。`&&` で連結した caller を壊さない。

## 適用範囲

本 skill は **emit substrate と契約の提供のみ**。以下は本契約の上に別 PR で構築する:

- **痕跡導出 hook**（SessionEnd 等で発火 skill + `gh`/`git` の merge outcome を導出して emit する主経路）。wiring は usage-guard と同様、settings への手動登録を案内する（本リポは hook を自動配線しない）。
- **`/skill-metrics`**（events.jsonl を件数 + 注目イベントで集計）。
- **反映チャネル**（lessons-triage の metrics-primed 化。privacy 洗浄済みロールアップを HITL で backlog ポインタ issue に反映）。

## 注意事項

- `.env` ファイルは読み取らない。
- イベントに逐語ログ・機密・private repo 名/path/PR 生値を含めない（schema が機械的に拒否する）。
