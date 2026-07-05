// Structural tests for the implement skill (ADR-0028 R3, #181 PR 2/4).
//
// implement is a documentation-driven skill: the canonical SKILL.md is read
// and executed by an agent. PR 2 replaces implement's always-on plan-approval
// gate with an action classification that consults the central autonomy policy
// (the `policy` skill). These tests assert on the document's *structure* — the
// contract the skill pins down — rather than on a runtime:
//   1. canonical / companion frontmatter are well-formed
//   2. the action classification + policy reference is documented (fixed
//      vocabulary: reversible-local / irreversible, proceed / ask)
//   3. the old always-approval prose is removed (negative assertion)
//   4. Claude-Code-only behaviors stay in the companion (AskUserQuestion is
//      *not* present in canonical SKILL.md, only in the companion, and is now
//      gated on gate=ask)
//   5. policy absence stays safe (fail-safe / zero-config defaults documented)

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertRequiredFields, parseSkillDocument } from "../scripts/lib/frontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_DIR = join(ROOT, ".agents", "skills", "implement");
const CANONICAL = join(SKILL_DIR, "SKILL.md");
const COMPANION = join(SKILL_DIR, "SKILL.claude-code.md");

async function loadCanonical() {
  const raw = await readFile(CANONICAL, "utf8");
  const { frontmatter, body } = parseSkillDocument(raw, ".agents/skills/implement/SKILL.md");
  return { frontmatter, body, raw };
}

async function loadCompanion() {
  const raw = await readFile(COMPANION, "utf8");
  const { frontmatter, body } = parseSkillDocument(
    raw,
    ".agents/skills/implement/SKILL.claude-code.md",
  );
  return { frontmatter, body, raw };
}

test("implement canonical SKILL.md has required frontmatter", async () => {
  const { frontmatter } = await loadCanonical();
  assertRequiredFields(frontmatter, ["name", "description"], "implement SKILL.md");
  assert.equal(frontmatter.name, "implement", "name must match the directory name");
  assert.ok(frontmatter.description.length > 0, "description must be non-empty");
});

test("implement companion SKILL.claude-code.md is a Claude-only overlay", async () => {
  const { frontmatter } = await loadCompanion();
  assert.ok(!frontmatter.description, "companion must not duplicate canonical description");
  assert.match(
    frontmatter["allowed-tools"] ?? "",
    /AskUserQuestion/,
    "companion must allow AskUserQuestion (used only when gate=ask)",
  );
  assert.equal(
    frontmatter["disable-model-invocation"],
    "true",
    "skill must be user-invoked, not model-invoked",
  );
});

test("implement canonical SKILL.md classifies actions and references the central policy", async () => {
  const { body } = await loadCanonical();
  // Fixed action-class vocabulary from the policy skill.
  assert.match(body, /reversible-local/, "must classify branch work as reversible-local");
  assert.match(body, /irreversible/, "must classify destructive changes as irreversible");
  // gate vocabulary.
  assert.match(body, /proceed/, "must document the proceed gate");
  assert.match(body, /\bask\b/, "must document the ask gate");
  // policy read substrate + action name for reversible branch edits.
  assert.match(body, /policy-read\.mjs/, "must point at the policy read substrate");
  assert.match(body, /branch-edit/, "must name the policy action for branch edits");
  // irreversible examples explicitly enumerated per the ADR.
  assert.match(
    body,
    /migration.*data deletion.*CI or release config|CI or release config/s,
    "must enumerate irreversible examples (migration / data deletion / CI-release config)",
  );
});

test("implement canonical SKILL.md removes the old always-approval prose (negative)", async () => {
  const { body } = await loadCanonical();
  assert.doesNotMatch(
    body,
    /計画の承認を得てから実装に進む/,
    "old unconditional plan-approval step must be removed",
  );
  assert.doesNotMatch(
    body,
    /実装計画の承認なしにコード変更を開始しない/,
    "old unconditional no-change-without-approval caution must be removed",
  );
});

test("implement canonical SKILL.md documents policy-absence fail-safe", async () => {
  const { body } = await loadCanonical();
  assert.match(
    body,
    /does not break even if policy is absent/i,
    "must document policy-absence safety",
  );
  assert.match(body, /fail-safe/, "must reference the fail-safe design");
});

test("implement keeps Claude-Code-only behaviors in the companion, gated on ask", async () => {
  const { body: canonicalBody } = await loadCanonical();
  const { body: companionBody } = await loadCompanion();
  assert.ok(
    !canonicalBody.includes("AskUserQuestion"),
    "canonical must stay CLI-neutral (AskUserQuestion belongs to the companion)",
  );
  assert.match(companionBody, /AskUserQuestion/, "companion must define the approval flow");
  // The approval prompt is now conditional on the resolved gate.
  assert.match(companionBody, /gate=`?proceed`?/, "companion must document the proceed branch");
  assert.match(companionBody, /gate=`?ask`?/, "companion must gate the prompt on ask");
  assert.match(companionBody, /drive/, "companion must reconcile with drive's delegated autonomy");
});
