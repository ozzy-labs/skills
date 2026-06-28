// Tests for the observability event contract (event.schema.json) as the single
// SSOT. These assert the schema's structural guarantees (privacy via
// additionalProperties:false, required envelope, event-implied requireds) and
// that the obs-emit validator, reading that same file, agrees with it — proving
// there is exactly one source of truth (no doc/code drift).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadSchema, validateEvent } from "../.agents/skills/skill-observability/obs-emit.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_FILE = join(ROOT, ".agents/skills/skill-observability/event.schema.json");

const VALID = {
  schema_version: 1,
  ts: "2026-06-29T00:00:00.000Z",
  adapter: "claude-code",
  session_id: "sess-1",
  skill: "drive",
  event: "start",
};

test("schema file: privacy + envelope guarantees", async () => {
  const schema = JSON.parse(await readFile(SCHEMA_FILE, "utf8"));
  // additionalProperties:false is the mechanical privacy guard.
  assert.equal(schema.additionalProperties, false);
  // Required envelope.
  assert.deepEqual(schema.required, [
    "schema_version",
    "ts",
    "adapter",
    "session_id",
    "skill",
    "event",
  ]);
  // schema_version is pinned to 1.
  assert.equal(schema.properties.schema_version.const, 1);
  // repo_hash is constrained to a 12-hex prefix (never a raw name/path).
  assert.equal(schema.properties.repo_hash.pattern, "^[a-f0-9]{12}$");
});

test("schema is the SSOT the validator consumes", async () => {
  const schema = await loadSchema({ schemaPath: SCHEMA_FILE });
  assert.equal(validateEvent(VALID, schema).ok, true);
});

test("rejects unknown (payload-like) fields", async () => {
  const schema = await loadSchema({ schemaPath: SCHEMA_FILE });
  const res = validateEvent({ ...VALID, payload: "secret diff" }, schema);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("payload")));
});

test("outcome event implies status; signal event implies name", async () => {
  const schema = await loadSchema({ schemaPath: SCHEMA_FILE });
  assert.equal(validateEvent({ ...VALID, event: "outcome" }, schema).ok, false);
  assert.equal(validateEvent({ ...VALID, event: "outcome", status: "completed" }, schema).ok, true);
  assert.equal(validateEvent({ ...VALID, event: "signal" }, schema).ok, false);
  assert.equal(
    validateEvent({ ...VALID, event: "signal", name: "review.loop_iter" }, schema).ok,
    true,
  );
});

test("enforces enums and const", async () => {
  const schema = await loadSchema({ schemaPath: SCHEMA_FILE });
  assert.equal(validateEvent({ ...VALID, adapter: "emacs" }, schema).ok, false);
  assert.equal(validateEvent({ ...VALID, event: "nope" }, schema).ok, false);
  assert.equal(validateEvent({ ...VALID, schema_version: 2 }, schema).ok, false);
  assert.equal(validateEvent({ ...VALID, event: "outcome", status: "exploded" }, schema).ok, false);
});
