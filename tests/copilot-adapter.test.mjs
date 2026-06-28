import assert from "node:assert/strict";
import { test } from "node:test";
import { CopilotAdapter } from "../scripts/adapters/copilot.mjs";

const skill = (name, description) => ({
  name,
  description,
  frontmatter: { name, description },
  body: "",
  raw: `---\nname: ${name}\ndescription: ${description}\n---\n`,
  extraFiles: [],
});

test("Copilot adapter ships the .agents/skills tree + an instructions snippet", async () => {
  const out = await new CopilotAdapter().generate([skill("foo", "Foo")]);
  const skillFile = out.find((o) => o.relativePath === ".agents/skills/foo/SKILL.md");
  const snippet = out.find((o) => o.relativePath === ".github/copilot-instructions.md.snippet");
  assert.ok(skillFile, "Copilot must ship the canonical .agents/skills/ SKILL.md");
  assert.ok(snippet, "Copilot must ship the instructions snippet");
});

test("Copilot snippet contains markers, heading, and bullet list", async () => {
  const out = await new CopilotAdapter().generate([skill("foo", "Foo desc")]);
  const content = out.find((o) => o.relativePath.endsWith(".snippet")).content;
  assert.match(content, /<!-- begin: @ozzylabs\/skills -->/);
  assert.match(content, /## Available Skills/);
  assert.match(content, /- `foo` — Foo desc/);
  assert.match(content, /<!-- end: @ozzylabs\/skills -->/);
});

test("Copilot adapter is deterministic — sorts skills by name", async () => {
  const a = await new CopilotAdapter().generate([skill("zeta", "z"), skill("alpha", "a")]);
  const b = await new CopilotAdapter().generate([skill("alpha", "a"), skill("zeta", "z")]);
  assert.deepEqual(a, b);
  const snippet = a.find((o) => o.relativePath.endsWith(".snippet")).content;
  assert.match(snippet, /alpha[\s\S]*zeta/);
});

test("Copilot adapter has id 'copilot'", () => {
  assert.equal(CopilotAdapter.id, "copilot");
});
