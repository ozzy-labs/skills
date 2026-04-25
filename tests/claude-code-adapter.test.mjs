import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeCodeAdapter } from "../scripts/adapters/claude-code.mjs";

function skill(name, frontmatter, body = "body\n") {
  const fm = { name, ...frontmatter };
  const fmText = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const raw = `---\n${fmText}\n---\n${body}`;
  return { name, description: fm.description, frontmatter: fm, body, raw };
}

test("Claude Code adapter emits .claude/skills/{name}/SKILL.md", () => {
  const out = new ClaudeCodeAdapter().generate([skill("foo", { description: "d" })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].relativePath, ".claude/skills/foo/SKILL.md");
  assert.match(out[0].content, /^---\nname: foo\ndescription: d\n---\nbody\n$/);
});

test("Claude Code adapter is deterministic — sorts by name", () => {
  const out = new ClaudeCodeAdapter().generate([
    skill("zeta", { description: "z" }),
    skill("alpha", { description: "a" }),
  ]);
  assert.deepEqual(
    out.map((o) => o.relativePath),
    [".claude/skills/alpha/SKILL.md", ".claude/skills/zeta/SKILL.md"],
  );
});

test("Claude Code adapter passes through Claude-specific frontmatter", () => {
  const s = skill("foo", {
    description: "d",
    "allowed-tools": "Bash,Read",
    "argument-hint": "<file>",
  });
  const out = new ClaudeCodeAdapter().generate([s]);
  assert.match(out[0].content, /allowed-tools: Bash,Read/);
  assert.match(out[0].content, /argument-hint: <file>/);
});

test("Claude Code adapter throws when description is missing", () => {
  const bad = {
    name: "foo",
    description: "",
    frontmatter: { name: "foo" },
    body: "",
    raw: "---\nname: foo\n---\n",
  };
  assert.throws(
    () => new ClaudeCodeAdapter().generate([bad]),
    /missing required field 'description'/,
  );
});

test("Claude Code adapter has id 'claude-code'", () => {
  assert.equal(ClaudeCodeAdapter.id, "claude-code");
});
