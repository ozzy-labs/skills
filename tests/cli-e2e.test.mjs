// End-to-end tests for the `@ozzylabs/skills` CLI (`skills add`).
//
// These run the actual `bin/skills.mjs` entry point as a child process with a
// temporary HOME (via `OZZYLABS_SKILLS_HOME`) and assert that files land where
// we expect. The spawned child has no TTY, so `add` requires an explicit
// `--adapter` (interactive auto-detect is a separate, TTY-only path).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "skills.mjs");

function runCli(args, options = {}) {
  return spawnSync("node", [BIN, ...args], {
    cwd: options.cwd ?? ROOT,
    env: {
      ...process.env,
      ...(options.home ? { OZZYLABS_SKILLS_HOME: options.home } : {}),
    },
    encoding: "utf8",
  });
}

test("e2e: add --adapter=claude-code --skills=drive writes the wrapper + canonical base", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-e2e-"));
  try {
    const result = runCli(["add", "--adapter=claude-code", "--skills=drive", "--force"], { home });
    assert.equal(result.status, 0, `cli failed: ${result.stderr}`);
    const wrapper = join(home, ".claude", "skills", "drive", "SKILL.md");
    assert.ok(existsSync(wrapper), `expected wrapper at ${wrapper}`);
    const content = readFileSync(wrapper, "utf8");
    assert.match(
      content,
      /~\/\.agents\/skills\/drive\/SKILL\.md/,
      "wrapper references ~/.agents base",
    );
    // Self-contained (#145): the canonical base the wrapper Reads is shipped too.
    const base = join(home, ".agents", "skills", "drive", "SKILL.md");
    assert.ok(existsSync(base), `expected canonical base at ${base}`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: `install` is an alias for `add`", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-e2e-"));
  try {
    const result = runCli(["install", "--adapter=codex-cli", "--skills=drive", "--force"], {
      home,
    });
    assert.equal(result.status, 0, `cli failed: ${result.stderr}`);
    assert.ok(existsSync(join(home, ".agents", "skills", "drive", "SKILL.md")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: add --dry-run prints a JSON plan and writes nothing", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-e2e-"));
  try {
    const result = runCli(["add", "--adapter=claude-code", "--skills=drive", "--dry-run"], {
      home,
    });
    assert.equal(result.status, 0, `cli failed: ${result.stderr}`);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.adapter, "claude-code");
    assert.equal(plan.target_dir, home);
    assert.ok(Array.isArray(plan.files) && plan.files.length > 0, "plan lists files");
    assert.ok(!existsSync(join(home, ".claude", "skills", "drive")), "dry-run wrote nothing");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: add --target writes project-scope files into the target repo", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-e2e-"));
  const target = await mkdtemp(join(tmpdir(), "skills-e2e-repo-"));
  try {
    const result = runCli(["add", "--target", target, "--skills", "drive", "--force"], { home });
    assert.equal(result.status, 0, `cli failed: ${result.stderr}`);
    // Project scope ships both the wrapper and the canonical base, with
    // repo-root-relative refs preserved (not rewritten to ~/).
    const wrapper = join(target, ".claude", "skills", "drive", "SKILL.md");
    assert.ok(existsSync(wrapper), `expected project wrapper at ${wrapper}`);
    assert.ok(existsSync(join(target, ".agents", "skills", "drive", "SKILL.md")));
    assert.doesNotMatch(
      readFileSync(wrapper, "utf8"),
      /~\/\.agents\/skills/,
      "project refs stay relative",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("e2e: add without --adapter in a non-TTY session errors", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-e2e-"));
  try {
    const result = runCli(["add", "--skills=drive"], { home });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /non-interactive|--adapter/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: unknown verb suggests a correction", () => {
  const result = runCli(["isntall"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did you mean 'install'\?/);
});

test("e2e: not-yet-implemented verbs exit non-zero with the #151 pointer", () => {
  const result = runCli(["list"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /#151/);
});
