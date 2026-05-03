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

test("Gemini CLI adapter emits settings.json + AGENTS.md.snippet", async () => {
  const out = await new GeminiCliAdapter().generate([skill("foo", "Foo")]);
  assert.deepEqual(
    out.map((o) => o.relativePath),
    [".gemini/settings.json", "AGENTS.md.snippet"],
  );
});

test("Gemini CLI settings.json is deterministic JSON with collapsed short array (regression: #35)", async () => {
  const out = await new GeminiCliAdapter().generate([]);
  const settings = out.find((o) => o.relativePath === ".gemini/settings.json").content;
  assert.deepEqual(JSON.parse(settings), { context: { fileName: ["AGENTS.md"] } });
  // The short fileName array must stay on one line — multi-line expansion (the
  // pre-#35 behavior) collides with Biome/Prettier's collapse-short-arrays
  // policy and triggers sync oscillation in downstream repos.
  assert.match(settings, /"fileName": \["AGENTS\.md"\]/);
});

test("Gemini CLI snippet matches Codex CLI shape (markers + bullets)", async () => {
  const out = await new GeminiCliAdapter().generate([skill("foo", "Foo desc")]);
  const snippet = out.find((o) => o.relativePath === "AGENTS.md.snippet").content;
  assert.match(snippet, /<!-- begin: @ozzylabs\/skills -->/);
  assert.match(snippet, /- `foo` — Foo desc/);
  assert.match(snippet, /<!-- end: @ozzylabs\/skills -->/);
});

test("Gemini CLI adapter is deterministic across reordered inputs", async () => {
  const a = await new GeminiCliAdapter().generate([skill("zeta", "z"), skill("alpha", "a")]);
  const b = await new GeminiCliAdapter().generate([skill("alpha", "a"), skill("zeta", "z")]);
  assert.deepEqual(a, b);
});

test("Gemini CLI adapter has id 'gemini-cli'", () => {
  assert.equal(GeminiCliAdapter.id, "gemini-cli");
});
