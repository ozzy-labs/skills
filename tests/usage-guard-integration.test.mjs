// Process-level E2E for the usage-guard skill (epic #119).
//
// Unlike the unit tests (tests/usage-check.test.mjs, tests/usage-guard-hook.test.mjs)
// which exercise the exported pure/injectable functions in-process, THIS file
// spawns the REAL `src/skills/usage-guard/*.mjs` scripts via `node:child_process`
// and asserts on their actual exit code + stdout/stderr. It is the only test
// that proves the end-to-end CLI contract (stdin payload → exit code → message).
//
// Fully HERMETIC:
//   - No network. Both scripts are cache-first (`getUsage` returns a seeded
//     cache without hitting the OAuth endpoint), and the no-cache cases have no
//     `.credentials.json` so `readAccessToken` returns null → the endpoint path
//     is never reached either.
//   - Never touches the real ~/.claude. Each spawn runs with `HOME=<tmpHome>`
//     (the scripts build every path from `os.homedir()` → `$HOME` on POSIX), and
//     the tmpHome is created under `os.tmpdir()` and removed afterwards.
//
// We seed `<tmpHome>/.claude/usage-guard/cache.json` with the
// `{ cached_at, result }` shape usage-check.mjs writes to fully control the
// budget signal.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src", "skills", "usage-guard");
const HOOK = join(SRC, "usage-guard-hook.mjs");
const CHECK = join(SRC, "usage-check.mjs");

let tmpHome;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "usage-guard-it-"));
});

afterEach(async () => {
  if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
  tmpHome = null;
});

/**
 * Seed `<tmpHome>/.claude/usage-guard/cache.json` with a fresh cache wrapping
 * the given `result` (the JSON shape usage-check.mjs emits). `cached_at` is now
 * so the 45s TTL keeps it fresh → cache-first, no endpoint/JSONL.
 * @param {object} result
 */
async function seedCache(result) {
  const dir = join(tmpHome, ".claude", "usage-guard");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "cache.json"), JSON.stringify({ cached_at: Date.now(), result }));
}

/** A reset timestamp ~1h out (so the hook can render `resets at HH:MM`). */
function resetInOneHour() {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

/** Over-threshold cache result: 5h at 99%, 7d at 10%, ok:false. */
function overResult(resetsAt = resetInOneHour()) {
  return {
    five_hour: { utilization: 99, resets_at: resetsAt },
    seven_day: { utilization: 10, resets_at: null },
    ok: false,
    wait_seconds: 3600,
    resets_at: resetsAt,
    source: "endpoint",
  };
}

/** Under-threshold cache result: both windows low, ok:true. */
function okResult() {
  return {
    five_hour: { utilization: 40, resets_at: null },
    seven_day: { utilization: 50, resets_at: null },
    ok: true,
    wait_seconds: 0,
    resets_at: null,
    source: "endpoint",
  };
}

/**
 * Spawn the real script with HOME=<tmpHome>, optionally piping a stdin payload.
 * Resolves with { code, stdout, stderr } on process close.
 * @param {string} script absolute path to the .mjs
 * @param {object} [opts]
 * @param {string|null} [opts.stdin]   payload to write then end (null = no write)
 * @param {Record<string,string>} [opts.env]  extra env vars
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function spawnScript(script, { stdin = null, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [script], {
      env: { ...process.env, HOME: tmpHome, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdin !== null) child.stdin.write(stdin);
    child.stdin.end();
  });
}

// ── Case 1: hook + over-threshold seeded cache → deny (exit 2) ───────────────
test("hook: over-threshold seeded cache → exit 2 with 'Usage Limit reached' + reset time", async () => {
  await seedCache(overResult());
  const { code, stdout, stderr } = await spawnScript(HOOK, { stdin: "{}" });
  assert.equal(code, 2, "over threshold → DENY (exit 2)");
  assert.match(stderr, /Usage Limit reached/, "deny reason names the limit");
  assert.match(stderr, /5h 99%/, "deny reason names the exceeded window");
  assert.match(stderr, /resets at \d{2}:\d{2}/, "deny reason carries the local reset time");
  assert.match(stderr, /\[origin: main session\]/, "no agent_id → main session origin");
  assert.equal(stdout, "", "deny goes to stderr, not stdout");
});

// ── Case 2: hook + subagent agent_id over-threshold → deny tagged subagent ───
test("hook: over-threshold + agent_id payload → exit 2 tagged 'subagent abc123'", async () => {
  await seedCache(overResult());
  const { code, stderr } = await spawnScript(HOOK, { stdin: '{"agent_id":"abc123"}' });
  assert.equal(code, 2, "over threshold → DENY (exit 2)");
  assert.match(stderr, /Usage Limit reached/);
  assert.match(stderr, /\[origin: subagent abc123\]/, "deny reason records the subagent origin");
});

// ── Case 3: hook + ok seeded cache → allow (exit 0), silent ──────────────────
test("hook: under-threshold seeded cache → exit 0 with no deny output", async () => {
  await seedCache(okResult());
  const { code, stdout, stderr } = await spawnScript(HOOK, { stdin: "{}" });
  assert.equal(code, 0, "under threshold → ALLOW (exit 0)");
  assert.equal(stdout, "", "allow path is silent on stdout");
  assert.doesNotMatch(stderr, /Usage Limit reached/, "no deny reason when under threshold");
});

// ── Case 4: hook + no cache / no creds → fail-open allow (exit 0) + warn ─────
test("hook: no cache + no credentials → exit 0 (fail-open) with an 'unavailable' warning", async () => {
  // Empty tmpHome: no cache, no ~/.claude/.credentials.json, no projects dir.
  // resolveUsage → getUsage: endpoint has no token, JSONL has no projects dir,
  // so getUsage returns a fail-open ok:true result and warns on stderr. The
  // hook then ALLOWs (the signal is "ok"), never hard-stopping on its own gap.
  const { code, stdout, stderr } = await spawnScript(HOOK, { stdin: "{}" });
  assert.equal(code, 0, "no signal → fail-open ALLOW (exit 0)");
  assert.equal(stdout, "", "fail-open path is silent on stdout");
  assert.match(stderr, /unavailable/, "warns that the signal is unavailable");
  assert.match(stderr, /failing open/, "warns it is failing open (never hard-stops)");
  assert.doesNotMatch(stderr, /Usage Limit reached/, "fail-open must never emit a deny");
});

// ── Case 5: hook + USAGE_GUARD_THRESHOLD env threads into the deny message ───
test("hook: USAGE_GUARD_THRESHOLD=10 over an ok:false cache → deny names the overridden threshold", async () => {
  // The hook trusts `usage.ok` from the cache (it does not re-evaluate the
  // windows). To keep this case correct against decide(), we seed ok:false with
  // ~12% windows and override the threshold to 10. decide() then re-formats the
  // exceeded windows against the env threshold (12% ≥ 10%) and the env value
  // shows up verbatim in the deny reason — proving the env parses end to end.
  const resetsAt = resetInOneHour();
  await seedCache({
    five_hour: { utilization: 12, resets_at: resetsAt },
    seven_day: { utilization: 5, resets_at: null },
    ok: false,
    wait_seconds: 3600,
    resets_at: resetsAt,
    source: "endpoint",
  });
  const { code, stderr } = await spawnScript(HOOK, {
    stdin: "{}",
    env: { USAGE_GUARD_THRESHOLD: "10" },
  });
  assert.equal(code, 2, "ok:false signal → DENY (exit 2)");
  assert.match(stderr, /Usage Limit reached/);
  assert.match(stderr, /5h 12%/, "names the (low) exceeded window");
  assert.match(stderr, /≥ 10%/, "the overridden threshold env is parsed and surfaced");
});

// ── Case 6: usage-check CLI + over seeded cache → JSON, source=cache, ok=false ─
test("usage-check CLI: over seeded cache → stdout JSON parses, source='cache', ok=false", async () => {
  await seedCache(overResult());
  const { code, stdout } = await spawnScript(CHECK);
  assert.equal(code, 0, "usage-check always exits 0 (the JSON 'ok' is the signal)");
  const json = JSON.parse(stdout.trim());
  assert.equal(json.source, "cache", "served from the seeded cache (no endpoint hit)");
  assert.equal(json.ok, false, "over threshold → ok:false");
  assert.equal(json.five_hour.utilization, 99, "windows round-trip through the cache");
});

// ── Case 7: usage-check CLI + empty tmpHome → fail-open ok:true ──────────────
test("usage-check CLI: no cache / creds / projects → exit 0, JSON ok=true, source='fail-open'", async () => {
  // Empty tmpHome: cache miss → endpoint (no token) throws → JSONL (no projects
  // dir) throws → fail-open. ok:true so a missing signal never blocks work.
  const { code, stdout } = await spawnScript(CHECK);
  assert.equal(code, 0, "fail-open still exits 0");
  const json = JSON.parse(stdout.trim());
  assert.equal(json.ok, true, "fail-open is an 'ok' signal");
  assert.equal(json.source, "fail-open", "both endpoint and JSONL unavailable → fail-open");
});
