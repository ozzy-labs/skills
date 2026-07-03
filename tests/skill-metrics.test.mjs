// Tests for skill-metrics.mjs — the local read-only aggregator. All I/O is
// dependency-injected (no real ~/.agents reads/writes). Covers: event parsing,
// aggregation (counts, by_operation, outcomes), the min-n rate guard, the
// since/skill filters, ISO week derivation, and the fail-open run() path.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregate,
  computeTrend,
  isoYearWeek,
  parseArgs,
  parseEvents,
  pickPreviousSnapshot,
  resolveMinN,
  run,
  snapshotWeek,
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
    readdirImpl: async () => [], // no prior snapshot → hermetic (no real FS read)
    mkdirImpl: async () => {},
    writeImpl: async (p, c) => writes.push([p, c]),
    now: () => new Date("2026-06-29T00:00:00Z"),
  });
  assert.equal(r.skills.drive.invocations, 2);
  assert.equal(writes.length, 1);
  assert.ok(writes[0][0].endsWith("2026-W27.json"));
  assert.ok(r.snapshot.endsWith("2026-W27.json"));
  // A first-generation snapshot has no baseline to diff against.
  assert.equal(r.trend, null);
  // The persisted baseline must be a clean rollup (no derived trend/snapshot fields).
  const persisted = JSON.parse(writes[0][1]);
  assert.ok(!("trend" in persisted), "persisted snapshot must not nest the derived trend");
  assert.ok(!("snapshot" in persisted), "persisted snapshot must not embed its own path");
});

test("snapshotWeek: parses ISO year-week from snapshot basenames only", () => {
  assert.equal(snapshotWeek("2026-W27.json"), "2026-W27");
  assert.equal(snapshotWeek("/a/b/2026-W01.json"), "2026-W01");
  assert.equal(snapshotWeek("2026-W27.txt"), null);
  assert.equal(snapshotWeek("garbage"), null);
});

test("pickPreviousSnapshot: latest strictly-older snapshot; ignores current + non-snapshots", () => {
  const files = ["2026-W24.json", "2026-W25.json", "2026-W27.json", "garbage.json", "README.md"];
  assert.deepEqual(pickPreviousSnapshot(files, "2026-W27"), {
    week: "2026-W25",
    file: "2026-W25.json",
  });
  // The current week itself is never a baseline for its own diff.
  assert.equal(pickPreviousSnapshot(["2026-W27.json"], "2026-W27"), null);
  // ISO year-week strings sort chronologically across the year boundary.
  assert.deepEqual(pickPreviousSnapshot(["2025-W52.json", "2026-W01.json"], "2026-W02"), {
    week: "2026-W01",
    file: "2026-W01.json",
  });
});

test("computeTrend: null when there is no previous generation", () => {
  assert.equal(computeTrend({ skills: {}, signals: {} }, null), null);
  assert.equal(computeTrend({ skills: {}, signals: {} }, undefined), null);
});

test("computeTrend: count deltas always shown; rate delta inherits the min-n guard", () => {
  const prev = {
    window: { since: "2026-06-08T00:00:00Z", until: "2026-06-14T00:00:00Z" },
    skills: {
      a: { invocations: 2, abort_rate: null, abort_rate_suppressed: true }, // below min-n
      b: { invocations: 10, abort_rate: 0.2, abort_rate_suppressed: false }, // cleared
      d: { invocations: 8, abort_rate: 0.3, abort_rate_suppressed: false }, // cleared prev
    },
    signals: { "usage_guard.fail_open": 1 },
  };
  const cur = {
    skills: {
      a: { invocations: 5, abort_rate: null, abort_rate_suppressed: true },
      b: { invocations: 12, abort_rate: 0.1, abort_rate_suppressed: false },
      c: { invocations: 3, abort_rate: null, abort_rate_suppressed: true }, // new skill
      d: { invocations: 2, abort_rate: null, abort_rate_suppressed: true }, // dropped below min-n
    },
    signals: { "usage_guard.fail_open": 3, "hitl.rejected": 2 },
  };
  const t = computeTrend(cur, prev, { minN: 5 });

  // Count deltas are always present (including new skills, from 0).
  assert.equal(t.skills.a.invocations_delta, 3);
  assert.equal(t.skills.b.invocations_delta, 2);
  assert.equal(t.skills.c.invocations_delta, 3);
  assert.equal(t.skills.d.invocations_delta, -6);

  // Rate delta suppressed when EITHER generation is below min-n.
  assert.equal(t.skills.a.abort_rate_delta, null); // both below
  assert.equal(t.skills.a.abort_rate_delta_suppressed, true);
  assert.equal(t.skills.d.abort_rate_delta, null); // prev cleared, cur below → suppressed
  assert.equal(t.skills.d.abort_rate_delta_suppressed, true);
  assert.equal(t.skills.c.abort_rate_delta, null); // new skill, no prev rate → suppressed
  assert.equal(t.skills.c.abort_rate_delta_suppressed, true);

  // Rate delta shown only when BOTH generations cleared the guard.
  assert.equal(t.skills.b.abort_rate_delta, -0.1);
  assert.equal(t.skills.b.abort_rate_delta_suppressed, false);

  // Signal count deltas (including a new signal appearing from 0).
  assert.equal(t.signals["usage_guard.fail_open"], 2);
  assert.equal(t.signals["hitl.rejected"], 2);

  // Baseline window is carried for rendering.
  assert.deepEqual(t.baseline_window, {
    since: "2026-06-08T00:00:00Z",
    until: "2026-06-14T00:00:00Z",
  });
});

test("run: computes week-over-week trend against the previous snapshot", async () => {
  const prevRollup = aggregate(
    parseEvents(
      ev({
        ts: "2026-06-10T00:00:00Z",
        session_id: "p",
        skill: "drive",
        event: "start",
        operation: "slash_command",
      }),
    ),
  );
  const r = await run([], {
    existsImpl: () => true,
    readdirImpl: async () => ["2026-W24.json", "not-a-snapshot.txt"],
    // The events path returns the log; the snapshot path returns the prior rollup.
    readImpl: async (p) => (p.endsWith(".json") ? JSON.stringify(prevRollup) : LOG),
    now: () => new Date("2026-06-29T00:00:00Z"), // ISO week 27
    warn: () => {},
  });
  assert.ok(r.trend, "trend present when a prior snapshot exists");
  assert.equal(r.trend.baseline_week, "2026-W24");
  assert.equal(r.trend.baseline_file, "2026-W24.json");
  // Privacy: the rollup (quoted by lessons-triage into issues) must carry no
  // HOME-anchored absolute path — baseline_file is a basename only.
  assert.ok(!r.trend.baseline_file.includes("/"), "baseline_file must be a basename, not a path");
  // Current drive invocations (2 in LOG) minus previous (1) = +1.
  assert.equal(r.trend.skills.drive.invocations_delta, 1);
});

test("run: trend null (fail-open) when the previous snapshot is unreadable", async () => {
  const r = await run([], {
    existsImpl: () => true,
    readdirImpl: async () => ["2026-W24.json"],
    readImpl: async (p) => {
      if (p.endsWith(".json")) throw new Error("corrupt snapshot");
      return LOG;
    },
    now: () => new Date("2026-06-29T00:00:00Z"),
    warn: () => {},
  });
  assert.equal(r.trend, null);
  assert.equal(r.skills.drive.invocations, 2); // rollup itself still produced
});
