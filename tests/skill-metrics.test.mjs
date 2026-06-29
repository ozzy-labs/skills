// Tests for skill-metrics.mjs — the local read-only aggregator. All I/O is
// dependency-injected (no real ~/.agents reads/writes). Covers: event parsing,
// aggregation (counts, by_operation, outcomes), the min-n rate guard, the
// since/skill filters, ISO week derivation, and the fail-open run() path.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregate,
  isoYearWeek,
  parseArgs,
  parseEvents,
  resolveMinN,
  run,
} from "../.agents/skills/skill-metrics/skill-metrics.mjs";

function ev(o) {
  return JSON.stringify({ schema_version: 1, adapter: "claude-code", session_id: "s", ...o });
}

const LOG = [
  ev({
    ts: "2026-06-20T00:00:00Z",
    session_id: "a",
    skill: "skill-observability",
    event: "heartbeat",
  }),
  ev({
    ts: "2026-06-20T00:00:01Z",
    session_id: "a",
    skill: "drive",
    event: "start",
    operation: "slash_command",
  }),
  ev({
    ts: "2026-06-21T00:00:00Z",
    session_id: "b",
    skill: "drive",
    event: "start",
    operation: "invoke_agent",
  }),
  ev({
    ts: "2026-06-21T00:00:01Z",
    session_id: "b",
    skill: "review",
    event: "start",
    operation: "slash_command",
  }),
  ev({
    ts: "2026-06-22T00:00:00Z",
    session_id: "b",
    skill: "review",
    event: "signal",
    name: "review.deep_to_quick_fallback",
  }),
  "garbage line",
  "",
  ev({
    ts: "2026-06-22T00:00:02Z",
    session_id: "b",
    skill: "drive",
    event: "outcome",
    status: "aborted",
  }),
].join("\n");

test("parseEvents: skips malformed and empty lines", () => {
  const events = parseEvents(LOG);
  assert.equal(events.length, 6);
});

test("parseArgs / resolveMinN", () => {
  assert.deepEqual(parseArgs(["--since=x", "--snapshot"]), { since: "x", snapshot: true });
  assert.equal(resolveMinN({}), 5);
  assert.equal(resolveMinN({ SKILL_METRICS_MIN_N: "10" }), 10);
  assert.equal(resolveMinN({ SKILL_METRICS_MIN_N: "bad" }), 5);
});

test("aggregate: per-skill invocation counts + by_operation; window + sessions", () => {
  const r = aggregate(parseEvents(LOG));
  assert.equal(r.skills.drive.invocations, 2);
  assert.deepEqual(r.skills.drive.by_operation, { slash_command: 1, invoke_agent: 1 });
  assert.equal(r.skills.review.invocations, 1);
  // heartbeat does not count as an invocation.
  assert.ok(!r.skills["skill-observability"]);
  assert.equal(r.window.sessions, 2);
  assert.equal(r.window.since, "2026-06-20T00:00:00Z");
  assert.equal(r.window.until, "2026-06-22T00:00:02Z");
});

test("aggregate: signals counted + friction surfaced as notable + aborted outcome notable", () => {
  const r = aggregate(parseEvents(LOG));
  assert.equal(r.signals["review.deep_to_quick_fallback"], 1);
  assert.ok(
    r.notable.some((n) => n.kind === "signal" && n.name === "review.deep_to_quick_fallback"),
  );
  assert.ok(
    r.notable.some((n) => n.kind === "outcome" && n.skill === "drive" && n.status === "aborted"),
  );
  assert.equal(r.skills.drive.outcomes.aborted, 1);
});

test("aggregate: abort_rate suppressed below min_n, shown at/above", () => {
  const small = aggregate(parseEvents(LOG), { minN: 5 });
  assert.equal(small.skills.drive.abort_rate, null);
  assert.equal(small.skills.drive.abort_rate_suppressed, true);

  // 5 outcomes (1 aborted) → denom 5 >= minN 5 → rate shown.
  const many = [
    ev({ skill: "x", event: "outcome", status: "aborted" }),
    ev({ skill: "x", event: "outcome", status: "completed" }),
    ev({ skill: "x", event: "outcome", status: "completed" }),
    ev({ skill: "x", event: "outcome", status: "completed" }),
    ev({ skill: "x", event: "outcome", status: "completed" }),
  ].join("\n");
  const r = aggregate(parseEvents(many), { minN: 5 });
  assert.equal(r.skills.x.abort_rate, 0.2);
  assert.equal(r.skills.x.abort_rate_suppressed, false);
});

test("aggregate: since and skill filters", () => {
  const sinceR = aggregate(parseEvents(LOG), { since: "2026-06-21T00:00:00Z" });
  assert.ok(!sinceR.window.since || sinceR.window.since >= "2026-06-21T00:00:00Z");
  assert.equal(sinceR.skills.drive.invocations, 1); // only the 06-21 start

  const skillR = aggregate(parseEvents(LOG), { skill: "review" });
  assert.equal(skillR.skills.drive, undefined);
  assert.equal(skillR.skills.review.invocations, 1);
});

test("isoYearWeek: ISO-8601 boundaries", () => {
  assert.equal(isoYearWeek(new Date("2026-01-01T00:00:00Z")), "2026-W01"); // Thu → W01
  assert.equal(isoYearWeek(new Date("2026-01-04T00:00:00Z")), "2026-W01"); // Sun → still W01
  assert.equal(isoYearWeek(new Date("2026-01-05T00:00:00Z")), "2026-W02"); // Mon → W02
});

test("run: missing log → empty rollup, no throw (fail-open)", async () => {
  const r = await run([], { existsImpl: () => false, warn: () => {} });
  assert.equal(r.window.events, 0);
  assert.deepEqual(r.skills, {});
});

test("run: aggregates injected log; --snapshot writes via injected writer", async () => {
  const writes = [];
  const r = await run(["--snapshot"], {
    existsImpl: () => true,
    readImpl: async () => LOG,
    mkdirImpl: async () => {},
    writeImpl: async (p, c) => writes.push([p, c]),
    now: () => new Date("2026-06-29T00:00:00Z"),
  });
  assert.equal(r.skills.drive.invocations, 2);
  assert.equal(writes.length, 1);
  assert.ok(writes[0][0].endsWith("2026-W27.json"));
  assert.ok(r.snapshot.endsWith("2026-W27.json"));
});
