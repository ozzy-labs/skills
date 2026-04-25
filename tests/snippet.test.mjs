import assert from "node:assert/strict";
import { test } from "node:test";
import { SNIPPET_BEGIN, SNIPPET_END, wrapSnippet } from "../scripts/lib/snippet.mjs";

test("wrapSnippet emits begin/end markers around the body", () => {
  const out = wrapSnippet("hello");
  assert.equal(out, `${SNIPPET_BEGIN}\nhello\n${SNIPPET_END}\n`);
});

test("wrapSnippet collapses trailing newlines", () => {
  const out = wrapSnippet("hello\n\n\n");
  assert.equal(out, `${SNIPPET_BEGIN}\nhello\n${SNIPPET_END}\n`);
});

test("snippet markers contain the @ozzylabs/skills tag", () => {
  assert.match(SNIPPET_BEGIN, /@ozzylabs\/skills/);
  assert.match(SNIPPET_END, /@ozzylabs\/skills/);
});
