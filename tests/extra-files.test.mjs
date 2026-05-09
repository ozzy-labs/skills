// Verify that non-SKILL.* extra files shipped under a skill directory
// (e.g. `perspectives/<axis>.md` for the review skill — ADR-0025) are
// emitted by adapters that produce per-skill directories.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeCodeAdapter } from "../scripts/adapters/claude-code.mjs";
import { CodexCliAdapter } from "../scripts/adapters/codex-cli.mjs";

function skill(name, frontmatter, body = "body\n", extraFiles = []) {
  const fm = { name, ...frontmatter };
  const fmText = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const raw = `---\n${fmText}\n---\n${body}`;
  return { name, description: fm.description, frontmatter: fm, body, raw, extraFiles };
}

test("Claude Code adapter emits extra files under .claude/skills/<name>/", async () => {
  const s = skill("review", { description: "d" }, "body\n", [
    { relativePath: "perspectives/security.md", content: "## security\n" },
    { relativePath: "perspectives/correctness.md", content: "## correctness\n" },
  ]);
  const out = await new ClaudeCodeAdapter().generate([s]);
  const sec = out.find((o) => o.relativePath === ".claude/skills/review/perspectives/security.md");
  const cor = out.find(
    (o) => o.relativePath === ".claude/skills/review/perspectives/correctness.md",
  );
  assert.equal(sec.content, "## security\n");
  assert.equal(cor.content, "## correctness\n");
});

test("Codex CLI adapter emits extra files under .agents/skills/<name>/", async () => {
  const s = skill("review", { description: "d" }, "body\n", [
    { relativePath: "perspectives/security.md", content: "## security\n" },
  ]);
  const out = await new CodexCliAdapter().generate([s]);
  const sec = out.find((o) => o.relativePath === ".agents/skills/review/perspectives/security.md");
  assert.ok(sec, "expected .agents/skills/review/perspectives/security.md to be emitted");
  assert.equal(sec.content, "## security\n");
});

test("adapters with no extra files emit only SKILL.md per skill (regression)", async () => {
  const s = skill("foo", { description: "d" });
  const claudeOut = await new ClaudeCodeAdapter().generate([s]);
  const codexOut = await new CodexCliAdapter().generate([s]);
  const claudeSkillFiles = claudeOut.filter((o) =>
    o.relativePath.startsWith(".claude/skills/foo/"),
  );
  const codexSkillFiles = codexOut.filter((o) => o.relativePath.startsWith(".agents/skills/foo/"));
  assert.deepEqual(
    claudeSkillFiles.map((o) => o.relativePath),
    [".claude/skills/foo/SKILL.md"],
  );
  assert.deepEqual(
    codexSkillFiles.map((o) => o.relativePath),
    [".agents/skills/foo/SKILL.md"],
  );
});
