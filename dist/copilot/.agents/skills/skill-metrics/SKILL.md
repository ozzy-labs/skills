---
name: skill-metrics
description: ローカルの observability イベントログ（~/.agents/observability/events.jsonl）を集計し、skill 別の発火件数と注目イベント（fallback / HITL 却下 / loop 上限到達 / 中断）を read-only で提示する。「skill のメトリクスを見せて」「観測結果を集計して」「どの skill がよく使われてる?」で発火。送信はしない。
---

# skill-metrics - skill 計測の集計と提示

`skill-observability` が `~/.agents/observability/events.jsonl` に蓄積したイベントを集計し、**skill 別の発火件数 + 注目イベント**を read-only で提示する。改善ループの「集計層」。

## 原則

- **read-only・送信なし**: イベントの読取と提示のみ。外部送信・issue 起票・ファイル編集はしない（snapshot 書き出しを除く）。反映（issue 化）は `lessons-triage` の責務。
- **件数主義 + 小 n ガード**: 単一作者・低頻度ではデータ量が統計的有意性に届かないため、**率は分母が `min_n`（既定 5・env `SKILL_METRICS_MIN_N` で上書き）以上のときのみ提示**する。下回る場合は率を出さず件数のみ（`1/1 で中断率 100%` のミスリードを防ぐ）。
- **fail-open**: ログが無い・読めない場合も空の rollup を返してエラーにしない。
- **health と責務分離**: `health` は repo 状態、`skill-metrics` は skill 挙動。

## 入力

引数（すべて任意）:

- `--since=<ISO 8601>`: 指定時刻以降のイベントのみ集計
- `--skill=<name>`: 特定 skill のみ集計
- `--snapshot`: rollup を `~/.agents/observability/snapshots/<YYYY-Www>.json` に書き出す（トレンド比較の baseline を作る。書き出す内容は導出フィールド `trend` を除いた素の集計 = 純粋な baseline）

## トレンド比較（前週比）

エンジンは実行のたびに、`~/.agents/observability/snapshots/` にある **今週より前の最新スナップショット**（過去の `--snapshot` が書き出した前世代 baseline）を読み、現 rollup との差分を `trend` フィールドに載せる（前世代が無ければ `trend: null`）。`--snapshot` は今週分の baseline を書き出し、**次回の実行がそれを前週として比較**する。

- **件数 delta は常に提示**する: skill 別 `invocations_delta`（発火数の増減）、`signals[<name>]`（摩擦シグナルの増減）。増減はプラス/マイナスで示す。
- **率 delta は小 n ガードを継承**する: `abort_rate_delta` は**両世代とも**分母が `min_n` 以上（各 rollup の `abort_rate` が非 null）のときのみ数値を出す。片側でも n<`min_n` なら `abort_rate_delta: null` + `abort_rate_delta_suppressed: true`（率は出さず件数 delta のみ）。
- `trend.baseline_week` / `trend.baseline_file` が比較対象のスナップショット（ISO 年週・**ファイル名のみ**・HOME 絶対パスは載せない = privacy 継承）、`trend.baseline_window` が前世代の集計 window を示す。
- スナップショットが 1 世代しか無い・snapshots dir が無い・読めない場合は `trend: null`（fail-open、通常の rollup 提示は続行）。

## 手順

1. **本 SKILL.md と同じディレクトリ**の `skill-metrics.mjs` を Bash で実行して JSON rollup を得る（引数はそのまま渡す）。Claude Code では `~/.claude/skills/skill-metrics/skill-metrics.mjs`（dogfood は `<repo>/.claude/skills/skill-metrics/skill-metrics.mjs`）:

   ```bash
   node <この skill のディレクトリ>/skill-metrics.mjs [--since=...] [--skill=...] [--snapshot]
   ```

2. 得た JSON を人間可読に整形して提示する。最低限、以下を含める:
   - **window**: 集計対象期間（since / until）、総イベント数、セッション数
   - **skill 別**: 発火件数（`invocations`）と channel 内訳（`by_operation`: `invoke_agent` / `slash_command`）。outcome があれば completed / aborted / fallback の件数。中断率（`abort_rate`）は `abort_rate_suppressed: true` のとき「n<min_n のため非表示（件数のみ）」と明記する
   - **signals**: 注目シグナルの件数（`review.deep_to_quick_fallback` / `usage_guard.fail_open` / `hitl.rejected` / `loop.hit_cap` 等）
   - **notable**: 摩擦イベント（fallback / HITL 却下 / loop 上限 / 中断）の一覧
   - **trend**（`trend` が非 null のとき）: 前週比（`baseline_week` と比較）の発火数増減（`invocations_delta`）と摩擦シグナル増減（`signals`）。`abort_rate_delta_suppressed: true` のときは「n<min_n のため率 delta 非表示（件数 delta のみ）」と明記する。`trend: null`（1 世代目・baseline 無し）のときは「前週スナップショットなし（次回から比較可能）」と案内する
3. データが空（`events: 0`）の場合は「イベント未蓄積。`skill-observability` の SessionEnd hook が未配線の可能性」と案内する（hook 配線は `skill-observability` の SKILL.md「SessionEnd hook を有効化」を参照）。

## 提示フォーマット例

```text
skill-metrics（window: 2026-06-20 〜 2026-06-29 / 142 events / 18 sessions / min_n=5）

skill 別発火:
  drive    12   (invoke_agent 3, slash_command 9)   abort: n<5 のため非表示（件数のみ）
  review    8   (slash_command 8)
  ship      6   (slash_command 6)

注目シグナル:
  usage_guard.fail_open        2
  review.deep_to_quick_fallback 1

notable:
  [signal] review / review.deep_to_quick_fallback (2026-06-28T...)
  [signal] drive  / usage_guard.fail_open          (2026-06-27T...)

トレンド（前週比 / baseline: 2026-W25）:
  drive    発火 +4    abort 率 delta: n<5 のため非表示（件数 delta のみ）
  review   発火 -1    abort 率 delta: -0.10
  signals: usage_guard.fail_open +2 / review.deep_to_quick_fallback +1
```

## 注意事項

- `.env` ファイルは読み取らない。
- イベントログにある以上の情報を推測で補わない（件数主義）。
- 外部送信・issue 起票はしない（反映は `lessons-triage`）。
