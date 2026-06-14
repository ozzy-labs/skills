// Tests for the project-scope payload (dist/claude-code-project/).
//
// This payload is the cloud (Claude mobile / web) counterpart of the
// user-scope dist/{adapter}/ outputs: it is committed into a consumer repo, so
// its refs MUST stay repo-root-relative (the inverse invariant of
// user-scope-refs.test.mjs) and it MUST ship the canonical .agents/skills/
// files that the Claude wrappers Read.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAYLOAD = join(ROOT, "dist", "claude-code-project");

test("project payload keeps repo-root-relative skill refs (no ~/ rewrite)", async () => {
  const wrapper = await readFile(join(PAYLOAD, ".claude", "skills", "drive", "SKILL.md"), "utf8");
  assert.match(
    wrapper,
    /`\.agents\/skills\/drive\/SKILL\.md`/,
    "drive wrapper must reference the canonical via a repo-root-relative path",
  );
  assert.doesNotMatch(
    wrapper,
    /~\/\.agents\/skills\//,
    "project payload must NOT carry user-scope (~/) refs — they break in cloud sessions",
  );
});

test("project payload ships the canonical .agents/skills/<name>/SKILL.md the wrappers Read", () => {
  for (const name of ["drive", "implement", "ship", "review"]) {
    assert.ok(
      existsSync(join(PAYLOAD, ".agents", "skills", name, "SKILL.md")),
      `expected canonical .agents/skills/${name}/SKILL.md in the project payload`,
    );
    assert.ok(
      existsSync(join(PAYLOAD, ".claude", "skills", name, "SKILL.md")),
      `expected wrapper .claude/skills/${name}/SKILL.md in the project payload`,
    );
  }
});

test("project payload ships Claude Code agents (.claude/agents/)", () => {
  assert.ok(
    existsSync(join(PAYLOAD, ".claude", "agents", "code-reviewer.md")),
    "expected the code-reviewer agent in the project payload",
  );
});

test("project payload excludes internal-use skills (health/topics/phase-issue)", async () => {
  for (const root of [join(PAYLOAD, ".claude", "skills"), join(PAYLOAD, ".agents", "skills")]) {
    const names = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const internal of ["health", "topics", "phase-issue"]) {
      assert.ok(
        !names.includes(internal),
        `internal skill ${internal} must not appear under ${root.replace(ROOT, "")}`,
      );
    }
  }
});

test("project payload does not ship the AGENTS.md.snippet aggregation artifact", () => {
  assert.ok(
    !existsSync(join(PAYLOAD, "AGENTS.md.snippet")),
    "AGENTS.md.snippet is irrelevant to skill discovery and must be dropped",
  );
});
