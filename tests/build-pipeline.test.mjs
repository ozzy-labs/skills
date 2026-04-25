// Integration tests for the adapter pipeline.
//
// These run all four adapters against the canonical skill list loaded from
// src/skills/ and assert end-to-end invariants: deterministic output, every
// adapter wires up, and required snippet markers are present.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter } from "../scripts/adapters/claude-code.mjs";
import { CodexCliAdapter } from "../scripts/adapters/codex-cli.mjs";
import { CopilotAdapter } from "../scripts/adapters/copilot.mjs";
import { GeminiCliAdapter } from "../scripts/adapters/gemini-cli.mjs";
import { assertRequiredFields, parseSkillDocument } from "../scripts/lib/frontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src", "skills");

async function loadCompanion(name, suffix, requiredFields) {
  const file = join(SRC, name, `SKILL.${suffix}.md`);
  if (!existsSync(file)) return null;
  const raw = await readFile(file, "utf8");
  const label = `src/skills/${name}/SKILL.${suffix}.md`;
  const { frontmatter, body } = parseSkillDocument(raw, label);
  assertRequiredFields(frontmatter, requiredFields, label);
  return { frontmatter, body, raw };
}

async function loadCanonicalSkills() {
  const entries = await readdir(SRC, { withFileTypes: true });
  const names = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const skills = [];
  for (const name of names) {
    const srcFile = join(SRC, name, "SKILL.md");
    const raw = await readFile(srcFile, "utf8");
    const label = `src/skills/${name}/SKILL.md`;
    const { frontmatter, body } = parseSkillDocument(raw, label);
    assertRequiredFields(frontmatter, ["name", "description"], label);
    const claudeCodeCompanion = await loadCompanion(name, "claude-code", ["description"]);
    skills.push({
      name,
      description: frontmatter.description,
      frontmatter,
      body,
      raw,
      claudeCodeCompanion,
    });
  }
  return skills;
}

const ADAPTERS = [
  new ClaudeCodeAdapter(),
  new CodexCliAdapter(),
  new GeminiCliAdapter(),
  new CopilotAdapter(),
];

test("every adapter produces non-empty output for canonical skills", async () => {
  const skills = await loadCanonicalSkills();
  assert.ok(skills.length > 0, "src/skills/ must contain at least one skill");
  for (const adapter of ADAPTERS) {
    const out = adapter.generate(skills);
    assert.ok(out.length > 0, `${adapter.constructor.name} returned no outputs`);
    for (const file of out) {
      assert.ok(file.relativePath, "OutputFile.relativePath must be set");
      assert.equal(typeof file.content, "string");
    }
  }
});

test("adapter outputs are deterministic across repeated runs", async () => {
  const skills = await loadCanonicalSkills();
  for (const adapter of ADAPTERS) {
    const a = adapter.generate(skills);
    const b = adapter.generate(skills);
    assert.deepEqual(a, b, `${adapter.constructor.name} is non-deterministic`);
  }
});

test("adapter outputs are deterministic regardless of input order", async () => {
  const skills = await loadCanonicalSkills();
  const reversed = [...skills].reverse();
  for (const adapter of ADAPTERS) {
    const a = adapter.generate(skills);
    const b = adapter.generate(reversed);
    assert.deepEqual(
      a,
      b,
      `${adapter.constructor.name} produces different output for reordered input`,
    );
  }
});

test("Codex CLI and Gemini CLI emit identical AGENTS.md.snippet", async () => {
  const skills = await loadCanonicalSkills();
  const codex = new CodexCliAdapter()
    .generate(skills)
    .find((o) => o.relativePath === "AGENTS.md.snippet").content;
  const gemini = new GeminiCliAdapter()
    .generate(skills)
    .find((o) => o.relativePath === "AGENTS.md.snippet").content;
  assert.equal(codex, gemini);
});

test("every snippet output is wrapped with @ozzylabs/skills markers", async () => {
  const skills = await loadCanonicalSkills();
  for (const adapter of ADAPTERS) {
    for (const file of adapter.generate(skills)) {
      if (!file.relativePath.endsWith(".snippet")) continue;
      assert.match(
        file.content,
        /<!-- begin: @ozzylabs\/skills -->/,
        `${file.relativePath} missing begin marker`,
      );
      assert.match(
        file.content,
        /<!-- end: @ozzylabs\/skills -->/,
        `${file.relativePath} missing end marker`,
      );
    }
  }
});

test("Claude Code adapter prefers SKILL.claude-code.md when present", async () => {
  const skills = await loadCanonicalSkills();
  const withCompanion = skills.filter((s) => s.claudeCodeCompanion);
  assert.ok(
    withCompanion.length > 0,
    "expected at least one skill to ship a Claude Code companion",
  );
  const out = new ClaudeCodeAdapter().generate(skills);
  for (const skill of withCompanion) {
    const file = out.find((o) => o.relativePath === `.claude/skills/${skill.name}/SKILL.md`);
    assert.equal(
      file.content,
      skill.claudeCodeCompanion.raw,
      `${skill.name}: adapter must emit companion content verbatim`,
    );
  }
});

test("Claude Code adapter and other adapters diverge for skills with companion", async () => {
  const skills = await loadCanonicalSkills();
  const sample = skills.find((s) => s.claudeCodeCompanion);
  if (!sample) return; // no companion in repo — nothing to assert
  const claudeOut = new ClaudeCodeAdapter()
    .generate([sample])
    .find((o) => o.relativePath.endsWith("/SKILL.md"));
  const codexOut = new CodexCliAdapter()
    .generate([sample])
    .find((o) => o.relativePath.endsWith("/SKILL.md"));
  assert.notEqual(
    claudeOut.content,
    codexOut.content,
    "Claude Code companion must not leak into Codex CLI output",
  );
});
