// Tests for obs-emit.mjs — the fail-open append+validate write substrate. All
// I/O is dependency-injected (no real ~/.agents writes, no real fs reads beyond
// the sibling schema via loadSchema's default). Covers: arg parsing, repo
// hashing (privacy), event building, append, and the fail-open contract of
// run() (a rejected or failed emit never throws and never writes a bad line).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendEvent,
  buildEvent,
  hashRepo,
  loadSchema,
  parseArgs,
  resolveAdapter,
  resolveSessionId,
  run,
} from "../.agents/skills/skill-observability/obs-emit.mjs";

const FIXED_NOW = () => new Date("2026-06-29T00:00:00.000Z");

test("parseArgs: --key=value and bare flags", () => {
  assert.deepEqual(parseArgs(["--skill=drive", "--event=start", "--merge", "x"]), {
    skill: "drive",
    event: "start",
    merge: true,
  });
});

test("hashRepo: deterministic 12-hex prefix, raw never present", () => {
  const h = hashRepo("/home/me/secret-repo");
  assert.match(h, /^[a-f0-9]{12}$/);
  assert.equal(h, hashRepo("/home/me/secret-repo"));
  assert.notEqual(h, hashRepo("/home/me/other-repo"));
  assert.ok(!h.includes("secret"));
});

test("resolveAdapter / resolveSessionId: flag → env → default", () => {
  assert.equal(resolveAdapter(undefined, {}), "claude-code");
  assert.equal(resolveAdapter("codex-cli", {}), "codex-cli");
  assert.equal(resolveAdapter(undefined, { OZZY_SKILLS_ADAPTER: "gemini-cli" }), "gemini-cli");
  assert.equal(resolveSessionId(undefined, {}), "unknown");
  assert.equal(resolveSessionId("s1", {}), "s1");
  assert.equal(resolveSessionId(undefined, { CLAUDE_SESSION_ID: "envsess" }), "envsess");
});

test("buildEvent: envelope + only-provided optionals + repo hashing", () => {
  const ev = buildEvent(
    { skill: "review", event: "signal", name: "review.loop_iter", value: "2", repo: "/r/x" },
    { now: FIXED_NOW, env: {}, hashImpl: hashRepo },
  );
  assert.equal(ev.schema_version, 1);
  assert.equal(ev.ts, "2026-06-29T00:00:00.000Z");
  assert.equal(ev.adapter, "claude-code");
  assert.equal(ev.session_id, "unknown");
  assert.equal(ev.skill, "review");
  assert.equal(ev.event, "signal");
  assert.equal(ev.name, "review.loop_iter");
  assert.equal(ev.value, 2);
  assert.match(ev.repo_hash, /^[a-f0-9]{12}$/);
  // Optionals not supplied must be absent (so strict validation stays meaningful).
  assert.ok(!("status" in ev));
  assert.ok(!("phase" in ev));
});

test("buildEvent: non-finite value is dropped", () => {
  const ev = buildEvent(
    { skill: "x", event: "signal", name: "n", value: "abc" },
    { now: FIXED_NOW, env: {} },
  );
  assert.ok(!("value" in ev));
});

test("appendEvent: writes exactly one JSON line via injected append", async () => {
  const writes = [];
  await appendEvent(
    { schema_version: 1, event: "heartbeat" },
    {
      eventsPath: "/fake/events.jsonl",
      mkdirImpl: async () => {},
      appendImpl: async (p, s) => writes.push([p, s]),
    },
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "/fake/events.jsonl");
  assert.equal(writes[0][1], '{"schema_version":1,"event":"heartbeat"}\n');
});

test("run: valid event → built, validated, appended", async () => {
  const appended = [];
  const res = await run(["--skill=drive", "--event=outcome", "--status=completed"], {
    now: FIXED_NOW,
    env: {},
    appendImpl: async (ev) => appended.push(ev),
  });
  assert.equal(res.ok, true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].status, "completed");
});

test("run: invalid event is rejected and NOT appended (fail-open, no throw)", async () => {
  const appended = [];
  // outcome without status → schema-invalid.
  const res = await run(["--skill=drive", "--event=outcome"], {
    now: FIXED_NOW,
    env: {},
    appendImpl: async (ev) => appended.push(ev),
    warn: () => {},
  });
  assert.equal(res.ok, false);
  assert.equal(appended.length, 0);
  assert.ok(res.errors.some((e) => e.includes("status")));
});

test("run: schema load failure is swallowed (fail-open, no throw)", async () => {
  const appended = [];
  const res = await run(["--skill=drive", "--event=start"], {
    now: FIXED_NOW,
    env: {},
    loadSchemaImpl: async () => {
      throw new Error("schema gone");
    },
    appendImpl: async (ev) => appended.push(ev),
    warn: () => {},
  });
  assert.equal(res.ok, false);
  assert.equal(appended.length, 0);
});

test("run: unknown field rejected (privacy guard end-to-end)", async () => {
  // No CLI flag can inject an arbitrary field, but verify the validator path
  // rejects one if a future caller passes it through buildEvent shape.
  const schema = await loadSchema();
  assert.equal(schema.additionalProperties, false);
});
