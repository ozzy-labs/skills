// Guards ADR-0028 R4 (issue #182): lint / test / lint-rules are removed and
// folded into `verify`, with no dangling references left in the SSOT skill
// documents. This is the automated form of the "no leftover lint/test skill
// references" grep assertion from the issue's test plan.

import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = join(ROOT, ".agents", "skills");
const REMOVED = ["lint", "test", "lint-rules"];

/** Every SKILL.md / SKILL.claude-code.md under the SSOT, as [label, body]. */
async function readAllSkillDocs() {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  const docs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const file of ["SKILL.md", "SKILL.claude-code.md"]) {
      try {
        const body = await readFile(join(SKILLS_DIR, entry.name, file), "utf8");
        docs.push([`${entry.name}/${file}`, body]);
      } catch {
        // companion is optional
      }
    }
  }
  return docs;
}

test("removed lint/test/lint-rules skills no longer exist in the SSOT", async () => {
  for (const name of REMOVED) {
    await assert.rejects(
      () => access(join(SKILLS_DIR, name)),
      undefined,
      `deleted skill dir still present: .agents/skills/${name}`,
    );
  }
});

test("no SSOT skill document references a deleted skill's path", async () => {
  // Match `skills/lint/`, `skills/test/`, `skills/lint-rules/` reference paths.
  // (lint-rules first so the alternation does not stop early on "lint".)
  const dangling = /skills\/(lint-rules|lint|test)\//;
  const offenders = [];
  for (const [label, body] of await readAllSkillDocs()) {
    for (const line of body.split("\n")) {
      if (dangling.test(line)) offenders.push(`${label}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "dangling references to removed lint/test/lint-rules skills — rewire to verify",
  );
});

test("ship and implement route verification through the verify skill", async () => {
  const ship = await readFile(join(SKILLS_DIR, "ship", "SKILL.md"), "utf8");
  assert.match(ship, /skills\/verify\/SKILL\.md/, "ship Step 1 must reference the verify skill");

  const implement = await readFile(join(SKILLS_DIR, "implement", "SKILL.md"), "utf8");
  assert.match(
    implement,
    /skills\/verify\/SKILL\.md/,
    "implement Phase 4 (動作確認) must reference the verify skill",
  );
});
