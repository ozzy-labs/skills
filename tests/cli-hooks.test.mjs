// Tests for `skills hooks add|remove` (ozzy-labs/skills#174 PR 1).
//
// Split like the rest of the CLI suite: the pure settings transforms + path
// resolution are unit-tested directly, and the end-to-end wiring runs the actual
// `bin/skills.mjs` entry point as a child process against a temporary HOME (via
// OZZYLABS_SKILLS_HOME), mirroring `cli-install.test.mjs` / `cli-e2e.test.mjs`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  addHookEntry,
  buildCommand,
  HOOK_DEFS,
  removeHookEntry,
  resolveScriptPath,
  runHooks,
} from "../bin/lib/hooks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "skills.mjs");

const UG = HOOK_DEFS["usage-guard"];
const OBS = HOOK_DEFS.observability;

function runCli(args, options = {}) {
  return spawnSync("node", [BIN, ...args], {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.home ? { OZZYLABS_SKILLS_HOME: options.home } : {}) },
    encoding: "utf8",
  });
}

/** Materialize a build-output-style skill dir (no provenance marker). */
function seedBuildOutput(root, skill, script) {
  const dir = join(root, ".claude", "skills", skill);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, script), "// hook\n");
  return join(dir, script);
}

/** Materialize a marker-verified (user-scope install style) skill dir. */
function seedInstalled(root, skill, script) {
  const p = seedBuildOutput(root, skill, script);
  writeFileSync(
    join(dirname(p), ".ozzylabs-skills.json"),
    JSON.stringify({
      schema: 1,
      source: "@ozzylabs/skills",
      bundleVersion: "1.0.0",
      adapters: ["claude-code"],
    }),
  );
  return p;
}

// ── pure transforms ─────────────────────────────────────────────────────────

test("buildCommand prefixes the absolute script path with node", () => {
  assert.equal(buildCommand("/abs/usage-guard-hook.mjs"), "node /abs/usage-guard-hook.mjs");
});

test("addHookEntry seeds hooks.PreToolUse with a matcher on empty settings", () => {
  const { settings, changed } = addHookEntry({}, UG, "node /x/usage-guard-hook.mjs");
  assert.equal(changed, true);
  assert.deepEqual(settings.hooks.PreToolUse, [
    { matcher: "*", hooks: [{ type: "command", command: "node /x/usage-guard-hook.mjs" }] },
  ]);
});

test("addHookEntry omits matcher for SessionEnd (observability)", () => {
  const { settings } = addHookEntry({}, OBS, "node /x/obs-derive.mjs");
  const entry = settings.hooks.SessionEnd[0];
  assert.ok(!("matcher" in entry), "SessionEnd entry must not carry a matcher");
  assert.deepEqual(entry.hooks, [{ type: "command", command: "node /x/obs-derive.mjs" }]);
});

test("addHookEntry appends to an existing PreToolUse array and preserves foreign entries", () => {
  const existing = {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash ./other.sh" }] }],
    },
  };
  const { settings, changed } = addHookEntry(existing, UG, "node /x/usage-guard-hook.mjs");
  assert.equal(changed, true);
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "bash ./other.sh");
  assert.equal(existing.hooks.PreToolUse.length, 1, "input settings must not be mutated");
});

test("addHookEntry is idempotent — a second add (even with a different path) is a no-op", () => {
  const first = addHookEntry({}, UG, "node /a/usage-guard-hook.mjs");
  const second = addHookEntry(first.settings, UG, "node /b/usage-guard-hook.mjs");
  assert.equal(second.changed, false);
  assert.strictEqual(second.settings, first.settings, "unchanged object returned as-is");
});

test("removeHookEntry deletes only our entry, keeping foreign hooks and other events", () => {
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "bash ./other.sh" }] },
        { matcher: "*", hooks: [{ type: "command", command: "node /x/usage-guard-hook.mjs" }] },
      ],
      PostToolUse: [{ hooks: [{ type: "command", command: "node /x/audit.mjs" }] }],
    },
  };
  const { settings: out, changed } = removeHookEntry(settings, UG);
  assert.equal(changed, true);
  assert.equal(out.hooks.PreToolUse.length, 1, "our emptied group is dropped");
  assert.equal(out.hooks.PreToolUse[0].hooks[0].command, "bash ./other.sh");
  assert.deepEqual(out.hooks.PostToolUse, settings.hooks.PostToolUse, "other events untouched");
});

test("removeHookEntry keeps a shared group but strips our command from it", () => {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            { type: "command", command: "node /x/usage-guard-hook.mjs" },
            { type: "command", command: "node /x/keep-me.mjs" },
          ],
        },
      ],
    },
  };
  const { settings: out, changed } = removeHookEntry(settings, UG);
  assert.equal(changed, true);
  assert.deepEqual(out.hooks.PreToolUse[0].hooks, [
    { type: "command", command: "node /x/keep-me.mjs" },
  ]);
});

test("removeHookEntry on absent hook is a no-op", () => {
  const settings = { hooks: { PreToolUse: [] } };
  const { changed } = removeHookEntry(settings, UG);
  assert.equal(changed, false);
});

// ── path resolution ─────────────────────────────────────────────────────────

test("resolveScriptPath resolves a marker-verified (user-scope) install", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-hooks-"));
  try {
    const expected = seedInstalled(root, "usage-guard", "usage-guard-hook.mjs");
    assert.equal(await resolveScriptPath([root], UG), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveScriptPath resolves a dogfood build-output dir with no marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-hooks-"));
  try {
    const expected = seedBuildOutput(root, "skill-observability", "obs-derive.mjs");
    assert.equal(await resolveScriptPath([root], OBS), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveScriptPath returns null when the skill is not installed anywhere", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-hooks-"));
  try {
    assert.equal(await resolveScriptPath([root], UG), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── not-installed error (in-process, injected empty scope root) ──────────────

test("runHooks add errors with an install hint when the skill is not installed", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-"));
  const empty = await mkdtemp(join(tmpdir(), "skills-empty-"));
  const prevHome = process.env.OZZYLABS_SKILLS_HOME;
  const captured = { out: "", err: "" };
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s) => {
    captured.out += s;
    return true;
  };
  process.stderr.write = (s) => {
    captured.err += s;
    return true;
  };
  try {
    process.env.OZZYLABS_SKILLS_HOME = home;
    const code = await runHooks(["add", "usage-guard", "--yes"], {
      isTTY: false,
      scopeRoots: [empty],
    });
    assert.equal(code, 1);
    assert.match(captured.err, /not installed/);
    assert.match(captured.err, /add --skills=usage-guard/);
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
    if (prevHome === undefined) delete process.env.OZZYLABS_SKILLS_HOME;
    else process.env.OZZYLABS_SKILLS_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
  }
});

// ── end-to-end (child process) ───────────────────────────────────────────────

test("e2e: hooks add refuses to write non-interactively without --yes", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    runCli(["add", "--adapter=claude-code", "--skills=usage-guard", "--force"], { home });
    const r = runCli(["hooks", "add", "usage-guard"], { home });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--yes/);
    assert.ok(
      !existsSync(join(home, ".claude", "settings.local.json")),
      "nothing written without confirmation",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: hooks remove refuses to write non-interactively without --yes", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    runCli(["add", "--adapter=claude-code", "--skills=usage-guard", "--force"], { home });
    runCli(["hooks", "add", "usage-guard", "--yes"], { home });
    const r = runCli(["hooks", "remove", "usage-guard"], { home });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--yes/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: hooks add usage-guard wires an absolute path into settings.local.json", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    const add = runCli(["add", "--adapter=claude-code", "--skills=usage-guard", "--force"], {
      home,
    });
    assert.equal(add.status, 0, `install failed: ${add.stderr}`);

    const r = runCli(["hooks", "add", "usage-guard", "--yes"], { home });
    assert.equal(r.status, 0, `hooks add failed: ${r.stderr}`);

    const settingsFile = join(home, ".claude", "settings.local.json");
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    const entry = settings.hooks.PreToolUse[0];
    assert.equal(entry.matcher, "*");
    const expected = join(home, ".claude", "skills", "usage-guard", "usage-guard-hook.mjs");
    assert.equal(entry.hooks[0].command, `node ${expected}`);
    assert.ok(entry.hooks[0].command.includes(home), "command is an absolute path under HOME");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: hooks add observability wires a SessionEnd entry (no matcher)", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    runCli(["add", "--adapter=claude-code", "--skills=skill-observability", "--force"], { home });
    const r = runCli(["hooks", "add", "observability", "--yes"], { home });
    assert.equal(r.status, 0, `hooks add failed: ${r.stderr}`);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.local.json"), "utf8"));
    const entry = settings.hooks.SessionEnd[0];
    assert.ok(!("matcher" in entry), "SessionEnd carries no matcher");
    assert.match(entry.hooks[0].command, /obs-derive\.mjs$/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: a second hooks add is an idempotent no-op", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    runCli(["add", "--adapter=claude-code", "--skills=usage-guard", "--force"], { home });
    runCli(["hooks", "add", "usage-guard", "--yes"], { home });
    const settingsFile = join(home, ".claude", "settings.local.json");
    const before = readFileSync(settingsFile, "utf8");

    const r = runCli(["hooks", "add", "usage-guard", "--yes"], { home });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /already wired|Nothing to do/i);
    assert.equal(readFileSync(settingsFile, "utf8"), before, "settings unchanged on repeat add");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: hooks add refuses to overwrite an unparseable settings file", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    runCli(["add", "--adapter=claude-code", "--skills=usage-guard", "--force"], { home });
    const settingsFile = join(home, ".claude", "settings.local.json");
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, "{ not valid json ");

    const r = runCli(["hooks", "add", "usage-guard", "--yes"], { home });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not valid JSON/);
    assert.equal(readFileSync(settingsFile, "utf8"), "{ not valid json ", "corrupt file untouched");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: --scope=user writes settings.json instead of settings.local.json", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    runCli(["add", "--adapter=claude-code", "--skills=usage-guard", "--force"], { home });
    const r = runCli(["hooks", "add", "usage-guard", "--scope=user", "--yes"], { home });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(home, ".claude", "settings.json")), "settings.json written");
    assert.ok(
      !existsSync(join(home, ".claude", "settings.local.json")),
      "settings.local.json not touched under --scope=user",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: hooks remove deletes only our entry, preserving foreign hooks", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    runCli(["add", "--adapter=claude-code", "--skills=usage-guard", "--force"], { home });
    runCli(["hooks", "add", "usage-guard", "--yes"], { home });

    // Inject a foreign PreToolUse entry the CLI must not touch.
    const settingsFile = join(home, ".claude", "settings.local.json");
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    settings.hooks.PreToolUse.unshift({
      matcher: "Bash",
      hooks: [{ type: "command", command: "bash ./guard.sh" }],
    });
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

    const r = runCli(["hooks", "remove", "usage-guard", "--yes"], { home });
    assert.equal(r.status, 0, `remove failed: ${r.stderr}`);
    const after = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(after.hooks.PreToolUse.length, 1, "only our entry removed");
    assert.equal(after.hooks.PreToolUse[0].hooks[0].command, "bash ./guard.sh");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: hooks remove on an unwired hook is a no-op (exit 0)", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    runCli(["add", "--adapter=claude-code", "--skills=usage-guard", "--force"], { home });
    const r = runCli(["hooks", "remove", "usage-guard", "--yes"], { home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /not present|Nothing to do/i);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: hooks --dry-run prints a plan and writes nothing", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    runCli(["add", "--adapter=claude-code", "--skills=usage-guard", "--force"], { home });
    const r = runCli(["hooks", "add", "usage-guard", "--dry-run"], { home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"dry_run": true/);
    assert.ok(!existsSync(join(home, ".claude", "settings.local.json")), "dry-run wrote nothing");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: an unknown hook name is rejected with a suggestion", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    const r = runCli(["hooks", "add", "usage-gaurd", "--yes"], { home });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown hook 'usage-gaurd'/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
