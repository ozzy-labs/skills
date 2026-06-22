// Tests for the usage-guard usage-check signal (issue #121).
//
// Covers the 6 issue cases via dependency injection (endpoint / JSONL / creds /
// cache / clock are all stubbed — no network, no real ~/.claude reads):
//   (1) endpoint OK → ok decision
//   (2) endpoint fail → JSONL fallback
//   (3) both fail → fail-open + warn
//   (4) threshold boundary 94.9 (ok) / 95.1 (not ok)
//   (5) wait_seconds = latest resets_at among exceeded windows
//   (6) cache TTL within window → no endpoint re-fetch
// Plus a structural assert that the BUILT claude-code SKILL.md frontmatter has
// `user-invocable` and a standalone-form section.

import assert from "node:assert/strict";
import { readFile as realReadFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  aggregateJsonlUsage,
  evaluate,
  getUsage,
  normalizeWindows,
  parseHeadroomArg,
  readAccessToken,
  readCache,
  resolveDispatchHeadroom,
  resolveLagEpsilon,
  resolveLagRecheck,
  resolveResumeBuffer,
  resolveThreshold,
  writeCache,
} from "../src/skills/usage-guard/usage-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXED_NOW = Date.parse("2026-06-15T00:00:00.000Z");
const now = () => FIXED_NOW;

// Build a credentials reader that returns a live (non-expired) token.
function credsReader({ token = "tok-abc", expiresAt = FIXED_NOW + 3_600_000 } = {}) {
  return async (path) => {
    if (path.endsWith(".credentials.json")) {
      return JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } });
    }
    throw new Error(`unexpected read ${path}`);
  };
}

// A fetch stub returning the given window payload with HTTP 200.
function fetchOk(payload) {
  return async () => ({ ok: true, status: 200, json: async () => payload });
}

// --- (1) endpoint OK → ok ----------------------------------------------------

test("(1) endpoint OK below threshold → ok:true, source endpoint", async () => {
  const result = await getUsage({
    fetchImpl: fetchOk({
      five_hour: { utilization: 40, resets_at: "2026-06-15T04:00:00.000Z" },
      seven_day: { utilization: 60, resets_at: "2026-06-20T00:00:00.000Z" },
    }),
    readFileImpl: credsReader(),
    now,
    cachePath: "/nonexistent/cache.json",
    credentialsPath: "/fake/.credentials.json",
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, "endpoint");
  assert.equal(result.wait_seconds, 0);
  assert.equal(result.resets_at, null);
  assert.equal(result.five_hour.utilization, 40);
});

// --- (2) endpoint fail → JSONL fallback --------------------------------------

test("(2) endpoint fail → JSONL fallback (source jsonl)", async () => {
  const recentTs = new Date(FIXED_NOW - 60_000).toISOString(); // 1 min ago
  const jsonlContent = [
    JSON.stringify({
      timestamp: recentTs,
      message: { usage: { input_tokens: 100, output_tokens: 50 } },
    }),
    "not-json-line",
    "",
  ].join("\n");
  const readFileImpl = async (path) => {
    if (path.endsWith(".credentials.json")) {
      return JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: FIXED_NOW + 1000 } });
    }
    if (path.endsWith(".jsonl")) return jsonlContent;
    throw new Error(`unexpected ${path}`);
  };
  const readdirImpl = async (path, _opts) => {
    if (path.endsWith("/projects"))
      return [{ name: "proj-a", isDirectory: () => true, isFile: () => false }];
    return [{ name: "session.jsonl", isDirectory: () => false, isFile: () => true }];
  };
  const result = await getUsage({
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    readFileImpl,
    readdirImpl,
    now,
    cachePath: "/nonexistent/cache.json",
    projectsDir: "/fake/projects",
  });
  assert.equal(result.source, "jsonl");
  assert.equal(result.ok, true); // tiny token count → well under threshold
  assert.ok(result.five_hour.utilization >= 0);
});

// --- (3) both fail → fail-open + warn ----------------------------------------

test("(3) endpoint + JSONL both fail → fail-open + stderr warn", async () => {
  const warnings = [];
  const result = await getUsage({
    fetchImpl: async () => {
      throw new Error("network down");
    },
    readFileImpl: async (path) => {
      // creds present but endpoint throws; JSONL readdir throws below.
      if (path.endsWith(".credentials.json")) {
        return JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: FIXED_NOW + 1000 } });
      }
      throw new Error("ENOENT");
    },
    readdirImpl: async () => {
      throw new Error("no projects dir");
    },
    now,
    cachePath: "/nonexistent/cache.json",
    warn: (m) => warnings.push(m),
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, "fail-open");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failing open/);
});

// --- (4) threshold boundary --------------------------------------------------

test("(4) threshold boundary: 94.9 ok, 95.1 not ok (default 95)", () => {
  const below = evaluate(
    normalizeWindows({
      five_hour: { utilization: 94.9, resets_at: "2026-06-15T04:00:00.000Z" },
      seven_day: { utilization: 10, resets_at: "2026-06-20T00:00:00.000Z" },
    }),
    { now },
  );
  assert.equal(below.ok, true, "94.9 < 95 → ok");

  const above = evaluate(
    normalizeWindows({
      five_hour: { utilization: 95.1, resets_at: "2026-06-15T04:00:00.000Z" },
      seven_day: { utilization: 10, resets_at: "2026-06-20T00:00:00.000Z" },
    }),
    { now },
  );
  assert.equal(above.ok, false, "95.1 >= 95 → not ok");
  assert.ok(above.wait_seconds > 0);
});

test("(4b) threshold env override changes the boundary", () => {
  assert.equal(resolveThreshold({ USAGE_GUARD_THRESHOLD: "80" }), 80);
  assert.equal(resolveThreshold({}), 95);
  const at85 = evaluate(
    normalizeWindows({
      five_hour: { utilization: 85, resets_at: "2026-06-15T04:00:00.000Z" },
      seven_day: { utilization: 10, resets_at: null },
    }),
    { threshold: 80, now },
  );
  assert.equal(at85.ok, false, "85 >= 80 → not ok at threshold 80");
});

// --- (5) wait_seconds = latest exceeded resets_at ----------------------------

test("(5) wait_seconds derives from the LATEST resets_at among exceeded windows", () => {
  const fiveHourReset = "2026-06-15T02:00:00.000Z"; // +2h
  const sevenDayReset = "2026-06-18T00:00:00.000Z"; // +3d (latest)
  const res = evaluate(
    normalizeWindows({
      five_hour: { utilization: 99, resets_at: fiveHourReset },
      seven_day: { utilization: 96, resets_at: sevenDayReset },
    }),
    { now },
  );
  assert.equal(res.ok, false);
  assert.equal(res.resets_at, sevenDayReset, "picks the later (7d) reset");
  // wait_seconds = time-to-edge + default resume buffer (300).
  const expected = Math.ceil((Date.parse(sevenDayReset) - FIXED_NOW) / 1000) + 300;
  assert.equal(res.wait_seconds, expected);
});

test("(5b) only the exceeded window counts toward the wait", () => {
  // 5h exceeded with a LATER reset than 7d, but 7d is NOT exceeded → use 5h.
  const res = evaluate(
    normalizeWindows({
      five_hour: { utilization: 99, resets_at: "2026-06-15T05:00:00.000Z" },
      seven_day: { utilization: 10, resets_at: "2026-06-15T01:00:00.000Z" },
    }),
    { now },
  );
  assert.equal(res.resets_at, "2026-06-15T05:00:00.000Z");
});

// --- post-reset resume buffer (issue #129) -----------------------------------

const exceededWindows = () =>
  normalizeWindows({
    five_hour: { utilization: 99, resets_at: "2026-06-15T02:00:00.000Z" }, // +2h
    seven_day: { utilization: 10, resets_at: null },
  });
const TWO_HOURS_S = Math.ceil((Date.parse("2026-06-15T02:00:00.000Z") - FIXED_NOW) / 1000);

test("buffer: default 300 is folded into wait_seconds; resets_at unchanged", () => {
  const res = evaluate(exceededWindows(), { now });
  assert.equal(res.ok, false);
  assert.equal(res.resume_buffer_seconds, 300, "default buffer = 300");
  assert.equal(res.wait_seconds, TWO_HOURS_S + 300, "wait = edge + buffer");
  assert.equal(res.resets_at, "2026-06-15T02:00:00.000Z", "resets_at stays the raw window edge");
});

test("buffer: explicit resumeBuffer overrides the default", () => {
  const res = evaluate(exceededWindows(), { now, resumeBuffer: 600 });
  assert.equal(res.resume_buffer_seconds, 600);
  assert.equal(res.wait_seconds, TWO_HOURS_S + 600);
  assert.equal(res.resets_at, "2026-06-15T02:00:00.000Z", "resets_at still the window edge");
});

test("buffer: resumeBuffer=0 restores legacy resume-at-edge behaviour", () => {
  const res = evaluate(exceededWindows(), { now, resumeBuffer: 0 });
  assert.equal(res.resume_buffer_seconds, 0);
  assert.equal(res.wait_seconds, TWO_HOURS_S, "no buffer added");
});

test("buffer: NOT applied when ok (wait_seconds stays 0)", () => {
  const res = evaluate(
    normalizeWindows({
      five_hour: { utilization: 10, resets_at: "2026-06-15T02:00:00.000Z" },
      seven_day: { utilization: 10, resets_at: null },
    }),
    { now, resumeBuffer: 300 },
  );
  assert.equal(res.ok, true);
  assert.equal(res.wait_seconds, 0, "ok → no wait, no buffer");
  assert.equal(res.resume_buffer_seconds, 300, "field still reported");
});

test("resolveResumeBuffer: env override / 0 / invalid → default", () => {
  assert.equal(resolveResumeBuffer({ USAGE_GUARD_RESUME_BUFFER_SECONDS: "600" }), 600);
  assert.equal(resolveResumeBuffer({ USAGE_GUARD_RESUME_BUFFER_SECONDS: "0" }), 0);
  assert.equal(resolveResumeBuffer({}), 300, "unset → default 300");
  assert.equal(
    resolveResumeBuffer({ USAGE_GUARD_RESUME_BUFFER_SECONDS: "" }),
    300,
    "blank → default",
  );
  assert.equal(
    resolveResumeBuffer({ USAGE_GUARD_RESUME_BUFFER_SECONDS: "-5" }),
    300,
    "negative → default",
  );
  assert.equal(
    resolveResumeBuffer({ USAGE_GUARD_RESUME_BUFFER_SECONDS: "abc" }),
    300,
    "non-numeric → default",
  );
});

test("getUsage threads USAGE_GUARD_RESUME_BUFFER_SECONDS into the endpoint result", async () => {
  const result = await getUsage({
    fetchImpl: fetchOk({
      five_hour: { utilization: 99, resets_at: "2026-06-15T02:00:00.000Z" },
      seven_day: { utilization: 10, resets_at: null },
    }),
    readFileImpl: credsReader(),
    env: { USAGE_GUARD_RESUME_BUFFER_SECONDS: "600" },
    now,
    cachePath: "/nonexistent/cache.json",
    credentialsPath: "/fake/.credentials.json",
  });
  assert.equal(result.source, "endpoint");
  assert.equal(result.ok, false);
  assert.equal(result.resume_buffer_seconds, 600);
  assert.equal(result.wait_seconds, TWO_HOURS_S + 600, "endpoint path applies the env buffer");
});

// --- dispatch headroom (#141) ------------------------------------------------

// The real road observation: a wave starts at five_hour=86% with threshold 95.
// A 3-worker heavy wave burns ~+12% mid-flight (86 → 98). The boundary
// checkpoint must gate on the PROJECTED value, not the current 86%.
const headroomWindows = (fiveHour = 86) =>
  normalizeWindows({
    five_hour: { utilization: fiveHour, resets_at: "2026-06-15T02:00:00.000Z" }, // +2h
    seven_day: { utilization: 10, resets_at: null },
  });

test("(#141) headroom default 0 is backward compatible (legacy gate on current util)", () => {
  // headroom unset → identical to before: 86 < 95 → ok.
  const ok = evaluate(headroomWindows(86), { now });
  assert.equal(ok.ok, true, "86 < 95 with no headroom → ok (legacy)");
  // 95.1 still trips with default headroom 0.
  const trip = evaluate(headroomWindows(95.1), { now });
  assert.equal(trip.ok, false, "95.1 >= 95 with no headroom → not ok (legacy)");
});

test("(#141) headroom gates dispatch on the PROJECTED post-wave value", () => {
  // 86 + 12 = 98 >= 95 → hold the dispatch.
  const tripped = evaluate(headroomWindows(86), { now, headroom: 12 });
  assert.equal(tripped.ok, false, "projected 98 >= 95 → not ok");
  // 86 + 5 = 91 < 95 → safe to dispatch.
  const safe = evaluate(headroomWindows(86), { now, headroom: 5 });
  assert.equal(safe.ok, true, "projected 91 < 95 → ok");
  // Boundary: 86 + 9 = 95 >= 95 → trips (>= is inclusive).
  const boundary = evaluate(headroomWindows(86), { now, headroom: 9 });
  assert.equal(boundary.ok, false, "projected 95 >= 95 → not ok (boundary)");
});

test("(#141) wait_seconds / resets_at are independent of the headroom magnitude", () => {
  // Both headroom values trip the SAME (5h) window; the wait is time-to-edge +
  // buffer regardless of how large the headroom is.
  const small = evaluate(headroomWindows(90), { now, headroom: 5 }); // 95 >= 95
  const large = evaluate(headroomWindows(86), { now, headroom: 12 }); // 98 >= 95
  assert.equal(small.ok, false);
  assert.equal(large.ok, false);
  assert.equal(small.resets_at, "2026-06-15T02:00:00.000Z");
  assert.equal(large.resets_at, "2026-06-15T02:00:00.000Z");
  assert.equal(
    small.wait_seconds,
    TWO_HOURS_S + 300,
    "wait = edge + buffer, not scaled by headroom",
  );
  assert.equal(large.wait_seconds, TWO_HOURS_S + 300, "same wait despite larger headroom");
});

test("(#141) headroom trips per-window (the window with the higher projected value)", () => {
  const res = evaluate(
    normalizeWindows({
      five_hour: { utilization: 50, resets_at: "2026-06-15T05:00:00.000Z" }, // 50+12=62 < 95
      seven_day: { utilization: 88, resets_at: "2026-06-18T00:00:00.000Z" }, // 88+12=100 >= 95
    }),
    { now, headroom: 12 },
  );
  assert.equal(res.ok, false, "7d projected 100 >= 95 → not ok");
  assert.equal(
    res.resets_at,
    "2026-06-18T00:00:00.000Z",
    "wait derives from the tripped (7d) window",
  );
});

test("(#141) negative headroom clamps to 0 (never relaxes the gate)", () => {
  const res = evaluate(headroomWindows(94.9), { now, headroom: -50 });
  assert.equal(res.ok, true, "94.9 < 95 — negative headroom must not flip to ok:false nor weaken");
  const trip = evaluate(headroomWindows(96), { now, headroom: -50 });
  assert.equal(trip.ok, false, "96 >= 95 still trips; negative headroom clamped to 0");
});

test("(#141) resolveDispatchHeadroom: env override / blank / negative / invalid → default 0", () => {
  assert.equal(resolveDispatchHeadroom({ USAGE_GUARD_DISPATCH_HEADROOM: "12" }), 12);
  assert.equal(resolveDispatchHeadroom({}), 0, "unset → default 0");
  assert.equal(resolveDispatchHeadroom({ USAGE_GUARD_DISPATCH_HEADROOM: "" }), 0, "blank → 0");
  assert.equal(resolveDispatchHeadroom({ USAGE_GUARD_DISPATCH_HEADROOM: "-5" }), 0, "negative → 0");
  assert.equal(
    resolveDispatchHeadroom({ USAGE_GUARD_DISPATCH_HEADROOM: "abc" }),
    0,
    "non-numeric → 0",
  );
});

test("(#141) parseHeadroomArg: CLI flag forms, absence, and clamping", () => {
  assert.equal(parseHeadroomArg(["--headroom", "12"]), 12, "--headroom <v>");
  assert.equal(parseHeadroomArg(["--headroom=8"]), 8, "--headroom=<v>");
  assert.equal(parseHeadroomArg([]), undefined, "absent → undefined (env fallback)");
  assert.equal(parseHeadroomArg(["--other", "x"]), undefined, "unrelated flags → undefined");
  assert.equal(parseHeadroomArg(["--headroom", "abc"]), undefined, "non-numeric → undefined");
  assert.equal(parseHeadroomArg(["--headroom", "-3"]), 0, "negative → clamp 0");
});

test("(#141) getUsage: CLI headroom param wins over env; undefined falls back to env", async () => {
  const windows = {
    five_hour: { utilization: 86, resets_at: "2026-06-15T02:00:00.000Z" },
    seven_day: { utilization: 10, resets_at: null },
  };
  // Explicit param (CLI) = 12 → projected 98 trips, overriding env's 0.
  const viaParam = await getUsage({
    fetchImpl: fetchOk(windows),
    readFileImpl: credsReader(),
    env: { USAGE_GUARD_DISPATCH_HEADROOM: "0" },
    headroom: 12,
    now,
    cachePath: "/nonexistent/cache.json",
    credentialsPath: "/fake/.credentials.json",
  });
  assert.equal(viaParam.ok, false, "param headroom 12 overrides env 0 → projected 98 trips");

  // No param → env default applies (12 → trips).
  const viaEnv = await getUsage({
    fetchImpl: fetchOk(windows),
    readFileImpl: credsReader(),
    env: { USAGE_GUARD_DISPATCH_HEADROOM: "12" },
    now,
    cachePath: "/nonexistent/cache.json",
    credentialsPath: "/fake/.credentials.json",
  });
  assert.equal(viaEnv.ok, false, "env headroom 12 applies when no param → projected 98 trips");

  // No param, no env → legacy (86 < 95 → ok).
  const legacy = await getUsage({
    fetchImpl: fetchOk(windows),
    readFileImpl: credsReader(),
    env: {},
    now,
    cachePath: "/nonexistent/cache.json",
    credentialsPath: "/fake/.credentials.json",
  });
  assert.equal(legacy.ok, true, "no headroom → 86 < 95 → ok (backward compatible)");
});

test("getUsage reports resume_buffer_seconds on the fail-open result", async () => {
  const result = await getUsage({
    fetchImpl: async () => {
      throw new Error("network down");
    },
    readFileImpl: async (path) => {
      if (path.endsWith(".credentials.json")) {
        return JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: FIXED_NOW + 1000 } });
      }
      throw new Error("ENOENT");
    },
    readdirImpl: async () => {
      throw new Error("no projects dir");
    },
    env: { USAGE_GUARD_RESUME_BUFFER_SECONDS: "120" },
    now,
    cachePath: "/nonexistent/cache.json",
    warn: () => {},
  });
  assert.equal(result.source, "fail-open");
  assert.equal(result.resume_buffer_seconds, 120, "fail-open carries the resolved buffer");
});

// --- (6) cache TTL within window → no re-fetch -------------------------------

test("(6) fresh cache within TTL → no endpoint re-fetch", async () => {
  let fetchCalls = 0;
  const cached = {
    five_hour: { utilization: 12, resets_at: null },
    seven_day: { utilization: 34, resets_at: null },
    ok: true,
    wait_seconds: 0,
    resets_at: null,
  };
  const readFileImpl = async (path) => {
    if (path.endsWith("cache.json")) {
      return JSON.stringify({ cached_at: FIXED_NOW - 10_000, result: cached }); // 10s old, TTL 45s
    }
    throw new Error(`unexpected ${path}`);
  };
  const result = await getUsage({
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, json: async () => ({}) };
    },
    readFileImpl,
    now,
    cachePath: "/fake/cache.json",
  });
  assert.equal(fetchCalls, 0, "endpoint must NOT be re-fetched within cache TTL");
  assert.equal(result.source, "cache");
  assert.equal(result.five_hour.utilization, 12);
});

test("(6b) stale cache beyond TTL → endpoint re-fetched", async () => {
  let fetchCalls = 0;
  const readFileImpl = async (path) => {
    if (path.endsWith("cache.json")) {
      return JSON.stringify({ cached_at: FIXED_NOW - 120_000, result: { ok: true } }); // 2 min old > 45s TTL
    }
    if (path.endsWith(".credentials.json")) {
      return JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: FIXED_NOW + 1000 } });
    }
    throw new Error(`unexpected ${path}`);
  };
  const result = await getUsage({
    fetchImpl: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 5, resets_at: null },
          seven_day: { utilization: 5, resets_at: null },
        }),
      };
    },
    readFileImpl,
    now,
    cachePath: "/fake/cache.json",
  });
  assert.equal(fetchCalls, 1, "stale cache must trigger a re-fetch");
  assert.equal(result.source, "endpoint");
});

// --- token expiry ------------------------------------------------------------

test("readAccessToken returns null for an expired token", async () => {
  const expired = await readAccessToken({
    readFileImpl: credsReader({ expiresAt: FIXED_NOW - 1000 }),
    credentialsPath: "/fake/.credentials.json",
    now,
  });
  assert.equal(expired, null);
  const live = await readAccessToken({
    readFileImpl: credsReader({ expiresAt: FIXED_NOW + 1000 }),
    credentialsPath: "/fake/.credentials.json",
    now,
  });
  assert.equal(live, "tok-abc");
});

// --- JSONL aggregation directly ----------------------------------------------

test("aggregateJsonlUsage windows tokens by 5h / 7d age", async () => {
  const within5h = new Date(FIXED_NOW - 60 * 60 * 1000).toISOString(); // 1h ago
  const within7d = new Date(FIXED_NOW - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3d ago
  const tooOld = new Date(FIXED_NOW - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10d ago (ignored)
  const content = [
    JSON.stringify({
      timestamp: within5h,
      message: { usage: { input_tokens: 1000, output_tokens: 1000 } },
    }),
    JSON.stringify({
      timestamp: within7d,
      message: { usage: { input_tokens: 2000, output_tokens: 0 } },
    }),
    JSON.stringify({ timestamp: tooOld, message: { usage: { input_tokens: 9_999_999 } } }),
  ].join("\n");
  const windows = await aggregateJsonlUsage({
    readdirImpl: async (path) => {
      if (path.endsWith("/projects"))
        return [{ name: "p", isDirectory: () => true, isFile: () => false }];
      return [{ name: "s.jsonl", isDirectory: () => false, isFile: () => true }];
    },
    readFileImpl: async () => content,
    projectsDir: "/fake/projects",
    now,
    fiveHourBudget: 10_000,
    sevenDayBudget: 10_000,
  });
  // 5h window: 2000 tokens / 10000 budget = 20%
  assert.equal(Math.round(windows.five_hour.utilization), 20);
  // 7d window: (2000 + 2000) = 4000 / 10000 = 40% (10d-old row excluded)
  assert.equal(Math.round(windows.seven_day.utilization), 40);
  assert.ok(windows.five_hour.resets_at, "5h resets_at derived from oldest counted message");
});

// --- reflection-lag detection (issue #133) -----------------------------------
//
// After a window resets, the endpoint can briefly echo the PREVIOUS window's
// residue (e.g. 5h utilization 100% only ~5 min into a fresh window). That
// "reset happened but util still 100%" contradiction is a suspected reflection
// lag → short recheck instead of a ~full-window wait.

const FIVE_HOUR_S = 18000;

// resets_at JUST past the boundary: elapsed = 18000 - (resets_at - now) small.
// elapsed ≈ 326s (5.4 min) like the issue example → resets_at ≈ now + 17674s.
const lagWindows = (util = 100) =>
  normalizeWindows({
    five_hour: {
      utilization: util,
      resets_at: new Date(FIXED_NOW + (FIVE_HOUR_S - 326) * 1000).toISOString(),
    },
    seven_day: { utilization: 10, resets_at: null },
  });

test("(#133) boundary-just-passed + util 100 → suspected lag, wait==recheck, resets_at unchanged", () => {
  const edge = new Date(FIXED_NOW + (FIVE_HOUR_S - 326) * 1000).toISOString();
  const res = evaluate(lagWindows(100), { now });
  assert.equal(res.ok, false, "100% ≥ 95 → not ok");
  assert.equal(res.suspected_reflection_lag, true, "barely past boundary + over → lag suspected");
  assert.equal(
    res.wait_seconds,
    180,
    "lag → short recheck interval (default 180s), not full window",
  );
  assert.equal(res.resets_at, edge, "resets_at stays the raw window edge (info preserved)");
});

test("(#133) well past boundary + util 100 → NO lag, legacy full-window + buffer", () => {
  // resets_at far in the future → elapsed since boundary is large (not near 0).
  const farEdge = new Date(FIXED_NOW + 4 * 60 * 60 * 1000).toISOString(); // +4h
  const res = evaluate(
    normalizeWindows({
      five_hour: { utilization: 100, resets_at: farEdge },
      seven_day: { utilization: 10, resets_at: null },
    }),
    { now },
  );
  assert.equal(res.suspected_reflection_lag, false, "elapsed >> epsilon → no lag");
  const expected = Math.ceil((Date.parse(farEdge) - FIXED_NOW) / 1000) + 300;
  assert.equal(res.wait_seconds, expected, "legacy full window + 300s buffer");
  assert.equal(res.resets_at, farEdge);
});

test("(#133) ok:true (under threshold) → never flags lag even just past boundary", () => {
  const res = evaluate(lagWindows(40), { now });
  assert.equal(res.ok, true, "40% < 95 → ok");
  assert.equal(res.suspected_reflection_lag, false, "ok → no lag judgement");
  assert.equal(res.wait_seconds, 0);
});

test("(#133) env overrides for epsilon and recheck take effect", () => {
  assert.equal(resolveLagEpsilon({ USAGE_GUARD_LAG_EPSILON_SECONDS: "60" }), 60);
  assert.equal(resolveLagEpsilon({}), 900, "unset → default 900");
  assert.equal(
    resolveLagEpsilon({ USAGE_GUARD_LAG_EPSILON_SECONDS: "-5" }),
    900,
    "negative → default",
  );
  assert.equal(resolveLagRecheck({ USAGE_GUARD_LAG_RECHECK_SECONDS: "30" }), 30);
  assert.equal(resolveLagRecheck({}), 180, "unset → default 180");
  assert.equal(
    resolveLagRecheck({ USAGE_GUARD_LAG_RECHECK_SECONDS: "0" }),
    180,
    "0 → default (no busy loop)",
  );

  // elapsed ≈ 326s. With epsilon=60 (< 326) it should NOT flag a lag.
  const tightEpsilon = evaluate(lagWindows(100), { now, lagEpsilon: 60 });
  assert.equal(tightEpsilon.suspected_reflection_lag, false, "epsilon 60 < elapsed 326 → no lag");
  assert.ok(tightEpsilon.wait_seconds > 180, "falls back to full-window wait");

  // With a larger epsilon and a custom recheck the wait equals that recheck.
  const customRecheck = evaluate(lagWindows(100), { now, lagEpsilon: 900, lagRecheck: 45 });
  assert.equal(customRecheck.suspected_reflection_lag, true);
  assert.equal(customRecheck.wait_seconds, 45, "custom recheck interval used");
});

test("(#133) getUsage threads lag env into the endpoint result + does NOT cache a lagged read", async () => {
  let wrote = false;
  const result = await getUsage({
    fetchImpl: fetchOk({
      five_hour: {
        utilization: 100,
        resets_at: new Date(FIXED_NOW + (FIVE_HOUR_S - 326) * 1000).toISOString(),
      },
      seven_day: { utilization: 10, resets_at: null },
    }),
    readFileImpl: credsReader(),
    writeFileImpl: async () => {
      wrote = true;
    },
    mkdirImpl: async () => {},
    now,
    cachePath: "/nonexistent/cache.json",
    credentialsPath: "/fake/.credentials.json",
  });
  assert.equal(result.source, "endpoint");
  assert.equal(result.suspected_reflection_lag, true);
  assert.equal(result.ok, false);
  assert.equal(result.wait_seconds, 180, "lag → short recheck");
  assert.equal(wrote, false, "a suspected-lag result must NOT be written to cache (#133)");
});

test("(#133) getUsage DOES cache a normal (non-lag) over-threshold result", async () => {
  let wrote = false;
  const result = await getUsage({
    fetchImpl: fetchOk({
      five_hour: {
        utilization: 99,
        resets_at: new Date(FIXED_NOW + 4 * 60 * 60 * 1000).toISOString(),
      },
      seven_day: { utilization: 10, resets_at: null },
    }),
    readFileImpl: credsReader(),
    writeFileImpl: async () => {
      wrote = true;
    },
    mkdirImpl: async () => {},
    now,
    cachePath: "/nonexistent/cache.json",
    credentialsPath: "/fake/.credentials.json",
  });
  assert.equal(result.suspected_reflection_lag, false);
  assert.equal(wrote, true, "non-lag results still cache normally");
});

// --- (#139 (e)) cache hygiene: over-threshold reads get a shortened TTL -------

test("(#139 e) getUsage caches an over-threshold read with a SHORT embedded ttl_ms", async () => {
  let record = null;
  await getUsage({
    fetchImpl: fetchOk({
      five_hour: {
        utilization: 99,
        resets_at: new Date(FIXED_NOW + 4 * 60 * 60 * 1000).toISOString(),
      },
      seven_day: { utilization: 10, resets_at: null },
    }),
    readFileImpl: credsReader(),
    writeFileImpl: async (_p, data) => {
      record = JSON.parse(data);
    },
    mkdirImpl: async () => {},
    now,
    cachePath: "/nonexistent/cache.json",
    credentialsPath: "/fake/.credentials.json",
  });
  assert.equal(record.result.ok, false, "over-threshold result is cached");
  assert.equal(typeof record.ttl_ms, "number", "over read embeds a per-record TTL");
  assert.ok(record.ttl_ms <= 10_000, "over read TTL is shortened (≤10s) vs the 45s default");
});

test("(#139 e) getUsage caches a sub-threshold read with NO embedded ttl_ms (default TTL)", async () => {
  let record = null;
  await getUsage({
    fetchImpl: fetchOk({
      five_hour: { utilization: 40, resets_at: "2026-06-15T04:00:00.000Z" },
      seven_day: { utilization: 60, resets_at: "2026-06-20T00:00:00.000Z" },
    }),
    readFileImpl: credsReader(),
    writeFileImpl: async (_p, data) => {
      record = JSON.parse(data);
    },
    mkdirImpl: async () => {},
    now,
    cachePath: "/nonexistent/cache.json",
    credentialsPath: "/fake/.credentials.json",
  });
  assert.equal(record.result.ok, true, "sub-threshold result is cached");
  assert.equal(
    record.ttl_ms,
    undefined,
    "sub read uses the caller's default TTL (no embedded ttl_ms)",
  );
});

test("(#139 e) readCache honors a per-record ttl_ms over the caller's ttlMs", async () => {
  // Record is 12s old with an embedded 10s TTL → expired even though the
  // caller's default (45s) would still consider it fresh.
  const readFileImpl = async () =>
    JSON.stringify({ cached_at: FIXED_NOW - 12_000, ttl_ms: 10_000, result: { ok: false } });
  const expired = await readCache({ readFileImpl, cachePath: "/fake/cache.json", now });
  assert.equal(expired, null, "embedded short TTL expires the record before the default would");

  // Same record but only 5s old → still fresh under its 10s TTL.
  const fresh = await readCache({
    readFileImpl: async () =>
      JSON.stringify({ cached_at: FIXED_NOW - 5_000, ttl_ms: 10_000, result: { ok: false } }),
    cachePath: "/fake/cache.json",
    now,
  });
  assert.deepEqual(fresh, { ok: false }, "within the embedded TTL → served");
});

test("(#139 e) writeCache embeds ttl_ms only when provided", async () => {
  let withTtl = null;
  let withoutTtl = null;
  await writeCache(
    { ok: false },
    {
      writeFileImpl: async (_p, d) => (withTtl = JSON.parse(d)),
      mkdirImpl: async () => {},
      now,
      ttlMs: 10_000,
    },
  );
  await writeCache(
    { ok: true },
    {
      writeFileImpl: async (_p, d) => (withoutTtl = JSON.parse(d)),
      mkdirImpl: async () => {},
      now,
    },
  );
  assert.equal(withTtl.ttl_ms, 10_000, "ttlMs option is embedded");
  assert.equal(withoutTtl.ttl_ms, undefined, "no ttlMs option → no embedded ttl_ms");
});

test("(#133) endpoint OK (ok:true) result carries suspected_reflection_lag:false", async () => {
  const result = await getUsage({
    fetchImpl: fetchOk({
      five_hour: { utilization: 40, resets_at: "2026-06-15T04:00:00.000Z" },
      seven_day: { utilization: 60, resets_at: "2026-06-20T00:00:00.000Z" },
    }),
    readFileImpl: credsReader(),
    now,
    cachePath: "/nonexistent/cache.json",
    credentialsPath: "/fake/.credentials.json",
  });
  assert.equal(result.suspected_reflection_lag, false);
});

// --- self-sustaining cache: writeFileImpl/mkdirImpl default to real fs (#135) -
//
// Root cause of #135: getUsage defaulted writeFileImpl/mkdirImpl to `undefined`,
// so writeCache early-returned (no-op) for any caller that did not inject fs
// (the PreToolUse hook calls getUsage with no deps). The endpoint was then
// re-fetched on EVERY tool call because the cache was never written. The fix
// defaults writeFileImpl=writeFile / mkdirImpl=mkdir so every caller self-
// sustains the cache. These tests pin that down.

test("(#135) getUsage with NO fs injection still ATTEMPTS the cache write on endpoint success", async () => {
  // No writeFileImpl/mkdirImpl injected → must fall back to the real-fs defaults
  // and actually call writeCache. To prove the DEFAULT we point the cache at a
  // tmp file and assert the file (and its nested dir) is created.
  const { mkdtemp, readFile: rf, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const tmp = await mkdtemp(join(tmpdir(), "ug-cache-"));
  const cachePath = join(tmp, "nested", "cache.json");
  try {
    const result = await getUsage({
      fetchImpl: fetchOk({
        five_hour: { utilization: 40, resets_at: "2026-06-15T04:00:00.000Z" },
        seven_day: { utilization: 60, resets_at: "2026-06-20T00:00:00.000Z" },
      }),
      readFileImpl: credsReader(),
      now,
      cachePath, // real default writeFile/mkdir must create this
      credentialsPath: "/fake/.credentials.json",
      // writeFileImpl / mkdirImpl intentionally OMITTED → exercise defaults.
    });
    assert.equal(result.source, "endpoint");
    const onDisk = JSON.parse(await rf(cachePath, "utf8"));
    assert.equal(onDisk.result.five_hour.utilization, 40, "cache written by default fs");
    assert.equal(typeof onDisk.cached_at, "number", "cache wraps result with cached_at");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("(#135) default writeFileImpl/mkdirImpl are wired (regression: not undefined)", async () => {
  // Omit fs deps entirely and assert writeCache is reached by observing the
  // mkdir + write through the real fs against a tmp dir (omitting deps must NOT
  // throw and must auto-create the nested cache dir).
  const { mkdtemp, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const tmp = await mkdtemp(join(tmpdir(), "ug-cache2-"));
  const cachePath = join(tmp, "a", "b", "cache.json");
  try {
    await getUsage({
      fetchImpl: fetchOk({
        five_hour: { utilization: 12, resets_at: null },
        seven_day: { utilization: 34, resets_at: null },
      }),
      readFileImpl: credsReader(),
      now,
      cachePath,
      credentialsPath: "/fake/.credentials.json",
    });
    const s = await stat(cachePath);
    assert.ok(s.isFile(), "nested cache dir auto-created by default mkdir");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("(#135) suspected-lag result is NOT cached even with default fs (cache bypass kept)", async () => {
  // Reuses the #133 invariant but through the DEFAULT fs path (no writeFileImpl
  // injected) to prove the self-sustaining default does not break the bypass.
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const tmp = await mkdtemp(join(tmpdir(), "ug-cache-lag-"));
  const cachePath = join(tmp, "cache.json");
  try {
    const result = await getUsage({
      fetchImpl: fetchOk({
        five_hour: {
          utilization: 100,
          resets_at: new Date(FIXED_NOW + (FIVE_HOUR_S - 326) * 1000).toISOString(),
        },
        seven_day: { utilization: 10, resets_at: null },
      }),
      readFileImpl: credsReader(),
      now,
      cachePath,
      credentialsPath: "/fake/.credentials.json",
      // defaults for writeFileImpl/mkdirImpl
    });
    assert.equal(result.suspected_reflection_lag, true);
    assert.equal(existsSync(cachePath), false, "a suspected-lag read must NOT touch the cache");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("(#135) fail-open result is NOT cached even with default fs", async () => {
  // fail-open never goes through maybeCache/writeCache; confirm no cache file is
  // produced via the default fs path either.
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const tmp = await mkdtemp(join(tmpdir(), "ug-cache-fo-"));
  const cachePath = join(tmp, "cache.json");
  try {
    const result = await getUsage({
      fetchImpl: async () => {
        throw new Error("network down");
      },
      readFileImpl: async (path) => {
        if (path.endsWith(".credentials.json")) {
          return JSON.stringify({
            claudeAiOauth: { accessToken: "t", expiresAt: FIXED_NOW + 1000 },
          });
        }
        throw new Error("ENOENT");
      },
      readdirImpl: async () => {
        throw new Error("no projects dir");
      },
      now,
      cachePath,
      warn: () => {},
    });
    assert.equal(result.source, "fail-open");
    assert.equal(existsSync(cachePath), false, "fail-open must not be cached");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// --- structural assert on the BUILT SKILL.md ---------------------------------

test("built claude-code usage-guard SKILL.md is user-invocable + has standalone-form section", async () => {
  const built = await realReadFile(
    join(ROOT, "dist", "claude-code", ".claude", "skills", "usage-guard", "SKILL.md"),
    "utf8",
  );
  // frontmatter block
  const fm = built.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm, "SKILL.md must have frontmatter");
  assert.match(fm[1], /user-invocable:\s*true/, "frontmatter must declare user-invocable: true");
  assert.match(fm[1], /adapters:\s*claude-code/, "frontmatter must be gated to claude-code");
  assert.match(fm[1], /argument-hint:/, "frontmatter must declare argument-hint");
  // standalone form section
  assert.match(built, /単体形態/, "body must document the standalone /usage-guard form");
  assert.match(built, /\/usage-guard/, "body must reference the /usage-guard invocation");
  // self-contained (M1): must NOT thin-wrap the .agents/ canonical
  assert.doesNotMatch(
    built,
    /`\.agents\/skills\/usage-guard\/SKILL\.md` を Read/,
    "usage-guard must be self-contained, not a thin wrapper over .agents/ canonical",
  );
});

test("usage-guard ships its usage-check.mjs extra file in the claude-code payload", async () => {
  const script = await realReadFile(
    join(ROOT, "dist", "claude-code", ".claude", "skills", "usage-guard", "usage-check.mjs"),
    "utf8",
  );
  assert.match(script, /api\/oauth\/usage/, "extra file must ship verbatim");
  // M2: the dist rewrite must not have corrupted HOME-anchored path literals.
  assert.doesNotMatch(
    script,
    /~\/\.claude\/skills\/usage-guard\/usage-check\.mjs/,
    "extra file must not contain a rewritten .claude/skills/ self-path literal",
  );
});
