// Structural tests for the phase-issue skill.
//
// phase-issue is a documentation-driven skill (not a runnable script): the
// canonical SKILL.md is read and executed by an agent. These tests therefore
// assert on the document's *structure* — the contract Issue #62 pins down —
// rather than on a runtime. They cover non-interactive behavior:
//   1. canonical frontmatter is well-formed and adapter-eligible
//   2. the hardcoded section skeleton is present and ordered
//   3. CLI argument surface and `--draft` mode are documented
//   4. Claude-Code-only behaviors stay in the companion (AskUserQuestion is
//      *not* present in canonical SKILL.md, only in the companion)
//   5. explicit out-of-scope items remain documented (no drive coupling, no
//      auto-numbering, no style learning)
//
// If the skill ever grows a runnable adapter, replace these with
// behavioural tests; until then, structural assertions are what protect us
// from silent contract drift.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter } from "../scripts/adapters/claude-code.mjs";
import { CodexCliAdapter } from "../scripts/adapters/codex-cli.mjs";
import { GeminiCliAdapter } from "../scripts/adapters/gemini-cli.mjs";
import { assertRequiredFields, parseSkillDocument } from "../scripts/lib/frontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_DIR = join(ROOT, ".agents", "skills", "phase-issue");
const CANONICAL = join(SKILL_DIR, "SKILL.md");
const COMPANION = join(SKILL_DIR, "SKILL.claude-code.md");

async function loadCanonical() {
  const raw = await readFile(CANONICAL, "utf8");
  const { frontmatter, body } = parseSkillDocument(raw, ".agents/skills/phase-issue/SKILL.md");
  return { frontmatter, body, raw };
}

async function loadCompanion() {
  const raw = await readFile(COMPANION, "utf8");
  const { frontmatter, body } = parseSkillDocument(
    raw,
    ".agents/skills/phase-issue/SKILL.claude-code.md",
  );
  return { frontmatter, body, raw };
}

test("phase-issue canonical SKILL.md has required frontmatter", async () => {
  const { frontmatter } = await loadCanonical();
  assertRequiredFields(frontmatter, ["name", "description"], "phase-issue SKILL.md");
  assert.equal(frontmatter.name, "phase-issue", "name must be phase-issue (not 'epic')");
  assert.ok(
    frontmatter.description.length > 0,
    "description must be non-empty for adapter validation",
  );
});

test("phase-issue companion SKILL.claude-code.md has required frontmatter", async () => {
  const { frontmatter } = await loadCompanion();
  // Overlay companions carry only Claude-only keys; `description` is injected
  // from the canonical SKILL.md at build time, so it must NOT be duplicated here.
  assert.ok(!frontmatter.description, "companion must not duplicate canonical description");
  // Companion frontmatter must declare AskUserQuestion in allowed-tools so
  // the interactive flow can run.
  assert.match(
    frontmatter["allowed-tools"] ?? "",
    /AskUserQuestion/,
    "companion must allow AskUserQuestion (interactive flow)",
  );
  assert.equal(
    frontmatter["disable-model-invocation"],
    "true",
    "skill must be user-invoked, not model-invoked",
  );
});

test("phase-issue canonical SKILL.md hardcodes the section skeleton in order", async () => {
  const { body } = await loadCanonical();

  // The Issue #62 acceptance criteria pin the section list. Order matters:
  // it is the contract for cross-session handoff. We grep for the literal
  // section headings used in the section-by-section formatting rules so
  // accidental rename / removal trips the test.
  const expectedSections = [
    "Cross-session handoff",
    "決定事項",
    "タスク（PR ごと）",
    "Definition of Done",
    "Phase {{N+1}} outlook",
    "関連",
  ];

  let cursor = 0;
  for (const heading of expectedSections) {
    const idx = body.indexOf(heading, cursor);
    assert.notEqual(idx, -1, `section heading missing or out of order: "${heading}"`);
    cursor = idx + heading.length;
  }
});

test("phase-issue canonical SKILL.md documents the CLI argument surface", async () => {
  const { body } = await loadCanonical();

  // Required positional args.
  assert.match(body, /<phase-number>/, "phase-number positional arg must be documented");
  assert.match(body, /<title>/, "title positional arg must be documented");

  // Optional flags from acceptance criteria.
  const requiredFlags = [
    "--description",
    "--refs",
    "--donts",
    "--decisions-file",
    "--tasks-file",
    "--dod",
    "--outlook",
    "--related",
    "--label",
    "--repo",
    "--draft",
  ];
  for (const flag of requiredFlags) {
    assert.match(body, new RegExp(flag.replace(/-/g, "\\-")), `flag ${flag} must be documented`);
  }
});

test("phase-issue --draft mode is documented as stdout-only with no side effects", async () => {
  const { body } = await loadCanonical();
  assert.match(body, /--draft/, "--draft must be documented");
  assert.match(
    body,
    /stdout/,
    "--draft must be documented as stdout output (acceptance criterion 4)",
  );
  assert.match(
    body,
    /外部副作用なし|gh.*呼び出さない|gh.*呼び出しもない/,
    "--draft mode must explicitly state no gh side effects",
  );
});

test("phase-issue canonical body marks non-interactive behavior", async () => {
  const { body } = await loadCanonical();
  // Acceptance criterion 1: canonical SKILL.md is non-interactive.
  // AskUserQuestion belongs in the companion, not here.
  assert.doesNotMatch(
    body,
    /AskUserQuestion/,
    "canonical SKILL.md must NOT reference AskUserQuestion (acceptance criterion 1: non-interactive)",
  );
  assert.match(
    body,
    /非対話/,
    "canonical SKILL.md must explicitly document its non-interactive contract",
  );
});

test("phase-issue companion delegates to AskUserQuestion for interactive collection", async () => {
  const { body } = await loadCompanion();
  // Acceptance criterion 2: Claude Code companion uses AskUserQuestion.
  assert.match(
    body,
    /AskUserQuestion/,
    "companion must use AskUserQuestion for interactive input collection",
  );
});

test("phase-issue documents explicit out-of-scope items from Issue #62", async () => {
  const { body } = await loadCanonical();
  // Issue #62 explicitly excludes drive coupling, auto-numbering, and style
  // learning. These must remain documented as out-of-scope so future edits
  // can't silently expand the contract.
  assert.match(body, /drive\s*連携/, "out-of-scope: drive coupling must be documented");
  assert.match(body, /自動採番/, "out-of-scope: phase number auto-numbering must be documented");
  assert.match(
    body,
    /style\s*学習|過去\s*issue/,
    "out-of-scope: style learning must be documented",
  );
});

test("phase-issue body embeds a versioned marker block for future regeneration", async () => {
  const { body } = await loadCanonical();
  // The issue body emits a `<!-- phase-issue:v1 phase=N -->` anchor so
  // a future re-run can find and update the same issue. This contract
  // must stay documented.
  assert.match(
    body,
    /<!--\s*phase-issue:v\d+/,
    "marker block (phase-issue:vN) must be documented for re-generation anchor",
  );
});

test("phase-issue is wired into all four adapter outputs (build pipeline integration)", async () => {
  const { frontmatter, body, raw } = await loadCanonical();
  const companion = await loadCompanion();

  const skill = {
    name: "phase-issue",
    description: frontmatter.description,
    frontmatter,
    body,
    raw,
    claudeCodeCompanion: companion,
  };

  const claude = await new ClaudeCodeAdapter().generate([skill]);
  assert.ok(
    claude.find((o) => o.relativePath === ".claude/skills/phase-issue/SKILL.md"),
    "Claude Code adapter must emit phase-issue",
  );

  // Codex CLI and Gemini CLI both ship a shared `AGENTS.md.snippet` listing
  // every skill by name. The skill must appear in that snippet so consumers
  // see it in their AGENTS.md.
  const codex = await new CodexCliAdapter().generate([skill]);
  const codexSnippet = codex.find((o) => o.relativePath === "AGENTS.md.snippet");
  assert.ok(codexSnippet, "Codex CLI adapter must emit AGENTS.md.snippet");
  assert.match(codexSnippet.content, /phase-issue/, "Codex CLI snippet must list phase-issue");

  const gemini = await new GeminiCliAdapter().generate([skill]);
  const geminiSnippet = gemini.find((o) => o.relativePath === "AGENTS.md.snippet");
  assert.ok(geminiSnippet, "Gemini CLI adapter must emit AGENTS.md.snippet");
  assert.match(geminiSnippet.content, /phase-issue/, "Gemini CLI snippet must list phase-issue");
});
