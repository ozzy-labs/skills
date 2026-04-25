import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexCliAdapter } from "../scripts/adapters/codex-cli.mjs";

function skill(name, description, body = "body\n") {
  const fm = { name, description };
  const raw = `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
  return { name, description, frontmatter: fm, body, raw };
}

test("Codex CLI adapter emits per-skill SKILL.md plus AGENTS.md.snippet", () => {
  const out = new CodexCliAdapter().generate([
    skill("foo", "Foo description"),
    skill("bar", "Bar description"),
  ]);
  const paths = out.map((o) => o.relativePath);
  assert.deepEqual(paths, [
    ".agents/skills/bar/SKILL.md",
    ".agents/skills/foo/SKILL.md",
    "AGENTS.md.snippet",
  ]);
});

test("Codex CLI snippet contains begin/end markers and skill bullets", () => {
  const out = new CodexCliAdapter().generate([skill("foo", "Foo description")]);
  const snippet = out.find((o) => o.relativePath === "AGENTS.md.snippet").content;
  assert.match(snippet, /<!-- begin: @ozzylabs\/skills -->/);
  assert.match(snippet, /<!-- end: @ozzylabs\/skills -->/);
  assert.match(snippet, /- `foo` — Foo description/);
});

test("Codex CLI adapter is deterministic — sorts skills by name", () => {
  const a = new CodexCliAdapter().generate([skill("zeta", "z"), skill("alpha", "a")]);
  const b = new CodexCliAdapter().generate([skill("alpha", "a"), skill("zeta", "z")]);
  assert.deepEqual(a, b);
});

test("Codex CLI adapter has id 'codex-cli'", () => {
  assert.equal(CodexCliAdapter.id, "codex-cli");
});
