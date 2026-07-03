// Doc-content tests for the weekly observability routine (ADR-0028 R5, #184).
//
// The routine itself (a scheduled agent driving capture → aggregate → reflect →
// consume) is a dogfood activity that cannot execute inside an isolated worker
// (no schedule daemon, no live ~/.agents event stream). So the *contract* is
// pinned here by asserting on the recipe doc and its README wiring:
//   1. docs/observability-routine.md exists and documents the schedule prompt
//   2. the four loop stages + the consume connection are named
//   3. the two HATL boundaries (filing approval + auto-ok label) are documented
//   4. README.md / docs/README.ja.md wire the routine into the Observability
//      section (weekly driving paragraph + link to the recipe)

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTINE = join(ROOT, "docs", "observability-routine.md");

test("observability-routine.md documents the weekly schedule prompt", async () => {
  const body = await readFile(ROUTINE, "utf8");
  // The scheduled pass starts by snapshotting + trending.
  assert.match(
    body,
    /\/skill-metrics --snapshot/,
    "schedule prompt must run skill-metrics --snapshot",
  );
  // Reflection is metrics-primed and gated by a single batch confirmation.
  assert.match(body, /metrics-primed/, "reflection must be metrics-primed");
  assert.match(body, /\/lessons-triage/, "schedule prompt must invoke lessons-triage");
  assert.match(body, /batch[- ]confirm/i, "issue filing must be one batch confirmation");
  assert.match(
    body,
    /externally-visible/,
    "filing must be classed under the externally-visible gate",
  );
});

test("observability-routine.md names the four loop stages + consume connection", async () => {
  const body = await readFile(ROUTINE, "utf8");
  for (const stage of ["capture", "aggregate", "reflect", "consume"]) {
    assert.match(body, new RegExp(stage), `loop stage must be named: ${stage}`);
  }
  // Consume is the backlog --auto half, gated by the auto-ok label.
  assert.match(body, /\/backlog --auto/, "consume pass must use backlog --auto");
  assert.match(body, /auto-ok/, "auto-ok label must gate consumption");
});

test("observability-routine.md documents the two HATL boundaries", async () => {
  const body = await readFile(ROUTINE, "utf8");
  assert.match(body, /HATL/, "HATL must be named");
  assert.match(
    body,
    /Issue-filing approval|filing approval/i,
    "boundary 1 (filing approval) must be documented",
  );
  assert.match(body, /`auto-ok` label/, "boundary 2 (auto-ok label) must be documented");
  // auto-ok is human-only; no skill applies it.
  assert.match(body, /human-only/, "auto-ok must be documented as human-only");
});

test("README.md Observability section wires in the weekly routine", async () => {
  const body = await readFile(join(ROOT, "README.md"), "utf8");
  assert.match(body, /docs\/observability-routine\.md/, "README must link the routine recipe");
  assert.match(body, /Driving the loop weekly/, "README must describe driving the loop weekly");
  assert.match(body, /two boundary conditions/, "README must state the two HATL boundaries");
});

test("docs/README.ja.md Observability section mirrors the weekly routine", async () => {
  const body = await readFile(join(ROOT, "docs", "README.ja.md"), "utf8");
  assert.match(body, /observability-routine\.md/, "ja README must link the routine recipe");
  assert.match(body, /週次でループを回す/, "ja README must describe driving the loop weekly");
  assert.match(body, /2 点だけ/, "ja README must state the two HATL boundaries");
});
