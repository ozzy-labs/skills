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

test("Claude Code adapter emits .claude/skills/{name}/SKILL.md", async () => {
  const out = await new ClaudeCodeAdapter().generate([skill("foo", { description: "d" })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].relativePath, ".claude/skills/foo/SKILL.md");
  assert.match(out[0].content, /^---\nname: foo\ndescription: d\n---\nbody\n$/);
});

test("Claude Code adapter is deterministic — sorts by name", async () => {
  const out = await new ClaudeCodeAdapter().generate([
    skill("zeta", { description: "z" }),
    skill("alpha", { description: "a" }),
  ]);
  assert.deepEqual(
    out.map((o) => o.relativePath),
    [".claude/skills/alpha/SKILL.md", ".claude/skills/zeta/SKILL.md"],
  );
});

test("Claude Code adapter passes through Claude-specific frontmatter", async () => {
  const s = skill("foo", {
    description: "d",
    "allowed-tools": "Bash,Read",
    "argument-hint": "<file>",
  });
  const out = await new ClaudeCodeAdapter().generate([s]);
  assert.match(out[0].content, /allowed-tools: Bash,Read/);
  assert.match(out[0].content, /argument-hint: <file>/);
});

test("Claude Code adapter throws when description is missing", async () => {
  const bad = {
    name: "foo",
    description: "",
    frontmatter: { name: "foo" },
    body: "",
    raw: "---\nname: foo\n---\n",
  };
  await assert.rejects(
    () => new ClaudeCodeAdapter().generate([bad]),
    /missing required field 'description'/,
  );
});

test("Claude Code adapter has id 'claude-code'", () => {
  assert.equal(ClaudeCodeAdapter.id, "claude-code");
});

test("Claude Code adapter overlays canonical description + companion frontmatter/body", async () => {
  const s = skill("foo", { description: "canonical" });
  s.claudeCodeCompanion = {
    frontmatter: { "disable-model-invocation": "true" },
    body: "# foo\n\nwrapper body\n",
    raw: "---\ndisable-model-invocation: true\n---\n# foo\n\nwrapper body\n",
  };
  const out = await new ClaudeCodeAdapter().generate([s]);
  // Canonical description is injected first, then the companion's Claude-only
  // keys, then the companion body verbatim. No `name:` key leaks in.
  assert.equal(
    out[0].content,
    "---\ndescription: canonical\ndisable-model-invocation: true\n---\n# foo\n\nwrapper body\n",
  );
  assert.doesNotMatch(out[0].content, /^name: foo/m);
});

test("Claude Code adapter falls back to canonical when no companion", async () => {
  const s = skill("foo", { description: "canonical" });
  s.claudeCodeCompanion = null;
  const out = await new ClaudeCodeAdapter().generate([s]);
  assert.equal(out[0].content, s.raw);
});

test("Claude Code adapter drops a stray companion description in favour of canonical", async () => {
  // A companion no longer needs (or should carry) a description — the canonical
  // one is the single source. A leftover copy is ignored, never duplicated.
  const s = skill("foo", { description: "canonical" });
  s.claudeCodeCompanion = {
    frontmatter: { description: "stale wrapper copy", "disable-model-invocation": "true" },
    body: "x\n",
    raw: "---\ndescription: stale wrapper copy\ndisable-model-invocation: true\n---\nx\n",
  };
  const out = await new ClaudeCodeAdapter().generate([s]);
  assert.match(out[0].content, /description: canonical/);
  assert.doesNotMatch(out[0].content, /stale wrapper copy/);
});
