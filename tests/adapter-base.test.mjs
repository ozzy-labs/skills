import assert from "node:assert/strict";
import { test } from "node:test";
import { AdapterBase } from "../scripts/lib/adapter-base.mjs";

test("AdapterBase.generate throws when not overridden", () => {
  const adapter = new AdapterBase();
  assert.throws(() => adapter.generate([]), /not implemented/);
});

test("subclass that overrides generate works", () => {
  class FakeAdapter extends AdapterBase {
    static id = "fake";
    generate(skills) {
      return skills.map((s) => ({
        relativePath: `${s.name}.md`,
        content: s.body,
      }));
    }
  }
  const out = new FakeAdapter().generate([
    { name: "x", description: "d", frontmatter: {}, body: "B", raw: "B" },
  ]);
  assert.deepEqual(out, [{ relativePath: "x.md", content: "B" }]);
});
