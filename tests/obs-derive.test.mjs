// Tests for obs-derive.mjs — the artifact-derived SessionEnd capture hook. All
// I/O is dependency-injected (no stdin, no real transcript reads, no ~/.agents
// writes). Covers: transcript parsing (both invocation channels), event
// derivation (schema-valid, no skill-arg leakage), and the fail-open contract
// of run() (transcript unreadable / no path still emits the heartbeat, no throw).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveEvents,
  parseTranscript,
  run,
} from "../.agents/skills/skill-observability/obs-derive.mjs";
import { loadSchema, validateEvent } from "../.agents/skills/skill-observability/obs-emit.mjs";

const FIXED_NOW = () => new Date("2026-06-29T00:00:00.000Z");

// A realistic transcript: a model Skill tool_use, a user slash command, plus
// noise lines (text, a Bash tool_use, malformed JSON) that must be ignored.
const TRANSCRIPT = [
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", name: "Skill", input: { skill: "drive", args: "--merge #1 SECRET" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    message: { role: "user", content: "<command-name>/review</command-name> please" },
  }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
  }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "hello world" }] },
  }),
  "{ this is not valid json",
  "",
].join("\n");

test("parseTranscript: derives both channels, ignores noise", () => {
  const inv = parseTranscript(TRANSCRIPT);
  assert.deepEqual(inv, [
    { skill: "drive", operation: "invoke_agent" },
    { skill: "review", operation: "slash_command" },
  ]);
});

test("parseTranscript: empty / irrelevant input yields nothing", () => {
  assert.deepEqual(parseTranscript(""), []);
  assert.deepEqual(parseTranscript('{"type":"assistant","message":{"content":[]}}'), []);
});

test("deriveEvents: heartbeat first + one start per invocation", () => {
  const events = deriveEvents(
    [
      { skill: "drive", operation: "invoke_agent" },
      { skill: "review", operation: "slash_command" },
    ],
    { sessionId: "s1", now: FIXED_NOW, env: {} },
  );
  assert.equal(events.length, 3);
  assert.equal(events[0].event, "heartbeat");
  assert.equal(events[0].skill, "skill-observability");
  assert.equal(events[1].event, "start");
  assert.equal(events[1].skill, "drive");
  assert.equal(events[1].operation, "invoke_agent");
  assert.equal(events[2].skill, "review");
  // session id propagated to every event.
  assert.ok(events.every((e) => e.session_id === "s1"));
});

test("deriveEvents: skill args never leak into events (privacy)", () => {
  const events = deriveEvents(parseTranscript(TRANSCRIPT), {
    sessionId: "s1",
    now: FIXED_NOW,
    env: {},
  });
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes("SECRET"));
  assert.ok(!serialized.includes("args"));
});

test("deriveEvents: every derived event is schema-valid", async () => {
  const schema = await loadSchema();
  const events = deriveEvents(parseTranscript(TRANSCRIPT), {
    sessionId: "s1",
    now: FIXED_NOW,
    env: {},
  });
  for (const ev of events) {
    assert.equal(validateEvent(ev, schema).ok, true, `invalid: ${JSON.stringify(ev)}`);
  }
});

test("run: user-typed built-in commands (non-skills) are filtered out", async () => {
  const transcript = [
    JSON.stringify({ type: "user", message: { content: "<command-name>/clear</command-name>" } }),
    JSON.stringify({ type: "user", message: { content: "<command-name>/review</command-name>" } }),
  ].join("\n");
  const appended = [];
  await run({
    readStdinImpl: async () =>
      JSON.stringify({ session_id: "s1", transcript_path: "/fake/t.jsonl" }),
    readTranscriptImpl: async () => transcript,
    isSkillImpl: (name) => name === "review", // /clear is not an installed skill
    appendImpl: async (ev) => appended.push(ev),
    now: FIXED_NOW,
    env: {},
  });
  const starts = appended.filter((e) => e.event === "start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].skill, "review");
});

test("run: appends heartbeat + one start per invocation", async () => {
  const appended = [];
  const res = await run({
    readStdinImpl: async () =>
      JSON.stringify({ session_id: "s1", transcript_path: "/fake/t.jsonl" }),
    readTranscriptImpl: async () => TRANSCRIPT,
    appendImpl: async (ev) => appended.push(ev),
    now: FIXED_NOW,
    env: {},
  });
  assert.equal(res.ok, true);
  assert.equal(res.appended, 3);
  assert.equal(appended[0].event, "heartbeat");
  assert.equal(appended.filter((e) => e.event === "start").length, 2);
});

test("run: transcript unreadable → heartbeat only, no throw (fail-open)", async () => {
  const appended = [];
  const res = await run({
    readStdinImpl: async () => JSON.stringify({ session_id: "s1", transcript_path: "/gone.jsonl" }),
    readTranscriptImpl: async () => {
      throw new Error("ENOENT");
    },
    appendImpl: async (ev) => appended.push(ev),
    now: FIXED_NOW,
    env: {},
    warn: () => {},
  });
  assert.equal(res.appended, 1);
  assert.equal(appended[0].event, "heartbeat");
});

test("run: no transcript_path → heartbeat only", async () => {
  const appended = [];
  const res = await run({
    readStdinImpl: async () => JSON.stringify({ session_id: "s1" }),
    appendImpl: async (ev) => appended.push(ev),
    now: FIXED_NOW,
    env: {},
  });
  assert.equal(res.appended, 1);
  assert.equal(appended[0].skill, "skill-observability");
});

test("run: malformed stdin → heartbeat only, no throw (fail-open)", async () => {
  const appended = [];
  const res = await run({
    readStdinImpl: async () => "not json",
    appendImpl: async (ev) => appended.push(ev),
    now: FIXED_NOW,
    env: {},
    warn: () => {},
  });
  assert.equal(res.appended, 1);
});
