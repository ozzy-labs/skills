---
name: usage-guard
description: Monitors Claude Code's Usage Limit (5-hour = Current / weekly = Weekly), pauses work when it exceeds 95%, and automatically resumes once the reset restores headroom. Bundles an engine form that a caller such as drive Reads at a checkpoint, and a standalone form, `/usage-guard "<continuation command>"`, that guards arbitrary work. Claude-only (depends on the OAuth usage-rate endpoint + ScheduleWakeup).
user-invocable: true
argument-hint: "<continuation command> (leave blank to just check status)"
disable-model-invocation: true
---

# usage-guard - Usage Limit pause/resume engine

When Claude Code's Usage Limit reaches 100%, the session is interrupted. This skill provides a mechanism that pauses work just before 100% (default 95%) and automatically resumes once the reset restores headroom.

> **Claude-only**: Gated with `adapters: claude-code` because it depends on the OAuth usage-rate endpoint (the token in `~/.claude/.credentials.json`) and `ScheduleWakeup` (not distributed to Codex / Gemini / Copilot).
>
> **Self-contained document**: This SKILL.md does not Read other files (the canonical ones under `~/.agents/skills/...`). Because the gate means the codex adapter's `.agents/` output doesn't exist here, the full procedure is embedded in this document.

## Obtaining the signal: the usage-check script

The deterministic part of the decision is handled by `usage-check.mjs`. It is bundled directly under the skill directory — at `~/.claude/skills/usage-guard/usage-check.mjs` in user-scope, and at `~/.claude/skills/usage-guard/usage-check.mjs` in dogfood. **At execution time, run the `usage-check.mjs` in the same directory as this SKILL.md** via Bash:

```bash
node ~/.claude/skills/usage-guard/usage-check.mjs
```

> When running in dogfood (inside the skills/commons repo), run `~/.claude/skills/usage-guard/usage-check.mjs` at the repo root. In either environment, this refers to "the `usage-check.mjs` at the same level as this SKILL.md."

## Environment requirements (the endpoint path must be usable)

The **canonical decision path** for `usage-check.mjs` is the OAuth usage-rate endpoint (`source: "endpoint"`). To use it, the Bash that runs the script must be permitted to do the following two things:

- **(a) Egress to api.anthropic.com**: it hits `GET https://api.anthropic.com/api/oauth/usage`. If the harness's sandbox / network permissions **block** sending to this host, the endpoint path fails.
- **(b) Reading `~/.claude/.credentials.json`**: it reads `claudeAiOauth.accessToken` every time. If the permissions allowlist doesn't allow reading this file, the token can't be obtained and the endpoint path fails.

**What happens if these aren't allowed**: if the endpoint fails, it degrades to the JSONL fallback (a rough estimate) → and in the worst case, to **fail-open** (`source: "fail-open"`, `ok: true`), which can leave **the guard effectively OFF without anyone noticing**. In practice, there have been cases where the relevant request from Bash was consistently denied by the sandbox / permission gate, making the endpoint unusable.

**How to allow it**:

- network: allow egress to `api.anthropic.com` in the harness's settings (if using a sandbox, add this host to the allowlist).
- permissions: add Read access to `~/.claude/.credentials.json` and permission to run the `node` process that launches `usage-check.mjs` as allowlist entries in settings permissions.
- After configuring, run `node .../usage-check.mjs` once and confirm the output JSON's `"source"` is **`endpoint`** (or `cache` within the immediately following TTL). If it stays `jsonl` / `fail-open`, one of (a) or (b) above is still blocked.

> **fail-open is a degraded signal**: When `source !== "endpoint"` (especially `fail-open`), the wait-loop / standalone form / PreToolUse hook issue a **degradation warning** (while still allowing). The drive caller should leave this degradation in its report ("⚠️ usage-guard degraded: source=fail-open, not actually monitoring").

### Behavior

- Re-reads `claudeAiOauth.accessToken` from `~/.claude/.credentials.json` **every time** (accounting for `expiresAt` expiry)
- Fetches `five_hour` / `seven_day` `utilization` and `resets_at` in one call via `GET https://api.anthropic.com/api/oauth/usage` (headers `Authorization: Bearer` / `anthropic-beta: oauth-2025-04-20` / `User-Agent: claude-code/<version>`)
- A 30–60s local cache (`~/.claude/usage-guard/cache.json`, not placed under `~/.claude/skills/`) prevents rapid repeated calls. Shares the same cache as the PreToolUse hook in `#123`
- On endpoint failure, a JSONL fallback estimates the 5h / 7d window from the per-message `usage` + timestamp in `~/.claude/projects/*/*.jsonl`
- **fail-open** (`ok: true`) if **both** the endpoint and JSONL fail, + a warning to stderr (so the guard never hard-stops on its own bug)
- Adds a **post-reset buffer** (default +300 seconds) to `wait_seconds` when over the threshold. This absorbs the delay in server-side `utilization` propagation and the jitter in ScheduleWakeup firing, preventing re-entry into headroom that's cut exactly at the reset boundary and immediately tripping again (see "Threshold" / "Behavior: resume buffer" below)
- **Reflection-lag detection** (`suspected_reflection_lag`): right after a reset, the server-side `utilization` can sometimes return **an afterimage of the previous window** (e.g., 5h util 100% even though it has already reset). If the over-threshold window is **right at the boundary** (elapsed time since the window started, `elapsed = period - (resets_at - now)`, is under epsilon=900 seconds), this is treated as a contradiction, and `wait_seconds` switches from the full-window value to a **short recheck interval** (default 180 seconds) instead. This result is not written to cache (see "Behavior: reflection-lag detection" below)

### Output JSON

```json
{
  "five_hour": { "utilization": 0, "resets_at": "..." },
  "seven_day": { "utilization": 0, "resets_at": "..." },
  "ok": true,
  "wait_seconds": 0,
  "resets_at": null,
  "resume_buffer_seconds": 300,
  "suspected_reflection_lag": false,
  "source": "endpoint"
}
```

- `ok`: `true` if **`utilization + headroom` for both windows** is under the threshold (`headroom` default 0, in which case this means both windows' `utilization` is under the threshold; see "dispatch headroom" below)
- `wait_seconds`: seconds until the **latest** `resets_at` (the window that resets last) among the over-threshold windows, **plus `resume_buffer_seconds`**. `0` when `ok`. **When `suspected_reflection_lag` is `true`**, this degrades to the short recheck interval (`USAGE_GUARD_LAG_RECHECK_SECONDS`, default 180 seconds)
- `resets_at`: the `resets_at` of that latest over-threshold window (**left unchanged at the window boundary** — neither the buffer nor the lag degradation is applied). `null` when `ok`. The expected resume time = `resets_at + resume_buffer_seconds`, kept distinct
- `resume_buffer_seconds`: the post-reset buffer seconds folded into `wait_seconds` (default 300; 0 restores prior behavior)
- `suspected_reflection_lag`: `true` if reflection lag is suspected (over-threshold right at the boundary). When `true`, `wait_seconds` becomes the short recheck interval, and this result is **not written to cache** (so the next check can fetch the real endpoint value immediately). Always `false` when `ok`. Set on both the endpoint and jsonl paths
- `source`: `endpoint` / `jsonl` / `cache` / `fail-open`

### Behavior: resume buffer

When an over-threshold state is detected, `resume_buffer_seconds` (default 300 seconds) is added to `wait_seconds`. This extends the wait from `resets_at` (the window boundary) to `resets_at + buffer`, avoiding the server-side reflection delay right after a reset and allowing a clean, single re-entry into the new window (in practice, "reset + a few minutes" achieves a clean resume).

- `resets_at` is **left unchanged at the window boundary**. The expected resume time is expressed as `resets_at + resume_buffer_seconds`
- No buffer is added when `ok` (not over threshold) (`wait_seconds: 0`)
- The PreToolUse hook's deny hint ("N minutes left") is also derived from `wait_seconds`, so it is presented with the buffer folded in, keeping things consistent

### Behavior: reflection-lag detection (avoiding false negatives right at the boundary)

Right after a reset, the server-side `utilization` can sometimes drag along **an afterimage of the previous window** (e.g., the 5h window resets at 21:00, but the endpoint at 21:05 still returns util 100%, while `resets_at` already points to the next boundary at 02:00 — a contradictory state). Treating this state at face value produces a false negative that "wastes ~5h leaving an already-recovered window idle." `resume_buffer` (`#129`) is a countermeasure premised on "the reset hasn't arrived yet," and doesn't help in this case.

Detection principle: for each over-threshold window, compute the **elapsed time since the window started**, `elapsed = period - (resets_at - now)` (period = 18000 seconds for `five_hour`, 604800 seconds for `seven_day`). If `elapsed` is under epsilon (`USAGE_GUARD_LAG_EPSILON_SECONDS`, default 900 seconds) and it's over threshold, this is a **contradiction** → set `suspected_reflection_lag = true` as a suspected reflection lag.

- When lag is suspected, `wait_seconds` becomes the **short recheck interval** (`USAGE_GUARD_LAG_RECHECK_SECONDS`, default 180 seconds) instead of full-window+buffer. The caller should not pin a long-lived CronCreate right at the boundary, but instead re-fetch at this short interval to pick up the real value once the lag clears
- `resets_at` is **left unchanged at the window boundary** (no information is discarded)
- A suspected-lag result is **not written to cache** (this prevents the previous window's false 100% from being pinned in the cache for the whole TTL and suppressing rechecks — the next check fetches the real endpoint value immediately)
- When `ok` (under threshold), no lag judgment is made and `suspected_reflection_lag` is always `false`

### Behavior: dispatch headroom (countering wave overshoot, `#141`)

**The problem (in-wave overshoot)**: in orchestration, wave / worker dispatch commits to **N non-interruptible units** (such as heavy workers) at the moment of launch, and those **consume headroom while running**. If a boundary checkpoint gates dispatch based only on "**current** `utilization` vs. threshold," it cannot account for a wave's worth of projected consumption, and the wave can blow past the threshold and hit 100% mid-run. `ok:false` is only detected **after the fact** at the next boundary, and can't prevent that wave's overshoot (observed in practice: `five_hour` 86% → 98% over one wave, with 3 parallel workers). Simply lowering the threshold can't account for concurrency / worker weight either (starting at 86% with `threshold=90` still dispatches, since 86<90, then overshoots).

**Countermeasure**: gate `evaluate()`'s trip decision on the **projected post-dispatch value**, not the **current value**. It accepts a `headroom` (in percentage points, default 0), and the trip condition per window becomes `utilization + headroom >= threshold`. The dispatch checkpoint passes a reservation proportional to concurrency (`--concurrency`) as `headroom`, and **pauses before dispatch** if `util + reserve(N) >= threshold`.

- `headroom` **only affects the threshold comparison**. The computation of `wait_seconds` / `resets_at` / reflection lag is **unchanged** and does not scale with the size of headroom (the wait for a tripped window is always window-boundary + buffer only; different headroom values that trip the same window produce the same wait)
- The default `headroom=0` is prior behavior (gate on the current value). **Backward compatible**. The single-mode Phase 1 / review-loop checkpoint stays at headroom=0
- **Does not cross the shared cache**: `headroom > 0` (dispatch checkpoint) **neither reads nor writes** `~/.claude/usage-guard/cache.json` (computed with headroom=0 and shared with the `#123` hook). Otherwise it could either mistakenly return a projected-overshoot `ok:true` for headroom=0 (disabling the gate), or contaminate the hook path with a headroom-overshoot `ok:false`. Results with `headroom > 0` always have a `source` other than `cache`
- Negative or non-numeric values are clamped to 0 (a misconfiguration never loosens the guard below the current-value behavior)
- Resolution order is **CLI `--headroom <pct>` > env `USAGE_GUARD_DISPATCH_HEADROOM` > default 0**

```bash
node ~/.claude/skills/usage-guard/usage-check.mjs --headroom 12   # gate on the projected value for this checkpoint only
USAGE_GUARD_DISPATCH_HEADROOM=12 node ~/.claude/skills/usage-guard/usage-check.mjs   # override the default via env
```

> **Difference from the stopgap**: lowering `USAGE_GUARD_THRESHOLD=90` (or 85) is effective as a stopgap mitigation for now, but since it's **static and can't account for concurrency / worker weight**, it's not a substitute for headroom-aware dispatch. Threshold lowering is the stopgap, headroom is the real countermeasure — the two play different roles.
>
> **A boundary checkpoint alone cannot fully prevent in-wave overshoot**. Headroom is a preventive measure that "stops dispatch on a projection," but an overshoot mid-run (mid-unit), once a worker has already launched, isn't stopped at the boundary. The reliable ceiling during a run is owned by the **PreToolUse hook** described below (`#123`). The two are combined as defense in depth (boundary pause + mid-unit ceiling).

### Threshold

Default 95%. Overridable via the environment variable `USAGE_GUARD_THRESHOLD` (e.g. `USAGE_GUARD_THRESHOLD=80`).

Dispatch headroom defaults to 0 (percentage points). Overridable via the environment variable `USAGE_GUARD_DISPATCH_HEADROOM` (e.g. `USAGE_GUARD_DISPATCH_HEADROOM=12`); CLI `--headroom <pct>` takes precedence over env. Negative, non-numeric, or empty values fall back to the default 0 (see "Behavior: dispatch headroom" above).

The post-reset resume buffer defaults to 300 seconds. Overridable via the environment variable `USAGE_GUARD_RESUME_BUFFER_SECONDS` (e.g. `USAGE_GUARD_RESUME_BUFFER_SECONDS=600`). `0` restores prior behavior (resuming exactly at `resets_at`). Negative or non-numeric values fall back to the default 300.

The reflection-lag detection thresholds can also be overridden via env:

- `USAGE_GUARD_LAG_EPSILON_SECONDS` (default 900): the elapsed-seconds threshold for treating something as "right at the boundary." An over-threshold window with `elapsed` smaller than this is treated as suspected lag. Negative, non-numeric, or empty values fall back to the default 900
- `USAGE_GUARD_LAG_RECHECK_SECONDS` (default 180): the short recheck interval used when lag is suspected. Values `<= 0`, non-numeric, or empty fall back to the default 180 (preventing a busy-loop)

## Lightweight wait-loop (shared logic)

The core stop/resume logic shared by both forms:

1. Run `usage-check.mjs` to get the JSON
2. **Degradation check**: if `source !== "endpoint"` (`cache` is excluded, since it originates from the endpoint), issue a degradation warning. In particular, when `source === "fail-open"`, **explicitly surface** "⚠️ usage-guard degraded: source=fail-open, not actually monitoring" **to the caller / user**, and the drive caller should leave this in its report (allow / progress is still maintained; see § Environment requirements)
3. If `ok`, **proceed normally** (run the continuation command / the caller moves to the next checkpoint)
4. If `ok` is `false`, choose a resume trigger (see "Choosing a resume trigger" below) and **wait**
   - **When reflection lag is suspected (`suspected_reflection_lag: true`), recheck at short intervals**. Since `wait_seconds` has already degraded to the short recheck interval (default 180 seconds), don't pin a long-lived one-shot CronCreate at the boundary — instead wait just this short interval via `ScheduleWakeup(wait_seconds)` etc. and hit `usage-check.mjs` again. Once the lag clears, the next check will pick up the real value (typically `ok: true`) and continue (avoiding a false negative that leaves things idle for ~5h on the previous window's afterimage)
   - On a normal over-threshold, `resume_buffer_seconds` (default 300) is already folded into `wait_seconds`, so the wait extends to `resets_at + buffer`
   - **Does not re-enter while waiting** (consumes no budget at all)
5. On waking, run `usage-check.mjs` again, and repeat 2–5 until `ok` (since a suspected-lag result is never written to cache, the recheck fetches the real endpoint value immediately)
6. Once `ok`, proceed to the continuation command

> `wait_seconds` is not second-precise, since it's computed from `resets_at` (+ buffer). ScheduleWakeup's firing is also somewhat delayed by its floor + overhead (in practice, ~110s for a 60s request). This is precise enough for waiting out a reset.

### Choosing a resume trigger

There are 2 mechanisms for resuming after a wait (heartbeat / waking). Use whichever fits the situation:

| Situation | Resume trigger |
|---|---|
| /loop dynamic, in-session, wait **≤1h** | `ScheduleWakeup(min(wait_seconds, 3600))`. Capped at 3600s per call. If `wait_seconds` is longer, recheck across multiple calls |
| Non-/loop orchestration (Agent tool / Workflow drive), wait **>1h**, needs restart resilience | Set a `CronCreate` (`recurring: false`, durable) at **`resets_at + resume_buffer_seconds`**, and re-submit the continuation command when it fires |

- **ScheduleWakeup**: suited to an in-session heartbeat. Since one call is capped at 3600s, a long wait becomes multi-stage. When `wait_seconds > 3600`, repeat `min(wait_seconds, 3600)`.
- **CronCreate one-shot**: fires once by wall clock and is restart-resilient. Robust for `>3600s` and non-/loop cases (Agent tool orchestration, etc.). Set the firing time to `resets_at + resume_buffer_seconds` (the resume time derived from `wait_seconds`). A one-shot (`recurring: false`) **auto-deletes after firing**. In practice, when running a ~72-minute wait via Agent tool orchestration, CronCreate one-shot proved more robust than a multi-stage ScheduleWakeup.

## Usage form 1: engine form (the caller Reads it)

A caller such as drive (`#122`) Reads this SKILL.md at the **boundary of a resumable unit (checkpoint)** and runs the wait-loop above.

### Checkpoint convention

- Always pause at a **boundary that can be cleanly re-entered**. Never pause mid-implement (e.g., before creating a PR)
- The caller runs usage-check at the **entry** of each unit, and enters the wait-loop if not `ok`
- The continuation command is **supplied by the caller**. Since drive resumes idempotently (detecting an existing PR and resuming from Phase 3), the re-run after waiting is reused as-is as the resume mechanism (e.g., `/drive <args>` — since drive's usage-guard is ON by default, don't append `--usage-guard` to the continuation command)
- In drive's orchestration mode, this is called at the granularity of wave boundaries. An over-threshold state within a running worker is caught as a mid-unit ceiling by the PreToolUse hook in `#123`

## Usage form 2: standalone form `/usage-guard "<continuation command>"`

Guards any long-running work with auto pause/resume, independent of drive (user-invocable).

### Arguments

- Interprets `$ARGUMENTS` as the **continuation command**
- **If blank, it's a status check only**: runs `usage-check.mjs`, displays the current `five_hour` / `seven_day` `utilization` and `ok` / `wait_seconds`, then exits

### Steps

1. Run `usage-check.mjs`
2. **Degradation check**: if `source !== "endpoint"` (excluding `cache`), show a degradation warning to the user. When `fail-open`, explicitly state "not actually monitoring" (progress is still maintained; see § Environment requirements)
3. If **both windows are `ok`**, run the continuation command (proceed normally)
4. If **over threshold**:
   - Choose a resume trigger (see § Lightweight wait-loop, "Choosing a resume trigger"). For an in-session wait ≤1h, use `ScheduleWakeup(min(wait_seconds, 3600))`; for >1h and non-/loop, set a `CronCreate` (`recurring: false`) at `resets_at + resume_buffer_seconds` and wait (don't re-enter while waiting; `wait_seconds` already has the buffer folded in)
   - On waking (recovery detected), **self-re-enter `/usage-guard "<continuation command>"`**
   - Repeat the heartbeat until `ok`, then run the continuation command

### Idempotency of the continuation command

The continuation command is treated as **idempotent by assumption**. It is the user's responsibility to ensure it's safe to re-run across a wait (produces no duplicate side effects / detects progress and can resume partway through).

- Since drive is inherently idempotent (detecting an existing PR / branch and resuming), it can be safely wrapped as `/usage-guard "/drive #123"` (drive's usage-guard is ON by default)
- When wrapping general long-running work (a build, a batch job, etc.), confirm for yourself that the design is safe to re-run

### Example usage

```text
/usage-guard "/drive #123"
/usage-guard ""                 # status check only
USAGE_GUARD_THRESHOLD=80 /usage-guard "<continuation command>"   # temporarily set the threshold to 80%
USAGE_GUARD_RESUME_BUFFER_SECONDS=600 /usage-guard "<continuation command>"   # set the resume buffer to 10 minutes
```

## Enabling the PreToolUse hook (recommended in combination)

This skill's stop granularity is the boundary of a resumable unit. Whereas drive's usage-guard checkpoint (`#122`, ON by default via `#130`) can only stop at unit boundaries, the PreToolUse hook (`usage-guard-hook.mjs`) is a mid-unit ceiling that takes effect **before every tool call**, stopping things on the spot even if the threshold is crossed partway through a long unit. The two are combined with a division of labor:

| Mechanism | Granularity | Where it stops |
|---|---|---|
| drive usage-guard checkpoint (`#122` / `#130`, ON by default) | Resumable unit boundary | Cleanly re-enterable checkpoints such as a Phase entry / wave entry / before worker dispatch |
| PreToolUse hook (this section) | Per tool call (including inside subagents) | Mid-unit (in-flight ceiling) |

> **For drive orchestration, wiring the hook as the primary ceiling is recommended by default (`#141`)**: a boundary checkpoint structurally cannot prevent **in-wave overshoot** (a group of heavy workers, once dispatched, consumes headroom while running and can't be stopped at a boundary before hitting 100% — see "Behavior: dispatch headroom" above). Dispatch-headroom is a preventive measure that stops dispatch on a projection, but **this hook, which fires before tool calls inside subagents, is the only reliable ceiling** during a run. Previously, the **pre-`#139`** hook could only be "recommended in combination" due to the risk of hard-stopping on a transient anomalous reading, but **that hard-stop risk has been resolved by `#139`** (file kill-switch / reflection-lag ALLOW / debounce / spike rejection), so in environments running orchestration (`/drive`'s wave parallelism), it's fine to **wire the `matcher:"*"` hook by default**. Any accidental deny can be released instantly with `touch ~/.claude/usage-guard/DISABLE` (see § Disabling). Only by pairing defense in depth — **boundary resumable pause (headroom-aware) + the hook's mid-unit ceiling** — is overshoot practically closed off.
>
> The hook first reads the **same cache** that `usage-check.mjs` writes (`~/.claude/usage-guard/cache.json`, 30–60s TTL). On a hot cache it just returns that, so it doesn't spam the endpoint on every tool call. **On a cold/stale cache, the hook itself falls back to `getUsage` (cache-first), hits the endpoint just once, and writes the result back to the cache (self-sustaining)**. Since `getUsage` writes to the cache using the real fs even for callers that don't inject an fs, the TTL-window fetch converges to just one call even in standalone operation without `usage-check.mjs` having run beforehand (the hook path itself keeps the cache warm). Above the threshold, it denies (exit 2) + presents `resets_at` as `HH:MM`; if usage can't be read, it fails open (allow + stderr warning). Calls originating from a subagent are distinguished in the log via the payload's `agent_id`.
>
> **Degradation visibility**: when usage's `source` is anything other than `endpoint` / `cache` (especially `fail-open`), the hook keeps allowing while issuing a degradation warning to stderr ("⚠️ usage-guard DEGRADED: source=fail-open …"). This is so that the endpoint path being unusable — i.e., the guard effectively being OFF — is never missed. See § Environment requirements for the cause and how to allow it.

### Resilience to transient anomalous readings (`#139`)

The hook has built-in countermeasures against an incident (`#139`) where **a single transient over-threshold reading** — such as a reflection-lag afterimage right at a reset boundary, or a one-off endpoint spike — caused the hook to deny every tool, hard-stopping the session even against edits that would remove the guard. All of these are in service of "never hard-stop on our own bug (fail-open)":

- **(a) file kill-switch (an escape hatch)**: if `~/.claude/usage-guard/DISABLE` exists, the hook immediately becomes a no-op at the very start (allow + warning). Since this preserves an escape hatch while keeping `matcher:"*"` intact, it doesn't lose its role as a mid-unit ceiling monitoring tool calls inside subagents. It can be released/re-enabled with `touch`/`rm` from a `!` shell, instantly within the session with no config edit needed (see § Disabling).
- **(d) reflection lag is ALLOWed**: when usage has `suspected_reflection_lag === true` (a previous-window afterimage right at the boundary), the hook lets it through. If it's a genuine over-threshold, the resumable-unit boundary checkpoint will stop it separately.
- **(b) debounce**: doesn't deny on a single over-threshold reading — only denies once it's exceeded for **N consecutive reads** (default 2, overridable via `USAGE_GUARD_DEBOUNCE_COUNT`). Even a single under-threshold reading in between resets the consecutive count. The consecutive count and the most recent good reading are kept in a **per-origin** state file (see (f) below).
- **(c) spike rejection**: a physically implausible jump from a recent good reading (threshold − `USAGE_GUARD_SPIKE_DELTA`, default under 25) to over threshold within `USAGE_GUARD_SPIKE_WINDOW_SECONDS` (default 120 seconds) is treated as suspect and ALLOWed + warned.
- **(e) cache hygiene for over-threshold readings**: `usage-check.mjs` caches an over-threshold reading with a shortened TTL (10s, vs. the normal 45s). This avoids pinning a transient overshoot for the full TTL and re-verifies it early on the next check.
- **(f) concurrency-safe state (`#211`)**: under Workflow fan-out (up to 16 concurrent subagents, each firing the hook before every tool call) the debounce/spike counter must not be corrupted or lost. Two measures ensure this: **(i) per-origin state files** — the counter lives at `~/.claude/usage-guard/hook-state.json` for the main session and at `hook-state.<agent_id>.json` per subagent, so concurrent hooks (always from *different* origins) never share one file and a read-modify-write can't lose an update; **(ii) atomic writes** — both the state file and the shared `cache.json` are written to a temp sibling and `rename`d into place, so a concurrent reader never observes a torn/half-written JSON. Both bias the guard toward *holding* (never silently dropping a deny) under exactly the high-concurrency load where overshoot is most likely.

A soft-allow via lag/spike/debounce issues a degradation warning to stderr (so the guard doesn't just look like it's OFF).

### Mechanism and placement

The hook itself is bundled as an extra file directly under the skill directory (same path as `usage-check.mjs`). Since this repo does **not** distribute settings/hooks (the build only outputs skills / agents), enabling it is a **manual opt-in**.

### settings.local.json snippet (`update-config` style)

Add one PreToolUse hook entry to `~/.claude/settings.local.json` (settings reload mid-session, so no restart is needed):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node /home/<you>/.claude/skills/usage-guard/usage-guard-hook.mjs"
          }
        ]
      }
    ]
  }
}
```

> **M3: fill in the hook script path as an absolute path by hand.** Since skill-dir-relative references don't work inside settings, `command` must be an **absolute path**. The path varies by environment:
>
> - **user-scope** (placed via `npx @ozzylabs/skills install`): `~/.claude/skills/usage-guard/usage-guard-hook.mjs` (`~` is not expanded, so write it out in full as `/home/<you>/.claude/...`)
> - **dogfood** (run inside the skills/commons repo): `<repo>/.claude/skills/usage-guard/usage-guard-hook.mjs` (e.g. `/home/<you>/github/ozzy-labs/skills/.claude/skills/usage-guard/usage-guard-hook.mjs`)
>
> Both refer to "the `usage-guard-hook.mjs` at the same level as `usage-check.mjs`." Confirm your own environment's full path before filling it in. If overriding the threshold, also attach the env on the settings side (e.g. `"command": "USAGE_GUARD_THRESHOLD=80 node /home/<you>/.claude/skills/usage-guard/usage-guard-hook.mjs"`).

**`matcher` defaults to `"*"` (all tools).** This lets it function as a mid-unit ceiling that also monitors tool calls inside subagents. Since a hard-stop from a transient anomalous reading can be released via the **file kill-switch** (§ Disabling) without narrowing `matcher`, it's fine to keep operating with `matcher:"*"`. If you really want to limit monitoring to only heavy tools (weakening subagent monitoring), you can instead scope it to something like `"matcher": "Bash|Workflow|Task"`, always letting `Edit` / `Read` / `AskUserQuestion` through (optional).

### Disabling

Two ways. **Use the kill-switch when you need something instant with no config edit**:

- **file kill-switch (recommended, instant within the session, `#139` (a))**: creating `~/.claude/usage-guard/DISABLE` makes the hook an immediate no-op at the start. Since it can be run from a `!` shell, it can be released even in a situation where the hook has wrongly denied on a transient anomalous reading and even stopped the very edit meant to remove the guard:

  ```bash
  touch ~/.claude/usage-guard/DISABLE   # disable (instant)
  rm    ~/.claude/usage-guard/DISABLE   # re-enable (instant)
  ```

- **Removing from settings (permanent)**: removing the above PreToolUse entry from `~/.claude/settings.local.json` disables it instantly (mid-session reload).

## Notes

- The guard **never hard-stops on its own bug**: if signal acquisition fails entirely, it fails open and continues work (`source: "fail-open"` + stderr warning)
- However, **fail-open means the guard is OFF**. When `source !== "endpoint"`, each form issues a degradation warning — if you see one, restore the endpoint path per § Environment requirements
- **Watch for false denies from transient anomalous readings (`#139`)**: the PreToolUse hook can falsely deny on a transient over-threshold reading, such as a reflection-lag afterimage or an endpoint spike. Against this, the hook is resilient via (d) lag ALLOW / (b) debounce / (c) spike rejection, and as a last resort can be released instantly within the session with no config edit via the **file kill-switch** (`touch ~/.claude/usage-guard/DISABLE`) (see § Resilience to transient anomalous readings / § Disabling)
- **Watch for in-wave overshoot in orchestration (`#141`)**: a boundary checkpoint cannot stop an overshoot occurring during a wave after dispatch. This is closed off via two layers — **dispatch-headroom** (stops dispatch on a projection; see § Behavior: dispatch headroom) and the **PreToolUse hook** (a mid-unit ceiling during a run; see § PreToolUse hook). Lowering the threshold is a stopgap and not a substitute
- Consumes no budget while waiting (doesn't re-enter — heartbeat only)
- The resume after waiting extends to `resets_at + resume_buffer_seconds` (default +5 minutes), to prevent re-entering headroom cut exactly at the reset and immediately tripping again
- A long wait is assumed to be absorbed by a live session (WSL + always-on). For >1h and non-/loop cases, a CronCreate one-shot (durable) is more robust (see § Lightweight wait-loop)
