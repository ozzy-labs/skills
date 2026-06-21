#!/usr/bin/env node
// usage-guard-smoke — OPT-IN, MANUAL harness for the usage-guard runbook (B/C).
//
// This is NOT a test. It is intentionally excluded from `node --test`:
//   - it lives under scripts/, while the test glob is `tests/**/*.test.mjs`, and
//   - it is named *.mjs (never *.test.mjs).
//
// Why it can't be a CI test: runbook sections B & C exercise usage-guard's
// `ScheduleWakeup` pause→resume against a LIVE Claude Code session and the REAL
// ~/.claude/usage-guard/cache.json. That round-trip is real-time (the wakeup
// fires minutes later) and depends on the agent runtime resuming a continuation
// command — neither of which a deterministic, hermetic CI test can reproduce.
// The integration test (tests/usage-guard-integration.test.mjs) covers the
// deterministic signal; THIS harness drives the parts that need a human + the
// real harness.
//
// It operates on the REAL cache file at ~/.claude/usage-guard/cache.json
// (because B/C run in a live session against the real cache). SAFETY: after a
// run, ALWAYS execute `node scripts/usage-guard-smoke.mjs clear` to remove the
// seeded cache so a stale over-threshold signal does not block your next
// session. The cache TTL is only ~45s, but `clear` is the clean reset.
//
// Subcommands:
//   seed-over [seconds=75]  write an over-threshold cache (5h 99%, 7d 10%,
//                           resets in N seconds), cached_at=now.
//   seed-ok                 write an under-threshold (ok) cache.
//   clear                   remove the cache file and the resume marker.
//   status                  run the REAL usage-check.mjs and print its JSON.
//   mark                    write /tmp/ug-resumed.marker with a timestamp
//                           (use as the continuation command in test B so the
//                           resume is observable).
//   watch [seconds=240]     poll for the marker; print PASS (resumed after Ns)
//                           when it appears, or TIMEOUT after the budget.
//   steps                   print the exact runbook B & C session commands.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CACHE_DIR = join(homedir(), ".claude", "usage-guard");
const CACHE_PATH = join(CACHE_DIR, "cache.json");
const MARKER_PATH = "/tmp/ug-resumed.marker";

// usage-check.mjs is shipped as a sibling of SKILL.md. Prefer the user-scope
// install; fall back to the dogfood project-scope copy in this repo.
const USER_SCOPE_CHECK = join(homedir(), ".claude", "skills", "usage-guard", "usage-check.mjs");
const REPO_CHECK = join(
  dirname(new URL(import.meta.url).pathname),
  "..",
  ".claude",
  "skills",
  "usage-guard",
  "usage-check.mjs",
);

function resolveCheckScript() {
  if (existsSync(USER_SCOPE_CHECK)) return USER_SCOPE_CHECK;
  return REPO_CHECK;
}

/** Write a cache file wrapping `result` with a fresh `cached_at`. */
async function writeCache(result) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify({ cached_at: Date.now(), result }, null, 2));
}

async function seedOver(seconds) {
  // `seconds` is the time to the window edge; the live evaluate() folds a
  // post-reset buffer (default 300) into wait_seconds, so mirror that here so
  // the seeded cache looks like a real over-threshold result (#129).
  const resumeBuffer = 300;
  const resetsAt = new Date(Date.now() + seconds * 1000).toISOString();
  await writeCache({
    five_hour: { utilization: 99, resets_at: resetsAt },
    seven_day: { utilization: 10, resets_at: null },
    ok: false,
    wait_seconds: seconds + resumeBuffer,
    resets_at: resetsAt,
    resume_buffer_seconds: resumeBuffer,
    suspected_reflection_lag: false,
    source: "endpoint",
  });
  console.log(`seeded OVER cache → ${CACHE_PATH}`);
  console.log(
    `  5h 99% (resets in ${seconds}s @ ${resetsAt}), 7d 10%, ok:false, resume_buffer ${resumeBuffer}s`,
  );
}

async function seedOk() {
  await writeCache({
    five_hour: { utilization: 40, resets_at: null },
    seven_day: { utilization: 50, resets_at: null },
    ok: true,
    wait_seconds: 0,
    resets_at: null,
    resume_buffer_seconds: 300,
    suspected_reflection_lag: false,
    source: "endpoint",
  });
  console.log(`seeded OK cache → ${CACHE_PATH} (5h 40%, 7d 50%, ok:true)`);
}

async function clear() {
  await rm(CACHE_PATH, { force: true });
  await rm(MARKER_PATH, { force: true });
  console.log(`cleared ${CACHE_PATH} and ${MARKER_PATH}`);
}

function status() {
  const script = resolveCheckScript();
  if (!existsSync(script)) {
    console.error(`usage-check.mjs not found (looked at ${USER_SCOPE_CHECK} and ${REPO_CHECK})`);
    process.exitCode = 1;
    return;
  }
  const res = spawnSync("node", [script], { encoding: "utf8" });
  if (res.stderr) process.stderr.write(res.stderr);
  process.stdout.write(res.stdout);
}

async function mark() {
  const stamp = new Date().toISOString();
  await writeFile(MARKER_PATH, `${stamp}\n`);
  console.log(`wrote resume marker ${MARKER_PATH} @ ${stamp}`);
}

async function watch(seconds) {
  const startedAt = Date.now();
  const deadline = startedAt + seconds * 1000;
  // Remove any stale marker so we only observe a fresh resume.
  await rm(MARKER_PATH, { force: true });
  console.log(`watching for ${MARKER_PATH} (budget ${seconds}s)…`);
  while (Date.now() < deadline) {
    if (existsSync(MARKER_PATH)) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`PASS (resumed after ${elapsed}s)`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`TIMEOUT (no resume within ${seconds}s)`);
  process.exitCode = 1;
}

function steps() {
  console.log(`usage-guard manual runbook (B & C) — copy/paste session commands
============================================================

Prereqs (shell):
  - usage-guard installed user-scope (npx @ozzylabs/skills install) OR run
    from inside this repo (dogfood project-scope copy is used as fallback).

── B. /usage-guard standalone pause→resume ─────────────────────────────────
1. Shell:  node scripts/usage-guard-smoke.mjs seed-over 75
2. Shell:  node scripts/usage-guard-smoke.mjs watch 240   (leave running)
3. Claude: /usage-guard "node scripts/usage-guard-smoke.mjs mark"
     → usage-guard sees the OVER cache, ScheduleWakeup-waits ~75s, then on
       resume runs the continuation, which writes the marker.
4. The watcher prints  PASS (resumed after Ns)  once the marker appears.
5. Shell:  node scripts/usage-guard-smoke.mjs clear     (ALWAYS clean up)

── C. /drive budget-aware loop (usage-guard default-on) ─────────────────────
1. Shell:  node scripts/usage-guard-smoke.mjs seed-over 75
2. Claude: /drive "<a trivial idempotent task>"
     → usage-guard runs by default (opt out with --no-usage-guard). At the
       first resumable-unit boundary the loop Reads the usage-guard engine,
       sees OVER, waits for the window, then re-enters /drive <args> and
       continues.
3. Confirm the drive run paused then resumed (engine log / wave boundary).
4. Shell:  node scripts/usage-guard-smoke.mjs clear     (ALWAYS clean up)

Inspect the live signal at any time:
  node scripts/usage-guard-smoke.mjs status
`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "seed-over":
      await seedOver(Number.isFinite(Number(arg)) && arg ? Number(arg) : 75);
      break;
    case "seed-ok":
      await seedOk();
      break;
    case "clear":
      await clear();
      break;
    case "status":
      status();
      break;
    case "mark":
      await mark();
      break;
    case "watch":
      await watch(Number.isFinite(Number(arg)) && arg ? Number(arg) : 240);
      break;
    case "steps":
      steps();
      break;
    default:
      console.error(
        `usage: node scripts/usage-guard-smoke.mjs <seed-over [s] | seed-ok | clear | status | mark | watch [s] | steps>`,
      );
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`usage-guard-smoke: ${err?.message ?? err}`);
  process.exitCode = 1;
});
