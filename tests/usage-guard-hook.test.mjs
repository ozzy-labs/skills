// Tests for the usage-guard PreToolUse ceiling hook (issue #123).
//
// Everything is exercised through injected deps (usage JSON, cache reader,
// stdin payload, clock, warn/deny sinks) — no network, no real ~/.claude reads,
// no spawned process. The 4 issue cases:
//   (1) under threshold → allow (exit 0)
//   (2) over threshold → deny (exit 2) + reset-time message
//   (3) fresh cache within TTL → no endpoint re-fetch
//   (4) usage unavailable → allow (fail-open) + stderr warn
// Plus: subagent agent_id is parsed for logging, and structural asserts that
// the hook extra file ships ONLY to the claude-code payload (adapter gating).

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile as realReadFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  decide,
  degradedSourceWarning,
  evaluateHookDecision,
  formatResetTime,
  parsePayload,
  resolveUsage,
  run,
} from "../.agents/skills/usage-guard/usage-guard-hook.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXED_NOW = Date.parse("2026-06-15T00:00:00.000Z");
const now = () => FIXED_NOW;

// Default hermetic deps for run(): kill-switch off, and debounce/spike state
// that does NOT short-circuit a deny (counter already at debounceCount-1 = 1, so
// a single over reading denies — preserving the legacy "over → deny" assertions
// while debounce is exercised separately below). State writes are swallowed.
const denyReadyState = async () => ({ consecutive_over: 1 });
const noState = async () => ({});
const swallowState = async () => {};
const killOff = () => false;

// A usage result with both windows comfortably under threshold.
const okUsage = {
  five_hour: { utilization: 40, resets_at: "2026-06-15T04:00:00.000Z" },
  seven_day: { utilization: 60, resets_at: "2026-06-20T00:00:00.000Z" },
  ok: true,
  wait_seconds: 0,
  resets_at: null,
  source: "endpoint",
};

// A usage result with the 5h window over threshold (reset at 03:30 local).
const overUsage = {
  five_hour: { utilization: 97, resets_at: "2026-06-15T03:30:00.000Z" },
  seven_day: { utilization: 60, resets_at: "2026-06-20T00:00:00.000Z" },
  ok: false,
  wait_seconds: 12_600,
  resets_at: "2026-06-15T03:30:00.000Z",
  source: "endpoint",
};

// --- (1) under threshold → allow ---------------------------------------------

test("(1) under threshold → allow (exit 0), no deny output", async () => {
  const warnings = [];
  const denies = [];
  const code = await run({
    readStdinImpl: async () => "",
    resolveUsageImpl: async () => okUsage,
    killSwitchImpl: killOff,
    readStateImpl: noState,
    writeStateImpl: swallowState,
    env: {},
    now,
    warn: (m) => warnings.push(m),
    deny: (m) => denies.push(m),
  });
  assert.equal(code, 0, "allow → exit 0");
  assert.equal(denies.length, 0, "no deny message when under threshold");
  assert.equal(warnings.length, 0, "no warning when signal is fine");
});

// --- (2) over threshold → deny + reset message -------------------------------

test("(2) over threshold → deny (exit 2) with reset time in the message", async () => {
  const denies = [];
  const code = await run({
    readStdinImpl: async () => "",
    resolveUsageImpl: async () => overUsage,
    killSwitchImpl: killOff,
    readStateImpl: denyReadyState,
    writeStateImpl: swallowState,
    env: {},
    now,
    deny: (m) => denies.push(m),
  });
  assert.equal(code, 2, "over threshold → exit 2 (deny)");
  assert.equal(denies.length, 1, "exactly one deny message");
  const expected = formatResetTime(overUsage.resets_at); // local HH:MM
  assert.match(denies[0], /Usage Limit reached/);
  assert.match(denies[0], new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(denies[0], /5h 97%/, "names the exceeded window");
});

test("(2b) decide() is pure: over → not allowed with reset HH:MM in reason", () => {
  const { allow, reason } = decide(overUsage, 95, now);
  assert.equal(allow, false);
  assert.match(reason, /resets at \d{2}:\d{2}/);
});

test("(2c) decide() allows fail-open usage (ok !== false)", () => {
  const failOpen = {
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 0, resets_at: null },
    ok: true,
    source: "fail-open",
  };
  assert.equal(decide(failOpen, 95, now).allow, true);
});

// --- (#139 (d)) decide() allows a suspected reflection lag --------------------

test("(2d) decide() allows a suspected reflection lag (over but just past reset)", () => {
  const lagged = {
    five_hour: { utilization: 100, resets_at: "2026-06-15T00:05:00.000Z" },
    seven_day: { utilization: 10, resets_at: null },
    ok: false,
    suspected_reflection_lag: true,
    resets_at: "2026-06-15T00:05:00.000Z",
    source: "endpoint",
  };
  assert.equal(
    decide(lagged, 95, now).allow,
    true,
    "lag → ALLOW (boundary checkpoint catches a real overage)",
  );
});

// --- (#139 (a)) file kill-switch → hook is an instant no-op ------------------

test("(#139 a) kill-switch present → ALLOW (exit 0) even when over threshold", async () => {
  const warnings = [];
  const denies = [];
  let stateRead = false;
  const code = await run({
    readStdinImpl: async () => "",
    resolveUsageImpl: async () => {
      throw new Error("kill-switch must short-circuit before usage is resolved");
    },
    killSwitchImpl: () => true, // DISABLE file present
    readStateImpl: async () => {
      stateRead = true;
      return {};
    },
    writeStateImpl: swallowState,
    env: {},
    now,
    warn: (m) => warnings.push(m),
    deny: (m) => denies.push(m),
  });
  assert.equal(code, 0, "kill-switch → no-op ALLOW");
  assert.equal(denies.length, 0, "never deny when disabled");
  assert.equal(stateRead, false, "kill-switch short-circuits before any I/O");
  assert.equal(warnings.length, 1, "one warning explaining the no-op");
  assert.match(warnings[0], /kill-switch/);
});

test("(#139 a) kill-switch check throwing → fail-open, hook continues normally", async () => {
  // A broken existsSync must not hard-stop; the hook proceeds as if not disabled.
  const code = await run({
    readStdinImpl: async () => "",
    resolveUsageImpl: async () => okUsage,
    killSwitchImpl: () => {
      throw new Error("fs error");
    },
    readStateImpl: noState,
    writeStateImpl: swallowState,
    env: {},
    now,
  });
  assert.equal(code, 0, "kill-switch check error → treated as not disabled → normal ALLOW");
});

// --- (#139 d) hook layer allows a lag and surfaces it ------------------------

test("(#139 d) over + suspected_reflection_lag → ALLOW + degraded lag warning", async () => {
  const warnings = [];
  const denies = [];
  const lagged = {
    five_hour: { utilization: 100, resets_at: "2026-06-15T00:05:00.000Z" },
    seven_day: { utilization: 10, resets_at: null },
    ok: false,
    suspected_reflection_lag: true,
    source: "endpoint",
  };
  const code = await run({
    readStdinImpl: async () => "",
    resolveUsageImpl: async () => lagged,
    killSwitchImpl: killOff,
    readStateImpl: denyReadyState, // even with a high counter, a lag must ALLOW
    writeStateImpl: swallowState,
    env: {},
    now,
    warn: (m) => warnings.push(m),
    deny: (m) => denies.push(m),
  });
  assert.equal(code, 0, "lag → ALLOW regardless of debounce counter");
  assert.equal(denies.length, 0);
  assert.ok(
    warnings.some((w) => /reflection lag/.test(w)),
    "the lag-allow is surfaced as a degradation warning",
  );
});

// --- (#139 b) debounce: lone over ALLOWs, consecutive over DENYs -------------

test("(#139 b) evaluateHookDecision: first over ALLOWs (debounce), reaching count DENYs", () => {
  const over = {
    five_hour: { utilization: 99, resets_at: "2026-06-15T04:00:00.000Z" },
    seven_day: { utilization: 10, resets_at: null },
    ok: false,
    suspected_reflection_lag: false,
    resets_at: "2026-06-15T04:00:00.000Z",
    source: "endpoint",
  };
  // First over reading: counter 0 → 1, below the default debounce count (2) → ALLOW.
  const first = evaluateHookDecision(over, {}, { now });
  assert.equal(first.allow, true, "lone over reading does not deny (debounce)");
  assert.equal(first.degraded, "debounce");
  assert.equal(first.nextState.consecutive_over, 1);
  // Second consecutive over reading: counter 1 → 2 = debounce count → DENY.
  const second = evaluateHookDecision(over, first.nextState, { now });
  assert.equal(second.allow, false, "second consecutive over reading denies");
  assert.equal(second.nextState.consecutive_over, 2);
  assert.match(second.reason, /Usage Limit reached/);
});

test("(#139 b) a sub-threshold reading between overs resets the debounce counter", () => {
  const over = {
    five_hour: { utilization: 99, resets_at: "2026-06-15T04:00:00.000Z" },
    seven_day: { utilization: 10, resets_at: null },
    ok: false,
    suspected_reflection_lag: false,
    source: "endpoint",
  };
  const first = evaluateHookDecision(over, {}, { now });
  assert.equal(first.nextState.consecutive_over, 1);
  // An ok reading clears the counter.
  const cleared = evaluateHookDecision({ ...okUsage }, first.nextState, { now });
  assert.equal(cleared.allow, true);
  assert.equal(cleared.nextState.consecutive_over, 0);
});

test("(#139 b) run(): lone over ALLOWs and writes consecutive_over=1", async () => {
  const denies = [];
  let written = null;
  const over = {
    five_hour: { utilization: 99, resets_at: "2026-06-15T04:00:00.000Z" },
    seven_day: { utilization: 10, resets_at: null },
    ok: false,
    suspected_reflection_lag: false,
    resets_at: "2026-06-15T04:00:00.000Z",
    source: "endpoint",
  };
  const code = await run({
    readStdinImpl: async () => "",
    resolveUsageImpl: async () => over,
    killSwitchImpl: killOff,
    readStateImpl: noState, // counter starts at 0
    writeStateImpl: async (s) => {
      written = s;
    },
    env: {},
    now,
    deny: (m) => denies.push(m),
  });
  assert.equal(code, 0, "first over reading ALLOWs (debounce)");
  assert.equal(denies.length, 0);
  assert.equal(written.consecutive_over, 1, "counter advanced for the next call");
});

// --- (#139 c) spike rejection ------------------------------------------------

test("(#139 c) implausible spike from a recent sub-threshold baseline → ALLOW", () => {
  const over = {
    five_hour: { utilization: 100, resets_at: "2026-06-15T04:00:00.000Z" },
    seven_day: { utilization: 10, resets_at: null },
    ok: false,
    suspected_reflection_lag: false,
    resets_at: "2026-06-15T04:00:00.000Z",
    source: "endpoint",
  };
  // Last good reading was 30% just 10s ago — a jump to 100% is impossible.
  const prev = {
    consecutive_over: 0,
    last_good: { five_hour: 30, seven_day: 10, at: FIXED_NOW - 10_000 },
  };
  const res = evaluateHookDecision(over, prev, { now });
  assert.equal(res.allow, true, "spike from a recent low baseline is suspect → ALLOW");
  assert.equal(res.degraded, "spike");
  assert.equal(res.nextState.consecutive_over, 0, "a spike does not advance the debounce counter");
});

test("(#139 c) a sustained climb (stale baseline) is NOT treated as a spike", () => {
  const over = {
    five_hour: { utilization: 99, resets_at: "2026-06-15T04:00:00.000Z" },
    seven_day: { utilization: 10, resets_at: null },
    ok: false,
    suspected_reflection_lag: false,
    resets_at: "2026-06-15T04:00:00.000Z",
    source: "endpoint",
  };
  // Baseline is old (10 min ago) → outside the spike window → debounce path.
  const prev = {
    consecutive_over: 1,
    last_good: { five_hour: 30, seven_day: 10, at: FIXED_NOW - 600_000 },
  };
  const res = evaluateHookDecision(over, prev, { now });
  assert.equal(res.allow, false, "stale baseline → not a spike → debounce count reached → DENY");
  assert.equal(res.degraded, null);
});

// --- (3) fresh cache within TTL → no endpoint re-fetch -----------------------

test("(3) fresh cache within TTL → served from cache, no getUsage fetch", async () => {
  let getUsageCalls = 0;
  const usage = await resolveUsage({
    readCacheImpl: async () => ({ ...okUsage }), // cache hit
    getUsageImpl: async () => {
      getUsageCalls += 1;
      return okUsage;
    },
  });
  assert.equal(getUsageCalls, 0, "endpoint path must NOT run on a cache hit");
  assert.equal(usage.source, "cache", "served from cache");
  assert.equal(usage.five_hour.utilization, 40);
});

test("(3b) cold cache → falls through to getUsage (still cache-first internally)", async () => {
  let getUsageCalls = 0;
  const usage = await resolveUsage({
    readCacheImpl: async () => null, // cold cache
    getUsageImpl: async () => {
      getUsageCalls += 1;
      return okUsage;
    },
  });
  assert.equal(getUsageCalls, 1, "cold cache → exactly one getUsage call");
  assert.equal(usage.source, "endpoint");
});

// --- (#135) hook path self-sustains the cache: cold → fetch once → hot --------
//
// Before #135, getUsage (invoked by resolveUsage on a cold cache) never wrote
// the cache because writeFileImpl defaulted to undefined, so every subsequent
// tool call re-fetched the endpoint. This drives the REAL getUsage (no fs
// injection beyond a tmp cachePath + a fetch spy) twice through resolveUsage and
// asserts the endpoint is fetched only ONCE — the second call is served from the
// cache the first call wrote.

test("(#135) hook: cold getUsage writes cache → second resolve hits cache (fetch once)", async () => {
  const { getUsage, readCache } = await import("../.agents/skills/usage-guard/usage-check.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const tmp = await mkdtemp(join(tmpdir(), "ug-hook-cache-"));
  const cachePath = join(tmp, "usage-guard", "cache.json");
  try {
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 40, resets_at: "2026-06-15T04:00:00.000Z" },
          seven_day: { utilization: 60, resets_at: "2026-06-20T00:00:00.000Z" },
        }),
      };
    };
    const credsReader = async (path) => {
      if (path.endsWith(".credentials.json")) {
        return JSON.stringify({
          claudeAiOauth: { accessToken: "tok", expiresAt: FIXED_NOW + 3_600_000 },
        });
      }
      throw new Error(`unexpected read ${path}`);
    };
    // getUsage with NO writeFileImpl/mkdirImpl injected — relies on the #135
    // real-fs defaults to write the cache it just fetched.
    const getUsageImpl = () =>
      getUsage({
        fetchImpl,
        readFileImpl: credsReader,
        now,
        cachePath,
        credentialsPath: "/fake/.credentials.json",
      });
    const readCacheImpl = () => readCache({ cachePath, now });

    // 1st resolve: cold cache → getUsage → endpoint fetch (#1) → cache written.
    const first = await resolveUsage({ readCacheImpl, getUsageImpl });
    assert.equal(first.source, "endpoint", "cold cache → endpoint on first call");
    assert.equal(fetchCalls, 1, "exactly one endpoint fetch so far");

    // 2nd resolve: cache is now warm → served from cache, NO new fetch.
    const second = await resolveUsage({ readCacheImpl, getUsageImpl });
    assert.equal(second.source, "cache", "second call served from the self-written cache");
    assert.equal(fetchCalls, 1, "no re-fetch within TTL — hook path is self-sustaining (#135)");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// --- (4) usage unavailable → allow (fail-open) + warn ------------------------

test("(4) usage unavailable (null) → allow (exit 0) + stderr warn", async () => {
  const warnings = [];
  const denies = [];
  const code = await run({
    readStdinImpl: async () => "",
    resolveUsageImpl: async () => null, // signal could not be read
    killSwitchImpl: killOff,
    readStateImpl: noState,
    writeStateImpl: swallowState,
    env: {},
    now,
    warn: (m) => warnings.push(m),
    deny: (m) => denies.push(m),
  });
  assert.equal(code, 0, "fail-open → allow");
  assert.equal(denies.length, 0, "must not deny when the signal is unavailable");
  assert.equal(warnings.length, 1, "exactly one fail-open warning");
  assert.match(warnings[0], /fail-open/);
});

test("(4b) resolveUsage returns null when both cache and getUsage throw", async () => {
  const usage = await resolveUsage({
    readCacheImpl: async () => {
      throw new Error("cache parse error");
    },
    getUsageImpl: async () => {
      throw new Error("no signal");
    },
  });
  assert.equal(usage, null, "both sources failing → null → caller fails open");
});

// --- fail-open degradation visibility (issue #129) ---------------------------

test("(5) fail-open source → allow but emit a DEGRADED warning", async () => {
  const warnings = [];
  const denies = [];
  const failOpen = {
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 0, resets_at: null },
    ok: true,
    wait_seconds: 0,
    resets_at: null,
    source: "fail-open",
  };
  const code = await run({
    readStdinImpl: async () => "",
    resolveUsageImpl: async () => failOpen,
    killSwitchImpl: killOff,
    readStateImpl: noState,
    writeStateImpl: swallowState,
    env: {},
    now,
    warn: (m) => warnings.push(m),
    deny: (m) => denies.push(m),
  });
  assert.equal(code, 0, "fail-open is ok → still ALLOW");
  assert.equal(denies.length, 0, "never deny on fail-open");
  assert.equal(warnings.length, 1, "exactly one degradation warning");
  assert.match(warnings[0], /DEGRADED/);
  assert.match(warnings[0], /source=fail-open/);
  assert.match(warnings[0], /NOT actually monitoring/);
});

test("(5b) jsonl fallback source → allow but warn it is degraded (coarse)", async () => {
  const warnings = [];
  const code = await run({
    readStdinImpl: async () => "",
    resolveUsageImpl: async () => ({ ...okUsage, source: "jsonl" }),
    killSwitchImpl: killOff,
    readStateImpl: noState,
    writeStateImpl: swallowState,
    env: {},
    now,
    warn: (m) => warnings.push(m),
  });
  assert.equal(code, 0);
  assert.equal(warnings.length, 1, "jsonl is a degraded source → warn");
  assert.match(warnings[0], /degraded/);
  assert.match(warnings[0], /source=jsonl/);
});

test("(5c) endpoint and cache sources do NOT trigger a degradation warning", async () => {
  for (const source of ["endpoint", "cache"]) {
    const warnings = [];
    await run({
      readStdinImpl: async () => "",
      resolveUsageImpl: async () => ({ ...okUsage, source }),
      killSwitchImpl: killOff,
      readStateImpl: noState,
      writeStateImpl: swallowState,
      env: {},
      now,
      warn: (m) => warnings.push(m),
    });
    assert.equal(warnings.length, 0, `${source} is a healthy source → no warning`);
  }
});

test("(5d) degradedSourceWarning: fail-open vs other, with origin", () => {
  const fo = degradedSourceWarning("fail-open", "subagent w-1");
  assert.match(fo, /source=fail-open/);
  assert.match(fo, /subagent w-1/);
  assert.match(fo, /NOT actually monitoring/);
  const jl = degradedSourceWarning("jsonl", "main session");
  assert.match(jl, /source=jsonl/);
  assert.match(jl, /main session/);
});

// --- deny hint reflects the buffered wait_seconds (issue #129) ----------------

test("(5e) deny hint computes minutes from the buffered wait_seconds (no resets_at)", () => {
  // No parseable resets_at → decide() falls back to the wait_seconds hint.
  // wait_seconds already includes the resume buffer, so the "~N min" hint does too.
  const usage = {
    five_hour: { utilization: 99, resets_at: null },
    seven_day: { utilization: 10, resets_at: null },
    ok: false,
    wait_seconds: 3600 + 300, // edge (1h) + 5min buffer
    resets_at: null,
    source: "endpoint",
  };
  const { allow, reason } = decide(usage, 95, now);
  assert.equal(allow, false);
  // ceil(3900 / 60) = 65 min — proves the buffer is reflected in the hint.
  assert.match(reason, /~65 min/);
});

// --- subagent agent_id parsing (logging) -------------------------------------

test("parsePayload extracts agent_id from a subagent hook payload", () => {
  assert.equal(parsePayload('{"agent_id":"worker-7","tool_name":"Bash"}').agentId, "worker-7");
  assert.equal(parsePayload('{"tool_name":"Bash"}').agentId, null, "no agent_id → null");
  assert.equal(parsePayload("").agentId, null, "empty stdin → null");
  assert.equal(parsePayload("not json").agentId, null, "malformed → null (tolerated)");
});

test("run() tags the deny message with the subagent origin", async () => {
  const denies = [];
  await run({
    readStdinImpl: async () => '{"agent_id":"worker-7"}',
    resolveUsageImpl: async () => overUsage,
    killSwitchImpl: killOff,
    readStateImpl: denyReadyState,
    writeStateImpl: swallowState,
    env: {},
    now,
    deny: (m) => denies.push(m),
  });
  assert.match(denies[0], /subagent worker-7/, "deny message records the subagent origin");
});

// --- formatResetTime ---------------------------------------------------------

test("formatResetTime: ISO → local HH:MM, junk → null", () => {
  assert.match(formatResetTime("2026-06-15T03:30:00.000Z"), /^\d{2}:\d{2}$/);
  assert.equal(formatResetTime(null), null);
  assert.equal(formatResetTime("not-a-date"), null);
  assert.equal(formatResetTime(undefined), null);
});

// --- threshold env override flows into the decision --------------------------

test("threshold env override (80) denies at 85% utilization", async () => {
  const denies = [];
  const at85 = {
    five_hour: { utilization: 85, resets_at: "2026-06-15T03:30:00.000Z" },
    seven_day: { utilization: 10, resets_at: null },
    ok: false, // usage-check.mjs already evaluated at threshold 80
    wait_seconds: 12_600,
    resets_at: "2026-06-15T03:30:00.000Z",
    source: "endpoint",
  };
  const code = await run({
    readStdinImpl: async () => "",
    resolveUsageImpl: async () => at85,
    killSwitchImpl: killOff,
    readStateImpl: denyReadyState,
    writeStateImpl: swallowState,
    env: { USAGE_GUARD_THRESHOLD: "80" },
    now,
    deny: (m) => denies.push(m),
  });
  assert.equal(code, 2, "85 ≥ 80 → deny");
  assert.match(denies[0], /≥ 80%/, "deny message reflects the overridden threshold");
});

// --- structural: hook extra file ships ONLY to claude-code (adapter gating) ---

test("usage-guard-hook.mjs ships in the claude-code payload", async () => {
  const script = await realReadFile(
    join(ROOT, "dist", "claude-code", ".claude", "skills", "usage-guard", "usage-guard-hook.mjs"),
    "utf8",
  );
  assert.match(script, /PreToolUse/, "hook extra file must ship verbatim");
  // M2: the dist rewrite must not have corrupted a HOME-anchored / self path.
  assert.doesNotMatch(
    script,
    /~\/\.claude\/skills\/usage-guard\/usage-guard-hook\.mjs/,
    "hook must not contain a rewritten .claude/skills/ self-path literal",
  );
});

test("usage-guard-hook.mjs is ABSENT from non-claude adapter payloads (gating)", () => {
  for (const adapterDir of ["codex-cli", "gemini-cli", "copilot"]) {
    const p = join(ROOT, "dist", adapterDir);
    if (!existsSync(p)) continue;
    // usage-guard is gated `adapters: claude-code` → no usage-guard dir at all.
    const hookPath = join(p, ".agents", "skills", "usage-guard", "usage-guard-hook.mjs");
    assert.equal(
      existsSync(hookPath),
      false,
      `hook must not ship to ${adapterDir} (usage-guard is claude-code-gated)`,
    );
  }
  // `.agents/skills/` is the SSOT (authored directly), so usage-guard — despite
  // being `adapters: claude-code` — DOES live there and is visible to Codex /
  // Gemini reading the repo directly (an accepted no-op leak; the engine needs
  // Claude's ScheduleWakeup/OAuth and is inert elsewhere). Gating is enforced
  // for the shipped dist/{adapter}/ payloads (asserted above) — that is what
  // actually reaches non-Claude consumers.
  assert.equal(
    existsSync(join(ROOT, ".agents", "skills", "usage-guard", "usage-guard-hook.mjs")),
    true,
    "usage-guard SSOT lives under .agents/skills/ (gating is enforced at dist, not the SSOT)",
  );
});
