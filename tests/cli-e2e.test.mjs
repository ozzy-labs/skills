// End-to-end tests for `npx @ozzylabs/skills install`.
//
// These run the actual `bin/install.mjs` entry point as a child process with
// a temporary HOME (via `OZZYLABS_SKILLS_HOME`) and assert that files land
// where we expect them. They exercise the install path that ships to users.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "install.mjs");

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

test("e2e: install --adapter=claude-code --skills=drive writes ~/.claude/skills/drive/SKILL.md", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-e2e-"));
  try {
    const result = runCli(["install", "--adapter=claude-code", "--skills=drive", "--force"], {
      home,
    });
    assert.equal(result.status, 0, `cli failed: ${result.stderr}`);
    const target = join(home, ".claude", "skills", "drive", "SKILL.md");
    assert.ok(existsSync(target), `expected SKILL.md at ${target}`);
    const content = readFileSync(target, "utf8");
    assert.match(content, /^---\n/, "SKILL.md should start with YAML frontmatter");
    assert.match(
      content,
      /description:/,
      "SKILL.md should declare a description in the frontmatter",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: install --adapter=codex-cli --skills=drive writes ~/.agents/skills/drive/SKILL.md", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-e2e-"));
  try {
    const result = runCli(["install", "--adapter=codex-cli", "--skills=drive", "--force"], {
      home,
    });
    assert.equal(result.status, 0, `cli failed: ${result.stderr}`);
    const target = join(home, ".agents", "skills", "drive", "SKILL.md");
    assert.ok(existsSync(target), `expected SKILL.md at ${target}`);
    const content = readFileSync(target, "utf8");
    assert.match(content, /name:\s*drive/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: install --dry-run does not touch the filesystem", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-e2e-"));
  try {
    const result = runCli(["install", "--adapter=claude-code", "--skills=drive", "--dry-run"], {
      home,
    });
    assert.equal(result.status, 0, `cli failed: ${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.adapter, "claude-code");
    assert.equal(payload.target_dir, home);
    assert.deepEqual(payload.installed, ["drive"]);
    // No files should be written.
    const target = join(home, ".claude", "skills", "drive", "SKILL.md");
    assert.ok(!existsSync(target), `dry-run wrote ${target} unexpectedly`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: install rejects --target with the user-only error message", () => {
  const result = runCli(["install", "--target=/tmp/foo"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not supported/);
  assert.match(result.stderr, /user-scoped skills directory only/);
});

test("e2e: install --upgrade overwrites an existing SKILL.md", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-e2e-"));
  try {
    // First install populates the target.
    const first = runCli(["install", "--adapter=claude-code", "--skills=drive", "--force"], {
      home,
    });
    assert.equal(first.status, 0, `first install failed: ${first.stderr}`);

    // Corrupt the installed file so we can detect the overwrite.
    const target = join(home, ".claude", "skills", "drive", "SKILL.md");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(target, "tampered\n");
    assert.equal(readFileSync(target, "utf8"), "tampered\n");

    // --upgrade should rewrite the file from dist/.
    const second = runCli(["install", "--adapter=claude-code", "--skills=drive", "--upgrade"], {
      home,
    });
    assert.equal(second.status, 0, `upgrade install failed: ${second.stderr}`);
    assert.notEqual(readFileSync(target, "utf8"), "tampered\n");
    const payload = JSON.parse(second.stdout);
    assert.deepEqual(payload.upgraded, ["drive"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
