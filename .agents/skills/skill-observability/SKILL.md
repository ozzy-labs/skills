---
name: skill-observability
description: skill observability のイベント契約（event.schema.json）と emit substrate（obs-emit.mjs）の定義。skill 改善ループの計測層の SSOT。他スキル・hook から参照される。
adapters: claude-code
user-invocable: false
---

# skill-observability - 計測イベント契約と emit substrate

skill 改善ループ（install→利用→反映）の **計測層** を支える契約とツールを定義する被参照 companion。**イベントの形（schema）と書き込みの作法（emit）の SSOT**、および transcript から発火を事後導出する **痕跡導出 hook（obs-derive.mjs）** を提供する。集計（`/skill-metrics`）や反映は本契約の上に別途構築する。

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

## 痕跡導出 hook（obs-derive.mjs）

`obs-derive.mjs`（sibling・SessionEnd hook）が**主捕捉経路**。セッション終了後に transcript を読み、**どの skill が発火したか**を事後導出して obs-emit substrate 経由で記録する。model に mid-run の自己申告を求めず痕跡から再構成するため、**自己申告バイアス**（中断する最悪の run ほど emit を落とす）を回避する。

導出する reliable コア:

- セッションごとに `heartbeat` 1 件（「観測が走った」記録。空 window が「発火 0」と「hook 未発火」を区別可能に）。
- transcript 中の各 skill 発火につき `start` 1 件。2 チャネル:
  - model 呼出の `Skill` tool_use → `operation: invoke_agent`
  - user 入力の `/slash-command` → `operation: slash_command`（**実在 skill のみ**。sibling に skill dir が無い組込みコマンド `/clear` `/compact` 等は除外しデータ汚染を防ぐ）

skill の引数（機密を含みうる）は**記録しない**（skill 名と channel のみ）。

**deferred（本 hook では導出しない）**: merge/abort の **outcome**。セッション終了時点の merge 状態は未確定で session→PR linkage + 遅延再評価が要り、abort 推定（「PR なしで終了」）は人間中断・冪等 resume と区別できずノイズが多い。reliable・低ノイズを保つため別増分に分離する。

### SessionEnd hook を有効化（手動 opt-in）

本リポは settings/hook を配らない（usage-guard hook と同じ方針）。`~/.claude/settings.json`（または `settings.local.json`）に SessionEnd エントリを追加する。`command` は `obs-derive.mjs` の **絶対パス**（user-scope `~/.claude/skills/skill-observability/...` と dogfood `<repo>/.claude/skills/skill-observability/...` で異なる・自分の path を埋める）:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "node /home/<you>/.claude/skills/skill-observability/obs-derive.mjs" }
        ]
      }
    ]
  }
}
```

stdin の SessionEnd JSON（`session_id` / `transcript_path` / `cwd` / `reason`）を受け取り、常に exit 0・軽量（行は substring プレフィルタしてから JSON.parse）。

## 適用範囲

本 skill は **契約 + emit substrate + 痕跡導出 hook（発火捕捉）** を提供する。以下は本契約の上に別 PR で構築する:

- **outcome 導出**（`gh`/`git` の merge ground truth + session→PR linkage。痕跡導出 hook の次増分）。
- **`/skill-metrics`**（events.jsonl を件数 + 注目イベントで集計）。
- **反映チャネル**（lessons-triage の metrics-primed 化。privacy 洗浄済みロールアップを HITL で backlog ポインタ issue に反映）。

## 注意事項

- `.env` ファイルは読み取らない。
- イベントに逐語ログ・機密・private repo 名/path/PR 生値を含めない（schema が機械的に拒否する）。
