// Structural + rule tests for the release skill (issue #178).
//
// release is a documentation-driven skill (no engine .mjs): an agent Reads the
// canonical SKILL.md and executes it. So these tests assert on the document's
// *structure* — the contract the skill pins down — plus a fixture reimplementation
// of the deterministic SemVer-consistency rule (the one verification the skill
// describes as "fixture-able"):
//   1. canonical / companion frontmatter are well-formed
//   2. detection command, fixed verification checklist, and the SemVer rule are
//      documented
//   3. the default approval gate is retained and references the central policy;
//      `--auto` skips the gate ONLY when every verification passes (fail → stop)
//   4. polling interval / cap and the publish-less-repo branch are documented
//   5. Claude-Code-only behavior (AskUserQuestion) lives in the companion, not
//      the CLI-neutral canonical body
//   6. the SemVer-consistency rule holds over fixtures (commit types → bump,
//      including `!` / BREAKING CHANGE)
//   7. README.md / docs/README.ja.md / CLAUDE.md carry a `release` entry
//      (readme-catalog.test.mjs enforces the full set + counts; this is a
//      targeted complement)

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertRequiredFields, parseSkillDocument } from "../scripts/lib/frontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_DIR = join(ROOT, ".agents", "skills", "release");
const CANONICAL = join(SKILL_DIR, "SKILL.md");
const COMPANION = join(SKILL_DIR, "SKILL.claude-code.md");

async function loadCanonical() {
  const raw = await readFile(CANONICAL, "utf8");
  const { frontmatter, body } = parseSkillDocument(raw, ".agents/skills/release/SKILL.md");
  return { frontmatter, body, raw };
}

async function loadCompanion() {
  const raw = await readFile(COMPANION, "utf8");
  const { frontmatter, body } = parseSkillDocument(
    raw,
    ".agents/skills/release/SKILL.claude-code.md",
  );
  return { frontmatter, body, raw };
}

// ---------------------------------------------------------------------------
// Fixture reimplementation of the SemVer-consistency rule (SKILL.md).
//
// Input: the set of Conventional Commit types included in the release + whether
// any commit is breaking (`!` suffix or a BREAKING CHANGE footer). Output: the
// expected bump. Precedence: major > minor > patch > none. This mirrors the
// documented table so a drift between the doc and the rule fails CI.
// ---------------------------------------------------------------------------
function expectedBump(types, { breaking = false } = {}) {
  if (breaking) return "major";
  if (types.includes("feat")) return "minor";
  if (types.some((t) => t === "fix" || t === "perf")) return "patch";
  return "none";
}

// ---------------------------------------------------------------------------
// 1. Frontmatter
// ---------------------------------------------------------------------------

test("release canonical SKILL.md has required frontmatter", async () => {
  const { frontmatter } = await loadCanonical();
  assertRequiredFields(frontmatter, ["name", "description"], "release SKILL.md");
  assert.equal(frontmatter.name, "release", "name must match the directory name");
  assert.ok(frontmatter.description.length > 0, "description must be non-empty");
});

test("release companion SKILL.claude-code.md is a Claude-only overlay", async () => {
  const { frontmatter } = await loadCompanion();
  assert.ok(!frontmatter.description, "companion must not duplicate canonical description");
  assert.match(
    frontmatter["allowed-tools"] ?? "",
    /AskUserQuestion/,
    "companion must allow AskUserQuestion (approval gate)",
  );
  assert.equal(
    frontmatter["disable-model-invocation"],
    "true",
    "skill must be user-invoked, not model-invoked",
  );
});

// ---------------------------------------------------------------------------
// 2. Detection + verification checklist + SemVer rule
// ---------------------------------------------------------------------------

test("release SKILL.md documents release-please detection", async () => {
  const { body } = await loadCanonical();
  assert.match(
    body,
    /gh pr list --author app\/release-please --state open/,
    "must document the release-please detection command",
  );
  // 0-hit path co-reports draft releases (health area 14).
  assert.match(body, /draft release/, "0-hit path must co-report draft releases");
  assert.match(
    body,
    /gh release list/,
    "must reference gh release list for the draft-release check",
  );
});

test("release SKILL.md documents the fixed verification checklist", async () => {
  const { body } = await loadCanonical();
  assert.match(body, /SemVer consistency/, "checklist must include SemVer consistency");
  assert.match(body, /CHANGELOG/, "checklist must include CHANGELOG consistency");
  assert.match(body, /CI/, "checklist must include CI state");
  assert.match(body, /gh pr checks/, "CI check must use gh pr checks");
});

test("release SKILL.md documents the deterministic SemVer rule (feat/fix/breaking)", async () => {
  const { body } = await loadCanonical();
  assert.match(body, /feat.*minor/, "must map feat → minor");
  assert.match(body, /fix.*patch/, "must map fix → patch");
  assert.match(body, /(`!`|BREAKING CHANGE).*major/s, "must map `!` / BREAKING CHANGE → major");
  // The rule is called out as fixture-able / deterministic.
  assert.match(body, /fixture/, "SemVer rule must be described as fixture-able");
});

// ---------------------------------------------------------------------------
// 3. Approval gate + --auto semantics
// ---------------------------------------------------------------------------

test("release SKILL.md retains the default approval gate via the central policy", async () => {
  const { body } = await loadCanonical();
  assert.match(body, /irreversible/, "merge must be classed as irreversible");
  assert.match(body, /policy-read\.mjs/, "must point at the policy read substrate");
  assert.match(body, /--action=merge/, "must name the policy action for merge");
  assert.match(body, /\bask\b/, "must document the zero-config ask gate");
  assert.match(body, /gh pr merge --squash/, "must document the squash-merge command");
});

test("release SKILL.md gates --auto on all verifications passing (fail → stop)", async () => {
  const { body } = await loadCanonical();
  assert.match(body, /--auto/, "must document the --auto flag");
  // The distinguishing rule vs deps: --auto skips the gate ONLY when every
  // verification passes; on any failure it still stops.
  assert.match(
    body,
    /only when all validations pass/,
    "--auto must skip the gate only when all verifications pass",
  );
  assert.match(
    body,
    /stops when validation fails|stops even with `?--auto`?/is,
    "on verification failure the skill must stop even with --auto",
  );
});

// ---------------------------------------------------------------------------
// 4. Publish monitoring + publish-less branch + Trusted Publishers
// ---------------------------------------------------------------------------

test("release SKILL.md documents publish polling interval + cap and npm reflection", async () => {
  const { body } = await loadCanonical();
  assert.match(body, /30-second|30s/, "must document the 30s polling interval");
  assert.match(body, /20-minute/, "must document the 20-minute polling cap");
  assert.match(body, /npm view/, "must confirm the npm-published version via npm view");
});

test("release SKILL.md documents the publish-workflow-less repo branch", async () => {
  const { body } = await loadCanonical();
  assert.match(
    body,
    /without a publish workflow|no npm publish workflow/,
    "must document the no-publish-workflow branch",
  );
  assert.match(body, /tag \/ (GitHub )?Release/, "publish-less branch completes on tag / Release");
});

test("release SKILL.md documents OIDC Trusted Publishers (no NPM_TOKEN) and failure guidance", async () => {
  const { body } = await loadCanonical();
  assert.match(body, /Trusted Publishers/, "must reference OIDC Trusted Publishers");
  assert.match(body, /NPM_TOKEN/, "must state NPM_TOKEN is not used");
  assert.match(body, /gh run view --log-failed/, "failure path must summarize via --log-failed");
  assert.match(body, /provenance/, "failure guidance must mention provenance");
  assert.match(body, /permissions/, "failure guidance must mention permissions");
});

// ---------------------------------------------------------------------------
// 5. Claude-Code-only behavior stays in the companion
// ---------------------------------------------------------------------------

test("release keeps AskUserQuestion in the companion, not the canonical body", async () => {
  const { body: canonicalBody } = await loadCanonical();
  const { body: companionBody } = await loadCompanion();
  assert.ok(
    !canonicalBody.includes("AskUserQuestion"),
    "canonical must stay CLI-neutral (AskUserQuestion belongs to the companion)",
  );
  assert.match(companionBody, /AskUserQuestion/, "companion must define the approval flow");
  assert.match(companionBody, /gate=`?ask`?/, "companion must gate the prompt on ask");
  assert.match(companionBody, /gate=`?proceed`?/, "companion must document the proceed branch");
  // Approval presents the verification summary.
  assert.match(
    companionBody,
    /validation result summary/,
    "companion must present the verification summary",
  );
});

// ---------------------------------------------------------------------------
// 6. SemVer-consistency rule over fixtures
// ---------------------------------------------------------------------------

test("SemVer-consistency rule maps commit types to the expected bump", () => {
  const cases = [
    { types: ["feat"], expect: "minor" },
    { types: ["fix"], expect: "patch" },
    { types: ["perf"], expect: "patch" },
    { types: ["feat", "fix"], expect: "minor" }, // feat dominates fix
    { types: ["fix", "perf"], expect: "patch" },
    { types: ["docs", "chore"], expect: "none" }, // no release-triggering type
    { types: ["refactor", "test", "style", "ci", "build"], expect: "none" },
    { types: [], expect: "none" },
  ];
  for (const { types, expect } of cases) {
    assert.equal(
      expectedBump(types),
      expect,
      `types=${JSON.stringify(types)} should bump ${expect}`,
    );
  }
});

test("SemVer-consistency rule treats `!` / BREAKING CHANGE as major (dominates all)", () => {
  // A breaking marker forces major regardless of the other types present.
  assert.equal(expectedBump(["feat"], { breaking: true }), "major", "feat! → major");
  assert.equal(expectedBump(["fix"], { breaking: true }), "major", "fix + BREAKING CHANGE → major");
  assert.equal(expectedBump(["chore"], { breaking: true }), "major", "breaking dominates chore");
  assert.equal(expectedBump([], { breaking: true }), "major", "breaking alone → major");
});

test("SemVer-consistency rule precedence is strict: major > minor > patch > none", () => {
  // Every combination collapses to the highest-precedence trigger present.
  assert.equal(expectedBump(["feat", "fix", "perf"], { breaking: true }), "major");
  assert.equal(expectedBump(["feat", "fix", "perf"]), "minor");
  assert.equal(expectedBump(["fix", "perf", "docs"]), "patch");
  assert.equal(expectedBump(["docs", "chore", "ci"]), "none");
});

// ---------------------------------------------------------------------------
// 7. Catalog entries (targeted complement to readme-catalog.test.mjs)
// ---------------------------------------------------------------------------

test("README.md, docs/README.ja.md, and CLAUDE.md carry a release entry", async () => {
  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  assert.match(readme, /\|\s*`release`\s*\|/, "README.md skill table must have a release row");

  const ja = await readFile(join(ROOT, "docs", "README.ja.md"), "utf8");
  assert.match(ja, /\|\s*`release`\s*\|/, "docs/README.ja.md skill table must have a release row");

  const claude = await readFile(join(ROOT, "CLAUDE.md"), "utf8");
  assert.match(claude, /^- `\/release` — /m, "CLAUDE.md must list /release under Available Skills");
});
