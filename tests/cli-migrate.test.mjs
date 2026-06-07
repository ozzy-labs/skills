// Unit + e2e tests for `npx @ozzylabs/skills migrate`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GENERIC_SKILLS, planMigrate, stripSyncYamlEntries } from "../bin/lib/migrate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "install.mjs");

/**
 * Stage a fake consumer repo under `dir` so we can exercise migrate against
 * a realistic layout. Returns nothing — callers assert on `dir` directly.
 */
async function stageConsumer(dir, opts = {}) {
  const skills = opts.skills ?? ["drive", "review"];
  for (const skill of skills) {
    const claudeDir = join(dir, ".claude", "skills", skill);
    const agentsDir = join(dir, ".agents", "skills", skill);
    await mkdir(claudeDir, { recursive: true });
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(claudeDir, "SKILL.md"), `---\nname: ${skill}\n---\n`);
    await writeFile(join(agentsDir, "SKILL.md"), `---\nname: ${skill}\n---\n`);
  }
  // Also seed a repo-local skill that migrate should NOT touch.
  if (opts.repoLocal !== false) {
    const local = join(dir, ".claude", "skills", "improve-loop");
    await mkdir(local, { recursive: true });
    await writeFile(join(local, "SKILL.md"), "---\nname: improve-loop\n---\n");
  }
  if (opts.syncYaml ?? true) {
    await mkdir(join(dir, ".commons"), { recursive: true });
    await writeFile(
      join(dir, ".commons", "sync.yaml"),
      [
        "# leading comment",
        "skills_commit: 0123456789abcdef0123456789abcdef01234567",
        "skills_adapters:",
        "  - claude-code",
        "  - codex-cli",
        "commons_commit: fedcba9876543210fedcba9876543210fedcba98",
        "",
      ].join("\n"),
    );
  }
}

function runCli(args, opts = {}) {
  return spawnSync("node", [BIN, ...args], {
    cwd: opts.cwd ?? ROOT,
    env: {
      ...process.env,
      ...(opts.cwd ? { OZZYLABS_SKILLS_CWD: opts.cwd } : {}),
    },
    encoding: "utf8",
  });
}

test("migrate --dry-run lists the generic skill dirs and reports sync.yaml change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-migrate-"));
  try {
    await stageConsumer(dir);
    const result = runCli(["migrate", "--dry-run"], { cwd: dir });
    assert.equal(result.status, 0, `cli failed: ${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.cwd, dir);
    // drive + review staged under both .claude/skills/ and .agents/skills/
    assert.equal(payload.will_remove.length, 4);
    assert.ok(payload.will_remove.includes(".claude/skills/drive"));
    assert.ok(payload.will_remove.includes(".claude/skills/review"));
    assert.ok(payload.will_remove.includes(".agents/skills/drive"));
    assert.ok(payload.will_remove.includes(".agents/skills/review"));
    assert.equal(payload.sync_yaml.path, ".commons/sync.yaml");
    assert.equal(payload.sync_yaml.will_modify, true);
    // dry-run must not touch the disk
    assert.ok(existsSync(join(dir, ".claude", "skills", "drive")));
    assert.ok(existsSync(join(dir, ".agents", "skills", "drive")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrate removes generic skill dirs but leaves repo-local skills intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-migrate-"));
  try {
    await stageConsumer(dir);
    const result = runCli(["migrate", "--force"], { cwd: dir });
    assert.equal(result.status, 0, `cli failed: ${result.stderr}`);
    // Generic skills gone.
    assert.ok(!existsSync(join(dir, ".claude", "skills", "drive")));
    assert.ok(!existsSync(join(dir, ".claude", "skills", "review")));
    assert.ok(!existsSync(join(dir, ".agents", "skills", "drive")));
    assert.ok(!existsSync(join(dir, ".agents", "skills", "review")));
    // Repo-local skill remains.
    assert.ok(existsSync(join(dir, ".claude", "skills", "improve-loop")));
    // sync.yaml updated
    const updated = readFileSync(join(dir, ".commons", "sync.yaml"), "utf8");
    assert.doesNotMatch(updated, /skills_adapters\s*:/);
    assert.doesNotMatch(updated, /skills_commit\s*:/);
    // Unrelated keys preserved.
    assert.match(updated, /commons_commit:/);
    assert.match(updated, /# leading comment/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrate --keep-sync-yaml leaves .commons/sync.yaml untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-migrate-"));
  try {
    await stageConsumer(dir);
    const original = readFileSync(join(dir, ".commons", "sync.yaml"), "utf8");
    const result = runCli(["migrate", "--keep-sync-yaml", "--force"], { cwd: dir });
    assert.equal(result.status, 0, `cli failed: ${result.stderr}`);
    const after = readFileSync(join(dir, ".commons", "sync.yaml"), "utf8");
    assert.equal(after, original);
    // But the skill dirs were still removed.
    assert.ok(!existsSync(join(dir, ".claude", "skills", "drive")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stripSyncYamlEntries removes both keys and their list continuations", () => {
  const input = [
    "skills_commit: abc",
    "skills_adapters:",
    "  - claude-code",
    "  - codex-cli",
    "commons_commit: def",
    "",
  ].join("\n");
  const out = stripSyncYamlEntries(input);
  assert.doesNotMatch(out, /skills_adapters/);
  assert.doesNotMatch(out, /skills_commit/);
  assert.match(out, /commons_commit: def/);
});

test("stripSyncYamlEntries is a no-op when keys are absent", () => {
  const input = "commons_commit: deadbeef\n";
  assert.equal(stripSyncYamlEntries(input), input);
});

test("GENERIC_SKILLS lists exactly the 10 documented generic skills", () => {
  assert.deepEqual([...GENERIC_SKILLS].sort(), [
    "commit",
    "commit-conventions",
    "drive",
    "implement",
    "lint",
    "lint-rules",
    "pr",
    "review",
    "ship",
    "test",
  ]);
});

test("planMigrate returns sane defaults when nothing matches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-migrate-"));
  try {
    const plan = await planMigrate({ cwd: dir, keepSyncYaml: false });
    assert.equal(plan.cwd, dir);
    assert.deepEqual(plan.skill_dirs_to_remove, []);
    assert.equal(plan.sync_yaml.path, null);
    assert.equal(plan.sync_yaml.will_modify, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
