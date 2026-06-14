// Unit tests for `npx @ozzylabs/skills sync-project`.
//
// Exercise the pure planner (`planSyncProject`) and the filesystem executor
// (`executeSyncProject`) against a temp target dir. The planner reads the
// committed project payload from dist/claude-code-project/.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { executeSyncProject, planSyncProject } from "../bin/lib/sync-project.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("planSyncProject roots every dest under the target repo", async () => {
  const target = await mkdtemp(join(tmpdir(), "skills-sync-"));
  try {
    const plan = await planSyncProject({ packageRoot: ROOT, target, skillsFilter: ["drive"] });
    assert.equal(plan.target, target);
    assert.ok(plan.files.length > 0, "plan should include at least one file");
    for (const file of plan.files) {
      assert.ok(file.dest.startsWith(target), `dest must live under target: ${file.dest}`);
      assert.ok(
        file.source.includes(join("dist", "claude-code-project")),
        `source must come from the project payload: ${file.source}`,
      );
    }
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test("planSyncProject ships both the wrapper and the canonical for a skill", async () => {
  const target = await mkdtemp(join(tmpdir(), "skills-sync-"));
  try {
    const plan = await planSyncProject({ packageRoot: ROOT, target, skillsFilter: ["drive"] });
    const dests = plan.files.map((f) =>
      f.dest
        .slice(target.length + 1)
        .split("\\")
        .join("/"),
    );
    assert.ok(dests.includes(".claude/skills/drive/SKILL.md"), "wrapper must be planned");
    assert.ok(dests.includes(".agents/skills/drive/SKILL.md"), "canonical must be planned");
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test("planSyncProject always includes shared agents regardless of --skills filter", async () => {
  const target = await mkdtemp(join(tmpdir(), "skills-sync-"));
  try {
    const plan = await planSyncProject({ packageRoot: ROOT, target, skillsFilter: ["lint"] });
    const dests = plan.files.map((f) =>
      f.dest
        .slice(target.length + 1)
        .split("\\")
        .join("/"),
    );
    assert.ok(
      dests.some((d) => d.startsWith(".claude/agents/")),
      "Claude Code agents are shared infra and must ship even with a narrow filter",
    );
    // Per-skill files for an unrelated skill must be excluded.
    assert.ok(
      !dests.some((d) => d.startsWith(".claude/skills/drive/")),
      "filtered-out skills must not be planned",
    );
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test("planSyncProject defaults to syncing every available skill", async () => {
  const target = await mkdtemp(join(tmpdir(), "skills-sync-"));
  try {
    const plan = await planSyncProject({ packageRoot: ROOT, target, skillsFilter: null });
    const skills = new Set(plan.files.map((f) => f.skill).filter(Boolean));
    assert.ok(skills.has("drive") && skills.has("review") && skills.has("ship"));
    // Internal skills are excluded from the payload, so they can never be planned.
    assert.ok(!skills.has("health") && !skills.has("topics"));
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test("planSyncProject rejects unknown skill names with the available list", async () => {
  const target = await mkdtemp(join(tmpdir(), "skills-sync-"));
  try {
    await assert.rejects(
      () => planSyncProject({ packageRoot: ROOT, target, skillsFilter: ["nope"] }),
      (err) => {
        assert.match(err.message, /nope/);
        assert.match(err.message, /available:/);
        return true;
      },
    );
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test("executeSyncProject writes relative-ref files into the target repo", async () => {
  const target = await mkdtemp(join(tmpdir(), "skills-sync-"));
  try {
    const plan = await planSyncProject({ packageRoot: ROOT, target, skillsFilter: ["drive"] });
    const result = await executeSyncProject(plan);
    assert.deepEqual(result.written, ["drive"]);
    const wrapper = await readFile(join(target, ".claude", "skills", "drive", "SKILL.md"), "utf8");
    assert.match(wrapper, /`\.agents\/skills\/drive\/SKILL\.md`/);
    assert.doesNotMatch(wrapper, /~\/\.agents\/skills\//);
    // The canonical the wrapper Reads must be present at the resolved path.
    const canonical = await readFile(
      join(target, ".agents", "skills", "drive", "SKILL.md"),
      "utf8",
    );
    assert.ok(canonical.length > 0);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
