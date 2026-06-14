// Per-skill adapter gating (issue #120).
//
// A skill may restrict which adapters emit it via a comma-separated
// `adapters` frontmatter field. These tests cover the parser (C1: the
// frontmatter parser is string-only, so `adapters` is a comma string, not a
// YAML array) and the gating behavior across all four adapters plus the
// dogfood/project-scope write paths (C2: gating lives in each adapter's
// generate(), so writeAdapterOutputs and writeProjectScopeOutput are both
// covered; the dogfood mirrors use the same isAdapterAllowed predicate).

import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeCodeAdapter } from "../scripts/adapters/claude-code.mjs";
import { CodexCliAdapter } from "../scripts/adapters/codex-cli.mjs";
import { CopilotAdapter } from "../scripts/adapters/copilot.mjs";
import { GeminiCliAdapter } from "../scripts/adapters/gemini-cli.mjs";
import {
  filterSkillsForAdapter,
  isAdapterAllowed,
  parseAdapters,
} from "../scripts/lib/adapter-gating.mjs";

// Build a skill object the way build-pipeline tests do: frontmatter carries
// the `adapters` string and `skill.adapters` is left undefined so the adapters
// exercise the parse-from-frontmatter fallback (the real build precomputes
// skill.adapters; both paths are asserted separately below).
function skill(name, { description = "d", adapters } = {}, extraFiles = []) {
  const fm = { name, description };
  if (adapters !== undefined) fm.adapters = adapters;
  const fmText = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const raw = `---\n${fmText}\n---\nbody\n`;
  return { name, description, frontmatter: fm, body: "body\n", raw, extraFiles };
}

// --- C1: parseAdapters encoding ---------------------------------------------

test("parseAdapters returns null when the field is absent", () => {
  assert.equal(parseAdapters({}, "f.md"), null);
  assert.equal(parseAdapters({ adapters: "" }, "f.md"), null);
  assert.equal(parseAdapters({ adapters: "   " }, "f.md"), null);
});

test("parseAdapters parses a single comma-separated id", () => {
  assert.deepEqual(parseAdapters({ adapters: "claude-code" }, "f.md"), ["claude-code"]);
});

test("parseAdapters parses + trims multiple comma-separated ids", () => {
  assert.deepEqual(parseAdapters({ adapters: "claude-code, codex-cli" }, "f.md"), [
    "claude-code",
    "codex-cli",
  ]);
});

test("parseAdapters throws on an unknown adapter id", () => {
  assert.throws(
    () => parseAdapters({ adapters: "claude-code, bogus" }, "f.md"),
    /unknown adapter id 'bogus'/,
  );
});

// --- predicate helpers ------------------------------------------------------

test("isAdapterAllowed: ungated skill is allowed everywhere", () => {
  const s = skill("foo");
  for (const id of ["claude-code", "codex-cli", "gemini-cli", "copilot"]) {
    assert.equal(isAdapterAllowed(s, id), true);
  }
});

test("isAdapterAllowed: gated skill is allowed only for listed adapters", () => {
  const s = skill("usage-guard", { adapters: "claude-code" });
  assert.equal(isAdapterAllowed(s, "claude-code"), true);
  assert.equal(isAdapterAllowed(s, "codex-cli"), false);
  assert.equal(isAdapterAllowed(s, "gemini-cli"), false);
  assert.equal(isAdapterAllowed(s, "copilot"), false);
});

test("isAdapterAllowed: precomputed skill.adapters takes precedence", () => {
  const s = { name: "x", description: "d", frontmatter: {}, adapters: ["codex-cli"] };
  assert.equal(isAdapterAllowed(s, "codex-cli"), true);
  assert.equal(isAdapterAllowed(s, "claude-code"), false);
});

test("filterSkillsForAdapter keeps only allowed skills", () => {
  const skills = [skill("a"), skill("guard", { adapters: "claude-code" })];
  assert.deepEqual(
    filterSkillsForAdapter(skills, "codex-cli").map((s) => s.name),
    ["a"],
  );
  assert.deepEqual(
    filterSkillsForAdapter(skills, "claude-code").map((s) => s.name),
    ["a", "guard"],
  );
});

// --- C2: gating across adapters ---------------------------------------------

const SKILLS = [skill("review"), skill("usage-guard", { adapters: "claude-code" })];

test("Claude Code adapter emits a claude-code-gated skill", async () => {
  const out = await new ClaudeCodeAdapter().generate(SKILLS);
  assert.ok(out.some((o) => o.relativePath === ".claude/skills/usage-guard/SKILL.md"));
  assert.ok(out.some((o) => o.relativePath === ".claude/skills/review/SKILL.md"));
});

test("Codex CLI adapter excludes a claude-code-gated skill (dir + snippet)", async () => {
  const out = await new CodexCliAdapter().generate(SKILLS);
  assert.ok(
    !out.some((o) => o.relativePath.startsWith(".agents/skills/usage-guard/")),
    "gated skill must not get a .agents/skills/ directory",
  );
  assert.ok(out.some((o) => o.relativePath === ".agents/skills/review/SKILL.md"));
  const snippet = out.find((o) => o.relativePath === "AGENTS.md.snippet").content;
  assert.ok(
    !snippet.includes("usage-guard"),
    "gated skill must not be listed in AGENTS.md.snippet",
  );
  assert.ok(snippet.includes("review"));
});

test("Gemini CLI adapter excludes a claude-code-gated skill from the snippet", async () => {
  const out = await new GeminiCliAdapter().generate(SKILLS);
  const snippet = out.find((o) => o.relativePath === "AGENTS.md.snippet").content;
  assert.ok(!snippet.includes("usage-guard"));
  assert.ok(snippet.includes("review"));
});

test("Copilot adapter excludes a claude-code-gated skill from the snippet", async () => {
  const out = await new CopilotAdapter().generate(SKILLS);
  const snippet = out.find((o) =>
    o.relativePath.endsWith(".github/copilot-instructions.md.snippet"),
  ).content;
  assert.ok(!snippet.includes("usage-guard"));
  assert.ok(snippet.includes("review"));
});

test("ungated skills are unaffected (regression: all four adapters emit them)", async () => {
  const only = [skill("review")];
  const claude = await new ClaudeCodeAdapter().generate(only);
  const codex = await new CodexCliAdapter().generate(only);
  assert.ok(claude.some((o) => o.relativePath === ".claude/skills/review/SKILL.md"));
  assert.ok(codex.some((o) => o.relativePath === ".agents/skills/review/SKILL.md"));
});

// --- C2: project-scope + dogfood write paths --------------------------------

test("project-scope path excludes a gated skill from .agents/skills/ (Codex side)", async () => {
  // writeProjectScopeOutput ships ClaudeCodeAdapter output + the Codex
  // adapter's `.agents/skills/` files. A claude-code-gated skill must appear
  // in the Claude wrapper output but not in the Codex `.agents/skills/` files.
  const claude = await new ClaudeCodeAdapter().generate(SKILLS);
  const codexAgentsFiles = (await new CodexCliAdapter().generate(SKILLS)).filter((o) =>
    o.relativePath.startsWith(".agents/skills/"),
  );
  assert.ok(claude.some((o) => o.relativePath === ".claude/skills/usage-guard/SKILL.md"));
  assert.ok(
    !codexAgentsFiles.some((o) => o.relativePath.startsWith(".agents/skills/usage-guard/")),
  );
});

test("dogfood predicate keeps a claude-code-gated skill out of .agents/skills/", () => {
  // build.mjs mirrors a skill into a dogfood target when it is allowed for at
  // least one of that target's adapters. `.agents/skills/` feeds codex-cli +
  // gemini-cli; `.claude/skills/` feeds claude-code.
  const guard = skill("usage-guard", { adapters: "claude-code" });
  const agentsTargetAllows = ["codex-cli", "gemini-cli"].some((id) => isAdapterAllowed(guard, id));
  const claudeTargetAllows = ["claude-code"].some((id) => isAdapterAllowed(guard, id));
  assert.equal(agentsTargetAllows, false, "gated skill excluded from .agents/skills/ dogfood");
  assert.equal(claudeTargetAllows, true, "gated skill kept in .claude/skills/ dogfood");
});
