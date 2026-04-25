import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertRequiredFields,
  parseSkillDocument,
  serializeFrontmatter,
} from "../scripts/lib/frontmatter.mjs";

test("parseSkillDocument extracts frontmatter and body", () => {
  const input = "---\nname: foo\ndescription: bar\n---\n# heading\n\nbody\n";
  const { frontmatter, body } = parseSkillDocument(input, "test.md");
  assert.equal(frontmatter.name, "foo");
  assert.equal(frontmatter.description, "bar");
  assert.equal(body, "# heading\n\nbody\n");
});

test("parseSkillDocument throws when frontmatter is missing", () => {
  assert.throws(() => parseSkillDocument("# heading\n", "test.md"), /missing frontmatter/);
});

test("parseSkillDocument preserves colons inside values", () => {
  const input = "---\nname: foo\ndescription: a: b: c\n---\nbody\n";
  const { frontmatter } = parseSkillDocument(input, "test.md");
  assert.equal(frontmatter.description, "a: b: c");
});

test("serializeFrontmatter round-trips parsed input", () => {
  const input = "---\nname: foo\ndescription: bar\n---\nbody\n";
  const { frontmatter, body } = parseSkillDocument(input, "test.md");
  const serialized = serializeFrontmatter(frontmatter) + body;
  assert.equal(serialized, input);
});

test("serializeFrontmatter respects insertion order", () => {
  const out = serializeFrontmatter({ b: "1", a: "2" });
  assert.equal(out, "---\nb: 1\na: 2\n---\n");
});

test("assertRequiredFields throws on missing field", () => {
  assert.throws(
    () => assertRequiredFields({ name: "x" }, ["name", "description"], "f.md"),
    /missing required field 'description'/,
  );
});

test("assertRequiredFields passes when all fields present", () => {
  assertRequiredFields({ name: "x", description: "y" }, ["name", "description"], "f.md");
});
