// Tests for the ci-fix skill (issue #177).
//
// ci-fix is a PROSE-only skill (a thin wrapper): it resolves a failed CI run,
// runs one flaky-check rerun, extracts an error summary from the failed log, and
// hands a shaped instruction to `/drive`. There is no engine (.mjs) to unit
// test, so these are doc-content assertions on SKILL.md / the Claude Code
// companion, PLUS the security-relevant cross-file SYNC ASSERTION that the
// error-extraction regex stays byte-identical to health's same-error grouping
// (`.agents/skills/health/health-check.mjs` `extractCiErrorKey` / `stripAnsi`).
// Catalog rows (README / docs / CLAUDE.md) are enforced primarily by
// tests/readme-catalog.test.mjs; a light row assertion here documents the intent.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSkillDocument } from "../scripts/lib/frontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CI_FIX_DIR = join(ROOT, ".agents", "skills", "ci-fix");
const SKILL_MD = join(CI_FIX_DIR, "SKILL.md");
const SKILL_CLAUDE_MD = join(CI_FIX_DIR, "SKILL.claude-code.md");
const HEALTH_ENGINE = join(ROOT, ".agents", "skills", "health", "health-check.mjs");

// The two regexes ci-fix MUST reuse verbatim from health's same-error grouping.
// Byte-identical string tokens so drift on either side fails the sync assertion.
const ANSI_STRIP_REGEX = String.raw`/\[[0-9;]*m/g`;
const ERROR_LINE_REGEX = String.raw`/(error|Error|failed)[\s:].*$/`;

// ---------------------------------------------------------------------------
// 1. Structure + frontmatter
// ---------------------------------------------------------------------------

test("ci-fix skill directory ships SKILL.md and the Claude Code companion", () => {
  assert.ok(existsSync(CI_FIX_DIR), `expected ${CI_FIX_DIR} to exist`);
  assert.ok(existsSync(SKILL_MD), "SKILL.md must exist");
  assert.ok(existsSync(SKILL_CLAUDE_MD), "SKILL.claude-code.md must exist");
});

test("ci-fix SKILL.md has valid frontmatter (name + description), all-adapter (no gate)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  const { frontmatter } = parseSkillDocument(raw, ".agents/skills/ci-fix/SKILL.md");
  assert.equal(frontmatter.name, "ci-fix", "frontmatter name must equal directory name");
  assert.ok(frontmatter.description?.length > 0, "frontmatter description must be non-empty");
  assert.equal(frontmatter.adapters, undefined, "ci-fix is all-adapter (no `adapters` gate)");
});

test("ci-fix SKILL.claude-code.md is a Claude-only overlay (no duplicated description / name)", async () => {
  const raw = await readFile(SKILL_CLAUDE_MD, "utf8");
  const { frontmatter } = parseSkillDocument(raw, ".agents/skills/ci-fix/SKILL.claude-code.md");
  assert.ok(!frontmatter.description, "companion must not duplicate description");
  assert.equal(frontmatter.name, undefined, "companion must not redeclare 'name'");
  assert.equal(
    frontmatter["disable-model-invocation"],
    "true",
    "ci-fix companion must carry its Claude-only frontmatter",
  );
  assert.match(
    frontmatter["argument-hint"] ?? "",
    /--dry-run/,
    "companion argument-hint must advertise the flags",
  );
});

test("ci-fix is user-invocable (no user-invocable:false in either doc)", async () => {
  for (const f of [SKILL_MD, SKILL_CLAUDE_MD]) {
    const { frontmatter } = parseSkillDocument(await readFile(f, "utf8"), f);
    assert.notEqual(
      frontmatter["user-invocable"],
      "false",
      "ci-fix must remain user-invocable (surfaced as /ci-fix)",
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Doc-content assertions on SKILL.md
// ---------------------------------------------------------------------------

test("SKILL.md documents the FIXED input-resolution priority (run id > branch > current branch)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /Input resolution priority/i, "must have an input-resolution priority section");
  // The three-tier priority, in order, appears as a table.
  assert.match(raw, /Explicit run id/, "tier 1: explicit run id");
  assert.match(raw, /Explicit branch/, "tier 2: explicit branch");
  assert.match(raw, /Current branch/, "tier 3: current branch");
  assert.match(
    raw,
    /gh run list --branch <[^>]*> --status failure --limit 1/,
    "must show the gh run list resolution command",
  );
  assert.match(raw, /no failed run/i, "must define the no-failed-run termination");
});

test("SKILL.md flags main-branch failures as high priority at the top of the report", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /main branch failure/i, "must call out main-branch failures");
  assert.match(raw, /high priority/i, "must mark them high priority");
  assert.match(raw, /top of the report/i, "must place it at the top of the report");
});

test("SKILL.md documents the flaky flow: one rerun, 30s/15min polling, --no-rerun skip", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /flaky/i, "must have a flaky-check section");
  assert.match(raw, /gh run rerun <[^>]*> --failed/, "must use gh run rerun --failed");
  assert.match(raw, /only once/i, "must rerun exactly once");
  assert.match(raw, /30-second/i, "must poll at 30s interval");
  assert.match(raw, /15-minute/i, "must cap polling at 15 minutes");
  assert.match(raw, /--no-rerun/, "must document the --no-rerun skip");
  assert.match(raw, /要確認/, "polling cap must terminate as 要確認 (undecidable)");
});

test("SKILL.md documents log extraction via gh run view --log-failed", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /gh run view <[^>]*> --log-failed/, "must extract from --log-failed");
  assert.match(raw, /ANSI/, "must document ANSI stripping");
});

test("SKILL.md provides the drive instruction-text template and connects to /drive", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /instruction text/i, "must describe the instruction text");
  assert.match(raw, /CI failure on/, "must ship the instruction template");
  assert.match(raw, /\/drive/, "must connect to the /drive skill");
});

test("SKILL.md documents --dry-run as side-effect free (no rerun, no drive launch)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /--dry-run/, "must document --dry-run");
  assert.match(raw, /side effects/i, "must frame --dry-run around side effects");
  // Explicit: dry-run does NOT rerun and does NOT launch drive.
  assert.match(
    raw,
    /performs neither the rerun nor the drive launch/i,
    "must state --dry-run performs neither a rerun nor a drive launch",
  );
});

// ---------------------------------------------------------------------------
// 3. Cross-file SYNC ASSERTION: error regex == health same-error grouping
// ---------------------------------------------------------------------------

test("SKILL.md documents the error regex as IDENTICAL to health with a drift note", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /same-error/, "must name the health same-error judgement");
  assert.match(raw, /extractCiErrorKey/, "must point at the health SSOT function");
  assert.match(raw, /sync assertion|drift/i, "must reference the drift-preventing sync assertion");
});

test("error-extraction regex tokens are IDENTICAL in ci-fix SKILL.md and health-check.mjs (drift guard)", async () => {
  const skillMd = await readFile(SKILL_MD, "utf8");
  const healthSrc = readFileSync(HEALTH_ENGINE, "utf8");
  // If EITHER side changes its ANSI-strip or error-line regex, one of these
  // fails, forcing a conscious re-sync (issue #177: regex identical to health).
  for (const token of [ANSI_STRIP_REGEX, ERROR_LINE_REGEX]) {
    assert.ok(
      healthSrc.includes(token),
      `health-check.mjs must contain the regex token \`${token}\``,
    );
    assert.ok(
      skillMd.includes(token),
      `ci-fix SKILL.md must document the identical regex token \`${token}\``,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Companion wiring: AskUserQuestion confirm + /drive launch + --auto skip
// ---------------------------------------------------------------------------

test("companion wires AskUserQuestion confirm + /drive launch, skipped under --auto", async () => {
  const raw = await readFile(SKILL_CLAUDE_MD, "utf8");
  assert.match(raw, /AskUserQuestion/, "companion must keep the pre-launch confirm");
  assert.match(raw, /\/drive/, "companion must wire the /drive launch");
  assert.match(raw, /SlashCommand/, "companion must launch drive via SlashCommand");
  assert.match(raw, /--auto.*skip|skip.*--auto/i, "companion must skip the confirm under --auto");
  assert.match(
    raw,
    /--dry-run.*neither the rerun nor the drive launch is performed/i,
    "companion must state --dry-run launches nothing",
  );
});

// ---------------------------------------------------------------------------
// 5. Catalog rows (primary enforcer: tests/readme-catalog.test.mjs)
// ---------------------------------------------------------------------------

test("README.md, docs/README.ja.md, and CLAUDE.md carry a ci-fix entry", async () => {
  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  assert.match(readme, /^\| `ci-fix` \|/m, "README.md skill table must have a ci-fix row");

  const ja = await readFile(join(ROOT, "docs", "README.ja.md"), "utf8");
  assert.match(ja, /^\| `ci-fix` \|/m, "docs/README.ja.md skill table must have a ci-fix row");

  const claudeMd = await readFile(join(ROOT, "CLAUDE.md"), "utf8");
  assert.match(claudeMd, /^- `\/ci-fix` — /m, "CLAUDE.md must have a /ci-fix bullet");
});
