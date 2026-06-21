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
  readAccessToken,
  resolveResumeBuffer,
  resolveThreshold,
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
