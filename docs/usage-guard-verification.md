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
| 7 | usage-check CLI + empty home | exit 0, stdout JSON `ok:true`, `source:"fail-open"`, `resume_buffer_seconds:300` |
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

## C. `/drive --usage-guard` budget-aware loop (manual)

1. Shell: `node scripts/usage-guard-smoke.mjs seed-over 75`.
2. Claude: `/drive --usage-guard "<a trivial idempotent task>"` — at the first
   resumable-unit boundary the loop Reads the usage-guard engine, sees over
   threshold, waits for the window to reset, then re-enters
   `/drive --usage-guard <args>` and continues.
3. Confirm the run paused then resumed (engine log / wave boundary).
4. Shell: `node scripts/usage-guard-smoke.mjs clear`.

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
  `/drive --usage-guard <args>`) is driven by the Claude Code harness, not by a
  plain Node process.

CI therefore verifies the deterministic budget signal and the hook decision
(section A); a human drives the real pause/resume with the opt-in harness
(sections B & C).
