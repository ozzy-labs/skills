import assert from "node:assert/strict";
import { test } from "node:test";
import { GeminiCliAdapter } from "../scripts/adapters/gemini-cli.mjs";

const skill = (name, description) => ({
  name,
  description,
  frontmatter: { name, description },
  body: "",
  raw: `---\nname: ${name}\ndescription: ${description}\n---\n`,
});

test("Gemini CLI adapter emits settings.json + AGENTS.md.snippet", () => {
  const out = new GeminiCliAdapter().generate([skill("foo", "Foo")]);
  assert.deepEqual(
    out.map((o) => o.relativePath),
    [".gemini/settings.json", "AGENTS.md.snippet"],
  );
});

test("Gemini CLI settings.json is deterministic JSON", () => {
  const out = new GeminiCliAdapter().generate([]);
  const settings = out.find((o) => o.relativePath === ".gemini/settings.json").content;
  assert.equal(
    settings,
    '{\n  "context": {\n    "fileName": [\n      "AGENTS.md"\n    ]\n  }\n}\n',
  );
  assert.deepEqual(JSON.parse(settings), { context: { fileName: ["AGENTS.md"] } });
});

test("Gemini CLI snippet matches Codex CLI shape (markers + bullets)", () => {
  const out = new GeminiCliAdapter().generate([skill("foo", "Foo desc")]);
  const snippet = out.find((o) => o.relativePath === "AGENTS.md.snippet").content;
  assert.match(snippet, /<!-- begin: @ozzylabs\/skills -->/);
  assert.match(snippet, /- `foo` — Foo desc/);
  assert.match(snippet, /<!-- end: @ozzylabs\/skills -->/);
});

test("Gemini CLI adapter is deterministic across reordered inputs", () => {
  const a = new GeminiCliAdapter().generate([skill("zeta", "z"), skill("alpha", "a")]);
  const b = new GeminiCliAdapter().generate([skill("alpha", "a"), skill("zeta", "z")]);
  assert.deepEqual(a, b);
});

test("Gemini CLI adapter has id 'gemini-cli'", () => {
  assert.equal(GeminiCliAdapter.id, "gemini-cli");
});
