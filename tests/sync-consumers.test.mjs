// Integration tests for the sync-consumers skill.
//
// These verify (1) frontmatter required fields (covered transitively by
// build-pipeline.test.mjs but asserted here explicitly per ozzy-labs/skills#83
// acceptance criteria), and (2) sync-consumers-specific invariants:
//   - SKILL.md references sync-targets.yaml + schemas/sync-targets.schema.json
//   - SKILL.claude-code.md declares argument-hint with the documented options
//   - SKILL.claude-code.md allowed-tools includes Agent (required for parallel
//     subagent dispatch via the drive Phase Final mechanism)

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertRequiredFields, parseSkillDocument } from "../scripts/lib/frontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_DIR = join(ROOT, "src", "skills", "sync-consumers");

test("sync-consumers skill directory exists", () => {
  assert.ok(existsSync(SKILL_DIR), `expected ${SKILL_DIR} to exist`);
});

test("SKILL.md has required frontmatter (name + description)", () => {
  const file = join(SKILL_DIR, "SKILL.md");
  const raw = readFileSync(file, "utf8");
  const { frontmatter } = parseSkillDocument(raw, file);
  assertRequiredFields(frontmatter, ["name", "description"], file);
  assert.equal(frontmatter.name, "sync-consumers", "name must match skill directory");
});

test("SKILL.claude-code.md has required frontmatter (description)", () => {
  const file = join(SKILL_DIR, "SKILL.claude-code.md");
  const raw = readFileSync(file, "utf8");
  const { frontmatter } = parseSkillDocument(raw, file);
  assertRequiredFields(frontmatter, ["description"], file);
});

test("SKILL.claude-code.md declares argument-hint with all documented options", () => {
  const file = join(SKILL_DIR, "SKILL.claude-code.md");
  const raw = readFileSync(file, "utf8");
  const { frontmatter } = parseSkillDocument(raw, file);
  const hint = frontmatter["argument-hint"];
  assert.ok(hint, "argument-hint must be set");
  for (const opt of ["--source", "--dry-run", "--concurrency", "--merge", "--filter"]) {
    assert.ok(hint.includes(opt), `argument-hint must mention ${opt}, got: ${hint}`);
  }
});

test("SKILL.claude-code.md allowed-tools includes Agent (parallel dispatch required)", () => {
  const file = join(SKILL_DIR, "SKILL.claude-code.md");
  const raw = readFileSync(file, "utf8");
  const { frontmatter } = parseSkillDocument(raw, file);
  const tools = frontmatter["allowed-tools"];
  assert.ok(tools, "allowed-tools must be set");
  assert.ok(
    tools
      .split(",")
      .map((s) => s.trim())
      .includes("Agent"),
    `allowed-tools must include Agent, got: ${tools}`,
  );
});

test("SKILL.md references sync-targets.yaml (Phase 0 schema validation)", () => {
  const file = join(SKILL_DIR, "SKILL.md");
  const body = readFileSync(file, "utf8");
  assert.ok(body.includes("sync-targets.yaml"), "SKILL.md must reference sync-targets.yaml");
  assert.ok(
    body.includes("schemas/sync-targets.schema.json"),
    "SKILL.md must reference schemas/sync-targets.schema.json",
  );
});

test("SKILL.md references commons/scripts/sync-consumers.sh (helper)", () => {
  const file = join(SKILL_DIR, "SKILL.md");
  const body = readFileSync(file, "utf8");
  assert.ok(
    body.includes("commons/scripts/sync-consumers.sh"),
    "SKILL.md must reference the commons helper script path",
  );
});

test("SKILL.md documents helper return-value JSON shape (status enum + error)", () => {
  const file = join(SKILL_DIR, "SKILL.md");
  const body = readFileSync(file, "utf8");
  // The helper return-value section should enumerate the status values that
  // commons/scripts/sync-consumers.sh actually emits.
  for (const status of [
    "merged",
    "merge-ready",
    "auto-merge enabled",
    "no-change",
    "dry-run",
    "failed",
  ]) {
    assert.ok(body.includes(`"${status}"`), `SKILL.md must document helper status '${status}'`);
  }
});

test("SKILL.md documents --ssot-sha and --source-repo helper options", () => {
  const file = join(SKILL_DIR, "SKILL.md");
  const body = readFileSync(file, "utf8");
  assert.ok(body.includes("--ssot-sha"), "SKILL.md must document --ssot-sha option");
  assert.ok(body.includes("--source-repo"), "SKILL.md must document --source-repo option");
});
