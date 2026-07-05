---
name: skill-metrics
description: Aggregates the local observability event log (~/.agents/observability/events.jsonl) and presents, read-only, per-skill invocation counts and notable events (fallback / HITL rejection / loop cap reached / abort). Fires on "show me the skill metrics," "aggregate the observability results," "which skills get used the most?" Does not send anything.
---

# skill-metrics - Aggregation and presentation of skill measurements

Aggregates the events accumulated by `skill-observability` in `~/.agents/observability/events.jsonl`, and presents, read-only, **per-skill invocation counts + notable events**. The "aggregation layer" of the improvement loop.

## Principles

- **Read-only, no sending**: Only reads and presents events. Does not send externally, file issues, or edit files (except writing out a snapshot). Reflection (turning things into issues) is `lessons-triage`'s responsibility.
- **Count-based reasoning + small-n guard**: Because a single author's low frequency doesn't reach statistical significance, **a rate is presented only when the denominator is at or above `min_n`** (default 5, overridable via env `SKILL_METRICS_MIN_N`). Below that, only the count is shown, not a rate (preventing the misleading impression of "1/1 = 100% abort rate").
- **fail-open**: Returns an empty rollup without erroring, even if the log is absent or unreadable.
- **Separation of concerns from health**: `health` covers repo state; `skill-metrics` covers skill behavior.

## Input

Arguments (all optional):

- `--since=<ISO 8601>`: aggregate only events from this time onward
- `--skill=<name>`: aggregate only a specific skill
- `--snapshot`: writes the rollup out to `~/.agents/observability/snapshots/<YYYY-Www>.json` (creates a baseline for trend comparison; what's written is the raw aggregation with the derived `trend` field excluded = a pure baseline)

## Trend comparison (week-over-week)

On each run, the engine reads the **latest snapshot from before this week** found in `~/.agents/observability/snapshots/` (a prior-generation baseline written by a past `--snapshot`), and loads the diff against the current rollup into the `trend` field (`trend: null` if there's no prior generation). `--snapshot` writes out this week's baseline, and **the next run compares against it as the prior week**.

- **Count deltas are always presented**: per-skill `invocations_delta` (change in invocation count), `signals[<name>]` (change in friction signals). Increases/decreases are shown with a plus/minus sign.
- **Rate deltas inherit the small-n guard**: `abort_rate_delta` only produces a number when **both generations'** denominators are at or above `min_n` (each rollup's `abort_rate` is non-null). If either side has n<`min_n`, it's `abort_rate_delta: null` + `abort_rate_delta_suppressed: true` (only the count delta is shown, not the rate).
- `trend.baseline_week` / `trend.baseline_file` indicate the comparison-target snapshot (ISO year-week, **filename only** — no HOME absolute path is included, continuing the privacy stance), and `trend.baseline_window` shows the prior generation's aggregation window.
- If there's only one generation of snapshot, the snapshots dir doesn't exist, or it can't be read, `trend: null` (fail-open; normal rollup presentation continues).

## Steps

1. Run the `skill-metrics.mjs` **in the same directory as this SKILL.md** via Bash to obtain the JSON rollup (pass arguments through as-is). In Claude Code this is `~/.claude/skills/skill-metrics/skill-metrics.mjs` (dogfood: `<repo>/.claude/skills/skill-metrics/skill-metrics.mjs`):

   ```bash
   node <this skill's directory>/skill-metrics.mjs [--since=...] [--skill=...] [--snapshot]
   ```

2. Format the resulting JSON into something human-readable and present it. At minimum, include:
   - **window**: the aggregation period (since / until), total event count, session count
   - **Per skill**: invocation count (`invocations`) and channel breakdown (`by_operation`: `invoke_agent` / `slash_command`). If outcomes exist, counts of completed / aborted / fallback. For the abort rate (`abort_rate`), when `abort_rate_suppressed: true`, note explicitly "hidden due to n<min_n (count only)"
   - **signals**: counts of notable signals (`review.deep_to_quick_fallback` / `usage_guard.fail_open` / `hitl.rejected` / `loop.hit_cap`, etc.)
   - **notable**: a list of friction events (fallback / HITL rejection / loop cap / abort)
   - **trend** (when `trend` is non-null): the week-over-week (vs. `baseline_week`) invocation-count delta (`invocations_delta`) and friction-signal delta (`signals`). When `abort_rate_delta_suppressed: true`, note explicitly "rate delta hidden due to n<min_n (count delta only)." When `trend: null` (first generation, no baseline), note "no prior-week snapshot (comparison available from next time)"
3. If the data is empty (`events: 0`), note "no events accumulated yet — the SessionEnd hook for `skill-observability` may not be wired" (for hook wiring, see `skill-observability`'s SKILL.md, "Enabling the SessionEnd hook").

## Example presentation format

```text
skill-metrics (window: 2026-06-20 to 2026-06-29 / 142 events / 18 sessions / min_n=5)

Per-skill invocations:
  drive    12   (invoke_agent 3, slash_command 9)   abort: hidden due to n<5 (count only)
  review    8   (slash_command 8)
  ship      6   (slash_command 6)

Notable signals:
  usage_guard.fail_open        2
  review.deep_to_quick_fallback 1

notable:
  [signal] review / review.deep_to_quick_fallback (2026-06-28T...)
  [signal] drive  / usage_guard.fail_open          (2026-06-27T...)

Trend (week-over-week / baseline: 2026-W25):
  drive    invocations +4    abort rate delta: hidden due to n<5 (count delta only)
  review   invocations -1    abort rate delta: -0.10
  signals: usage_guard.fail_open +2 / review.deep_to_quick_fallback +1
```

## Notes

- Does not read `.env` files.
- Does not speculatively supplement beyond what's in the event log (count-based reasoning).
- Does not send externally or file issues (reflection is `lessons-triage`'s responsibility).
