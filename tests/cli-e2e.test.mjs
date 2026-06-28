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
  const result = runCli(["update"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /#151/);
});

test("e2e: list --json shows installed skills + the available catalog", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-e2e-"));
  try {
    runCli(["add", "--adapter=codex-cli", "--skills=drive", "--force"], { home });
    const r = runCli(["list", "--json"], { home });
    assert.equal(r.status, 0, `list failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.scope, "user");
    const drive = out.skills.find((s) => s.skill === "drive");
    assert.equal(drive.status, "installed");
    assert.deepEqual(drive.adapters, ["codex-cli"]);
    // A skill that was not installed shows up as available.
    const review = out.skills.find((s) => s.skill === "review");
    assert.equal(review.status, "available");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: list (human table) marks installed vs available", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-e2e-"));
  try {
    runCli(["add", "--adapter=codex-cli", "--skills=drive", "--force"], { home });
    const r = runCli(["list"], { home });
    assert.equal(r.status, 0, `list failed: ${r.stderr}`);
    assert.match(r.stdout, /●\s+drive\s+.*\[codex-cli\]/);
    assert.match(r.stdout, /○\s+review\s+available/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: add writes provenance markers (base marker carries the adapter)", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-e2e-"));
  try {
    const r = runCli(["add", "--adapter=codex-cli", "--skills=drive", "--force"], { home });
    assert.equal(r.status, 0, `cli failed: ${r.stderr}`);
    const marker = JSON.parse(
      readFileSync(join(home, ".agents", "skills", "drive", ".ozzylabs-skills.json"), "utf8"),
    );
    assert.equal(marker.source, "@ozzylabs/skills");
    assert.deepEqual(marker.adapters, ["codex-cli"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: a second adapter reference-counts the shared base marker", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-e2e-"));
  try {
    runCli(["add", "--adapter=codex-cli", "--skills=drive", "--force"], { home });
    runCli(["add", "--adapter=claude-code", "--skills=drive", "--force"], { home });
    const marker = JSON.parse(
      readFileSync(join(home, ".agents", "skills", "drive", ".ozzylabs-skills.json"), "utf8"),
    );
    assert.deepEqual(
      marker.adapters,
      ["claude-code", "codex-cli"],
      "base ref-counts both adapters",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: add refuses to overwrite an unmarked (foreign) skill dir without --force", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const home = await mkdtemp(join(tmpdir(), "skills-e2e-"));
  try {
    // Pre-existing, user-authored skill dir with no provenance marker.
    const foreign = join(home, ".agents", "skills", "drive");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "SKILL.md"), "mine\n");

    const blocked = runCli(["add", "--adapter=codex-cli", "--skills=drive"], { home });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /refusing to overwrite|--force/);
    assert.equal(
      readFileSync(join(foreign, "SKILL.md"), "utf8"),
      "mine\n",
      "foreign file untouched",
    );

    // --force overwrites and claims it.
    const forced = runCli(["add", "--adapter=codex-cli", "--skills=drive", "--force"], { home });
    assert.equal(forced.status, 0, `forced add failed: ${forced.stderr}`);
    assert.notEqual(readFileSync(join(foreign, "SKILL.md"), "utf8"), "mine\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: remove uninstalls a skill (base deleted, marker gone)", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-e2e-"));
  try {
    runCli(["add", "--adapter=codex-cli", "--skills=drive", "--force"], { home });
    const base = join(home, ".agents", "skills", "drive");
    assert.ok(existsSync(base));
    const r = runCli(["remove", "--skills=drive", "--yes"], { home });
    assert.equal(r.status, 0, `remove failed: ${r.stderr}`);
    assert.ok(!existsSync(base), "base dir removed");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: remove --adapter reference-counts the shared base", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-e2e-"));
  try {
    runCli(["add", "--adapter=codex-cli", "--skills=drive", "--force"], { home });
    runCli(["add", "--adapter=claude-code", "--skills=drive", "--force"], { home });
    const base = join(home, ".agents", "skills", "drive");
    const wrapper = join(home, ".claude", "skills", "drive");

    // Remove just codex — base stays (claude still needs it), wrapper untouched.
    runCli(["remove", "--skills=drive", "--adapter=codex-cli", "--yes"], { home });
    assert.ok(existsSync(base), "base kept while claude-code still needs it");
    assert.ok(existsSync(wrapper), "claude wrapper untouched");
    const marker = JSON.parse(readFileSync(join(base, ".ozzylabs-skills.json"), "utf8"));
    assert.deepEqual(marker.adapters, ["claude-code"]);

    // Remove claude — last reference gone, base + wrapper deleted.
    runCli(["remove", "--skills=drive", "--adapter=claude-code", "--yes"], { home });
    assert.ok(!existsSync(base), "base removed after last adapter");
    assert.ok(!existsSync(wrapper), "claude wrapper removed");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: remove refuses without --yes in a non-TTY session", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-e2e-"));
  try {
    runCli(["add", "--adapter=codex-cli", "--skills=drive", "--force"], { home });
    const r = runCli(["remove", "--skills=drive"], { home });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--yes/);
    assert.ok(existsSync(join(home, ".agents", "skills", "drive")), "not removed");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: remove never touches an unmarked (foreign) skill dir", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const home = await mkdtemp(join(tmpdir(), "skills-e2e-"));
  try {
    const foreign = join(home, ".agents", "skills", "drive");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "SKILL.md"), "mine\n");
    const r = runCli(["remove", "--skills=drive", "--yes"], { home });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Nothing to remove/);
    assert.ok(existsSync(join(foreign, "SKILL.md")), "foreign dir untouched");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
