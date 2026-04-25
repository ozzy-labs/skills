import assert from "node:assert/strict";
import { test } from "node:test";
import { CopilotAdapter } from "../scripts/adapters/copilot.mjs";

const skill = (name, description) => ({
  name,
  description,
  frontmatter: { name, description },
  body: "",
  raw: "",
});

test("Copilot adapter emits a single snippet file", () => {
  const out = new CopilotAdapter().generate([skill("foo", "Foo")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].relativePath, ".github/copilot-instructions.md.snippet");
});

test("Copilot snippet contains markers, heading, and bullet list", () => {
  const out = new CopilotAdapter().generate([skill("foo", "Foo desc")]);
  const content = out[0].content;
  assert.match(content, /<!-- begin: @ozzylabs\/skills -->/);
  assert.match(content, /## Available Skills/);
  assert.match(content, /- `foo` — Foo desc/);
  assert.match(content, /<!-- end: @ozzylabs\/skills -->/);
});

test("Copilot adapter is deterministic — sorts skills by name", () => {
  const a = new CopilotAdapter().generate([skill("zeta", "z"), skill("alpha", "a")]);
  const b = new CopilotAdapter().generate([skill("alpha", "a"), skill("zeta", "z")]);
  assert.deepEqual(a, b);
  assert.match(a[0].content, /alpha[\s\S]*zeta/);
});

test("Copilot adapter has id 'copilot'", () => {
  assert.equal(CopilotAdapter.id, "copilot");
});
