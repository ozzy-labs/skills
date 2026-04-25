import assert from "node:assert/strict";
import { test } from "node:test";
import { renderAgentsMdSnippet } from "../scripts/lib/agents-md-snippet.mjs";

const s = (name, description) => ({
  name,
  description,
  frontmatter: { name, description },
  body: "",
  raw: "",
});

test("renderAgentsMdSnippet wraps a sorted bullet list in markers", () => {
  const out = renderAgentsMdSnippet([s("zeta", "Z desc"), s("alpha", "A desc")]);
  assert.equal(
    out,
    [
      "<!-- begin: @ozzylabs/skills -->",
      "",
      "## Available Skills",
      "",
      "- `alpha` — A desc",
      "- `zeta` — Z desc",
      "",
      "<!-- end: @ozzylabs/skills -->",
      "",
    ].join("\n"),
  );
});

test("renderAgentsMdSnippet on empty list still emits markers and heading", () => {
  const out = renderAgentsMdSnippet([]);
  assert.match(out, /<!-- begin: @ozzylabs\/skills -->/);
  assert.match(out, /## Available Skills/);
  assert.match(out, /<!-- end: @ozzylabs\/skills -->/);
});
