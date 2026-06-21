# usage-guard verification runbook

How to verify the Claude-Code-only `usage-guard` skill (epic #119). The
deterministic signal is covered by an automated integration test that runs in
CI; the live `ScheduleWakeup` pause→resume behaviour is covered by an opt-in
manual harness because it cannot be reproduced hermetically. See also the
in-process unit tests `tests/usage-check.test.mjs` and
`tests/usage-guard-hook.test.mjs`.

## A. Automated integration test (CI)

`tests/usage-guard-integration.test.mjs` spawns the REAL
`src/skills/usage-guard/{usage-check,usage-guard-hook}.mjs` as child processes
and asserts on the actual exit code + stdout/stderr. It is fully hermetic: each
spawn runs with `HOME=<tmpHome>` (a `fs.mkdtemp` dir under `os.tmpdir()`), so it
never touches the real `~/.claude`, and it seeds
`<tmpHome>/.claude/usage-guard/cache.json` to control the budget signal. Because
both scripts are cache-first, the seeded cases never reach the OAuth endpoint;
the no-cache cases have no credentials file, so they don't either.

Run it (with the rest of the suite):

```bash
pnpm test
# or just this file:
node --test 'tests/usage-guard-integration.test.mjs'
```

Cases exercised:

| # | Scenario | Expected |
| --- | --- | --- |
| 1 | hook + over-threshold cache (5h 99%) | exit 2, stderr `Usage Limit reached` + `resets at HH:MM` + `[origin: main session]` |
| 2 | hook + over-threshold + `agent_id` payload | exit 2, stderr `[origin: subagent abc123]` |
| 3 | hook + ok cache | exit 0, no deny output |
| 4 | hook + empty home (no cache/creds) | exit 0 (fail-open), stderr warns `unavailable` / `failing open` + `DEGRADED` `source=fail-open` |
| 5 | hook + `USAGE_GUARD_THRESHOLD=10` over an `ok:false` cache | exit 2, deny names `≥ 10%` |
| 6 | usage-check CLI + over cache | exit 0, stdout JSON `source:"cache"`, `ok:false` |
| 7 | usage-check CLI + empty home | exit 0, stdout JSON `ok:true`, `source:"fail-open"`, `resume_buffer_seconds:300`, `suspected_reflection_lag:false` |
| 8 | usage-check CLI + over cache (buffered) | exit 0, JSON `source:"cache"`, `wait_seconds`/`resume_buffer_seconds` round-trip |

### Post-reset resume buffer & fail-open visibility (issue #129)

In-process unit coverage adds:

- **Resume buffer** (`tests/usage-check.test.mjs`): `evaluate()` folds a
  post-reset buffer into `wait_seconds` only when over threshold; `resets_at`
  stays the raw window edge; `resume_buffer_seconds` is reported on every
  result. Default is 300s; `USAGE_GUARD_RESUME_BUFFER_SECONDS` overrides it (0 =
  legacy resume-at-edge; negative/non-numeric → default). `getUsage` threads the
  env value through both the endpoint and fail-open results.
- **Fail-open degradation** (`tests/usage-guard-hook.test.mjs`): a non-endpoint
  `source` (`fail-open` / `jsonl`) still ALLOWs but emits a `DEGRADED` warning
  (the `fail-open` wording flags that the guard is **not actually monitoring**);
  `endpoint` / `cache` stay silent. The deny "~N min" hint is derived from the
  buffered `wait_seconds`.

### Reflection-lag detection & cache bypass (issue #133)

After a window resets, the endpoint can briefly echo the PREVIOUS window's
residue: the reset already happened (`resets_at` points at the *next* boundary)
yet `utilization` still reads ~100%. Treating that at face value would propose a
~full-window (~5h) wait for an already-recovered budget — a false negative the
`resume_buffer` (#129, a "reset hasn't arrived yet" mitigation) does not cover.

`evaluate()` now computes, per exceeded window, how long it has been since that
window's boundary (`elapsed = period - (resets_at - now)`; period 18000s for 5h,
604800s for 7d). If an exceeded window is barely past its boundary
(`elapsed < USAGE_GUARD_LAG_EPSILON_SECONDS`, default 900) it is flagged
`suspected_reflection_lag: true`, and `wait_seconds` collapses to a short recheck
interval (`USAGE_GUARD_LAG_RECHECK_SECONDS`, default 180) instead of a full
window + buffer. `resets_at` is left at the raw window edge (information
preserved). A suspected-lag result is **not written to the cache**, so the next
check hits the live endpoint and can pick up the real post-lag value immediately.

In-process unit coverage (`tests/usage-check.test.mjs`) asserts:

- boundary-just-passed + util 100% → `suspected_reflection_lag:true`,
  `wait_seconds == recheck (180)`, `ok:false`, `resets_at` unchanged;
- well past the boundary + util 100% → `suspected_reflection_lag:false`, legacy
  `wait_seconds == full window + buffer`;
- `ok:true` (under threshold) → never flags a lag;
- `USAGE_GUARD_LAG_EPSILON_SECONDS` / `USAGE_GUARD_LAG_RECHECK_SECONDS` overrides
  take effect (a tight epsilon disables the flag; a custom recheck sets the wait);
- `getUsage` threads the lag env through the endpoint result AND does **not**
  cache a lagged read, while a normal over-threshold result still caches.

### Self-sustaining cache via the hook path (issue #135)

`getUsage` now defaults `writeFileImpl`/`mkdirImpl` to the real `node:fs/promises`
implementations (symmetric with `readFileImpl`). Before #135 these defaulted to
`undefined`, so `writeCache()` early-returned (a silent no-op) for any caller
that did not inject fs — notably the PreToolUse hook, which calls `getUsage()`
with no deps. The cache was therefore never written through the hook, and every
tool call paid a cold endpoint fetch (~0.44s) instead of converging to one fetch
per TTL.

In-process unit coverage asserts:

- **`tests/usage-check.test.mjs`**: `getUsage` with NO fs injection writes the
  cache file on endpoint success (real-fs defaults create the nested cache dir);
  a regression guard that the defaults are wired (not `undefined`); the
  `suspected_reflection_lag:true` cache bypass (#133) and the `fail-open` no-cache
  behaviour are both preserved when driven through the DEFAULT fs path.
- **`tests/usage-guard-hook.test.mjs`**: driving the REAL `getUsage` (no fs
  injection beyond a tmp `cachePath` + a fetch spy) through `resolveUsage` twice
  — the first call (cold cache) fetches the endpoint once and writes the cache;
  the second call is served from that self-written cache with NO second fetch,
  proving the hook path is self-sustaining (TTL-bounded single fetch).

The CLI integration test (`tests/usage-guard-integration.test.mjs`, fail-open
case) additionally asserts the `suspected_reflection_lag` field is present
(false) on the real spawned process output.

See the skill's `SKILL.md` §環境要件 for why the endpoint path can be blocked
(api.anthropic.com egress + `~/.claude/.credentials.json` read) and how to
restore it so `source` is `endpoint` rather than a degraded fallback.

## B. `/usage-guard` standalone pause→resume (manual)

Uses `scripts/usage-guard-smoke.mjs` against the REAL
`~/.claude/usage-guard/cache.json` (B/C run in a live Claude session, which
reads the real cache). Print the exact session commands any time with:

```bash
node scripts/usage-guard-smoke.mjs steps
```

Steps:

1. Shell: `node scripts/usage-guard-smoke.mjs seed-over 75` — seed an
   over-threshold cache (5h 99%, resets in 75s).
2. Shell: `node scripts/usage-guard-smoke.mjs watch 240` — leave it polling for
   the resume marker.
3. Claude: `/usage-guard "node scripts/usage-guard-smoke.mjs mark"` — usage-guard
   sees the over cache, `ScheduleWakeup`-waits ~75s, then on resume runs the
   continuation, which writes `/tmp/ug-resumed.marker`.
4. The watcher prints `PASS (resumed after Ns)` once the marker appears.
5. Shell: `node scripts/usage-guard-smoke.mjs clear` — **always** clean up the
   seeded cache.

## C. `/drive` budget-aware loop (manual)

> usage-guard is **on by default** in `drive` (Claude Code only; opt out with
> `--no-usage-guard`). The legacy `--usage-guard` flag is accepted as a
> deprecated no-op alias. See the `drive` row in the repo `README.md` and
> `src/skills/drive/SKILL.md` (§オプション).

1. Shell: `node scripts/usage-guard-smoke.mjs seed-over 75`.
2. Claude: `/drive "<a trivial idempotent task>"` — usage-guard runs by default,
   so at the first resumable-unit boundary the loop Reads the usage-guard
   engine, sees over threshold, waits for the window to reset, then re-enters
   `/drive <args>` and continues.
3. Confirm the run paused then resumed (engine log / wave boundary).
4. Shell: `node scripts/usage-guard-smoke.mjs clear`.

To verify the opt-out path, repeat step 2 with `/drive --no-usage-guard
"<task>"` and confirm the loop runs straight through without a pause. To verify
graceful degrade, run with the `usage-guard` skill absent and confirm `drive`
logs a one-line warning and proceeds (fail-open) instead of erroring.

Inspect the live signal at any point with
`node scripts/usage-guard-smoke.mjs status`.

## What cannot be auto-tested, and why

The `ScheduleWakeup` pause→resume cycle (sections B & C) is **not** covered by
CI. It depends on two things a hermetic, deterministic test can't provide:

- **Real time** — the wakeup fires minutes later when the usage window resets;
  a unit test would have to either sleep for real (flaky, slow) or mock the
  clock, which defeats the point of verifying the real pause.
- **The agent runtime** — `ScheduleWakeup` is an agent-harness primitive, and
  resuming the continuation command (`/usage-guard "<cmd>"` /
  `/drive <args>`) is driven by the Claude Code harness, not by a
  plain Node process.

CI therefore verifies the deterministic budget signal and the hook decision
(section A); a human drives the real pause/resume with the opt-in harness
(sections B & C).
