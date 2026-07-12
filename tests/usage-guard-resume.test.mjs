// Tests for the usage-guard resume marker + SessionStart detection (#212).
//
// The marker (resume-marker.mjs) records "work is paused; here is the
// continuation and when to resume"; the SessionStart check (resume-check.mjs)
// surfaces an OVERDUE resume — the exact "stuck after reset" failure usage-guard
// exists to prevent. Everything is exercised through injected deps (no real
// ~/.claude), plus a real-fs round-trip that proves the atomic write.

import assert from "node:assert/strict";
import { mkdtemp, readFile as realRead, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateResumeCheck, run } from "../.agents/skills/usage-guard/resume-check.mjs";
import {
  clearResumeMarker,
  readResumeMarker,
  writeResumeMarker,
} from "../.agents/skills/usage-guard/resume-marker.mjs";

const FIXED_NOW = Date.parse("2026-06-15T00:00:00.000Z");
const now = () => FIXED_NOW;

// --- resume-marker: atomic write / read / clear ------------------------------

test("(#212) writeResumeMarker writes a temp sibling then renames (atomic)", async () => {
  const writes = [];
  const renames = [];
  await writeResumeMarker(
    { continuation: "/drive #212-213 --merge", fire_at: "2026-06-15T02:00:00.000Z" },
    {
      writeFileImpl: async (p) => writes.push(p),
      mkdirImpl: async () => {},
      renameImpl: async (from, to) => renames.push([from, to]),
      markerPath: "/fake/resume-pending.json",
      now,
    },
  );
  assert.equal(writes.length, 1);
  assert.match(writes[0], /^\/fake\/resume-pending\.json\.tmp\./, "written to a temp sibling");
  assert.deepEqual(
    renames[0],
    [writes[0], "/fake/resume-pending.json"],
    "renamed onto the marker path",
  );
});

test("(#212) readResumeMarker: missing / malformed → null", async () => {
  const missing = await readResumeMarker({
    readFileImpl: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    markerPath: "/fake/none.json",
  });
  assert.equal(missing, null, "absent marker → null");
  const bad = await readResumeMarker({
    readFileImpl: async () => "not json",
    markerPath: "/fake/x.json",
  });
  assert.equal(bad, null, "malformed marker → null");
});

test("(#212) marker round-trips through the real fs and clears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ug-marker-"));
  const markerPath = join(dir, "nested", "resume-pending.json");
  try {
    await writeResumeMarker(
      {
        continuation: "/drive #212-213 --merge",
        fire_at: "2026-06-15T02:00:00.000Z",
        trigger: "cron-oneshot",
      },
      { markerPath, now },
    );
    const read = await readResumeMarker({ readFileImpl: realRead, markerPath });
    assert.equal(read.continuation, "/drive #212-213 --merge");
    assert.equal(read.trigger, "cron-oneshot");
    assert.equal(read.armed_at, new Date(FIXED_NOW).toISOString(), "armed_at stamped from now");
    await clearResumeMarker({ markerPath });
    assert.equal(
      await readResumeMarker({ readFileImpl: realRead, markerPath }),
      null,
      "cleared → gone",
    );
    // Clearing an already-absent marker is a no-op (never throws).
    await clearResumeMarker({ markerPath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- resume-check: SessionStart detection ------------------------------------

test("(#212) evaluateResumeCheck: no marker → nothing surfaced", () => {
  const r = evaluateResumeCheck(null, now);
  assert.deepEqual(r, { pending: false, overdue: false, message: null });
});

test("(#212) evaluateResumeCheck: fire_at in the past → OVERDUE with the continuation", () => {
  const r = evaluateResumeCheck(
    { continuation: "/drive #212-213 --merge", fire_at: "2026-06-14T23:00:00.000Z" },
    now,
  );
  assert.equal(r.overdue, true);
  assert.match(r.message, /OVERDUE/);
  assert.match(r.message, /\/drive #212-213 --merge/, "names the continuation to re-run");
});

test("(#212) evaluateResumeCheck: fire_at in the future → pending (informational)", () => {
  const r = evaluateResumeCheck(
    { continuation: "/drive x", fire_at: "2026-06-15T02:00:00.000Z" },
    now,
  );
  assert.equal(r.pending, true);
  assert.equal(r.overdue, false);
  assert.match(r.message, /paused/);
});

test("(#212) run(): surfaces the overdue message via the out sink, exits 0", async () => {
  const out = [];
  const code = await run({
    readMarkerImpl: async () => ({
      continuation: "/drive #212-213 --merge",
      fire_at: "2026-06-14T23:00:00.000Z",
    }),
    now,
    out: (m) => out.push(m),
  });
  assert.equal(code, 0, "SessionStart check never blocks (exit 0)");
  assert.equal(out.length, 1);
  assert.match(out[0], /OVERDUE/);
});

test("(#212) run(): a marker read error fails open (exit 0, silent)", async () => {
  const out = [];
  const code = await run({
    readMarkerImpl: async () => {
      throw new Error("fs blew up");
    },
    now,
    out: (m) => out.push(m),
  });
  assert.equal(code, 0, "read error → fail-open");
  assert.equal(out.length, 0, "no output on a fail-open path");
});
