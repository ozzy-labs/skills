// Unit tests for the user-scope install primitives.
//
// These exercise the pure planner (`planInstall`) plus argument parsing
// (`parseFlags`). Filesystem-touching scenarios live in `cli-e2e.test.mjs`.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseFlags } from "../bin/lib/args.mjs";
import { planInstall, SUPPORTED_ADAPTERS } from "../bin/lib/install.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("planInstall returns target_dir under user HOME for claude-code adapter", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-install-"));
  try {
    const plan = await planInstall({
      packageRoot: ROOT,
      home,
      adapter: "claude-code",
      skillsFilter: ["drive"],
    });
    assert.equal(plan.target_dir, home);
    assert.equal(plan.adapter, "claude-code");
    assert.ok(plan.files.length > 0, "plan should include at least one file");
    for (const file of plan.files) {
      assert.ok(file.dest.startsWith(home), `file.dest must live under HOME: ${file.dest}`);
      assert.ok(
        file.source.includes(join("dist", "claude-code")),
        `file.source must come from dist/claude-code/: ${file.source}`,
      );
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("planInstall switches to .agents/skills for codex-cli adapter", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-install-"));
  try {
    const plan = await planInstall({
      packageRoot: ROOT,
      home,
      adapter: "codex-cli",
      skillsFilter: ["drive"],
    });
    const skillFile = plan.files.find((f) => f.skill === "drive");
    assert.ok(skillFile, "expected drive SKILL.md in plan");
    assert.ok(
      skillFile.dest.startsWith(join(home, ".agents", "skills", "drive")),
      `codex-cli adapter must write under ~/.agents/skills/, got: ${skillFile.dest}`,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("planInstall rejects unknown skill names with the available list in the error", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-install-"));
  try {
    await assert.rejects(
      () =>
        planInstall({
          packageRoot: ROOT,
          home,
          adapter: "claude-code",
          skillsFilter: ["this-skill-does-not-exist"],
        }),
      (err) => {
        assert.match(err.message, /this-skill-does-not-exist/);
        assert.match(err.message, /available:/);
        return true;
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("planInstall rejects unsupported adapters with a list of valid ids", async () => {
  await assert.rejects(
    () =>
      planInstall({
        packageRoot: ROOT,
        home: tmpdir(),
        adapter: "vscode",
        skillsFilter: null,
      }),
    (err) => {
      assert.match(err.message, /unsupported adapter 'vscode'/);
      for (const id of SUPPORTED_ADAPTERS) {
        assert.match(err.message, new RegExp(id.replace(/-/g, "\\-")));
      }
      return true;
    },
  );
});

test("planInstall installs every available skill when no filter is supplied", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-install-"));
  try {
    const plan = await planInstall({
      packageRoot: ROOT,
      home,
      adapter: "claude-code",
      skillsFilter: null,
    });
    const skillSet = new Set(plan.files.map((f) => f.skill).filter(Boolean));
    assert.ok(skillSet.size > 1, "expected the catalog to ship more than one skill");
    assert.ok(skillSet.has("drive"));
    assert.ok(skillSet.has("review"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("planInstall handles multi-skill filters", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-install-"));
  try {
    const plan = await planInstall({
      packageRoot: ROOT,
      home,
      adapter: "claude-code",
      skillsFilter: ["drive", "review"],
    });
    const skillSet = new Set(plan.files.map((f) => f.skill).filter(Boolean));
    assert.deepEqual([...skillSet].sort(), ["drive", "review"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("parseFlags handles --flag=value and --flag value forms identically", () => {
  const a = parseFlags(["--skills=drive,review"], {
    skills: "string",
  });
  const b = parseFlags(["--skills", "drive,review"], {
    skills: "string",
  });
  assert.equal(a.values.skills, "drive,review");
  assert.equal(b.values.skills, "drive,review");
});

test("parseFlags routes -h to --help via the aliases table", () => {
  const { values } = parseFlags(["-h"], { help: "boolean" }, { h: "help" });
  assert.equal(values.help, true);
});

test("parseFlags surfaces unknown flags in the rejected array", () => {
  const { rejected } = parseFlags(["--bogus"], { skills: "string" });
  assert.deepEqual(rejected, ["--bogus"]);
});

test("planInstall with --skills filter includes only the named skill files", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-install-"));
  try {
    const plan = await planInstall({
      packageRoot: ROOT,
      home,
      adapter: "claude-code",
      skillsFilter: ["drive"],
    });
    for (const file of plan.files) {
      // Skill files for drive should be the only per-skill entries.
      if (file.skill) {
        assert.equal(file.skill, "drive");
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
