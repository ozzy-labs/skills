// Tests for `skills hooks add|remove|status` (ozzy-labs/skills#174 PR 1 = add/
// remove, PR 2 = status + permissions suggestion).
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
  loadSchema,
  mergePolicies,
  parseYaml,
  validatePolicy,
} from "../.agents/skills/policy/policy-read.mjs";
import {
  addHookEntry,
  addPermissionEntries,
  buildCommand,
  buildUsagePermissionRules,
  classifyUsageSource,
  diagnoseUsageSource,
  HOOK_DEFS,
  removeHookEntry,
  resolveScriptPath,
  runHooks,
} from "../bin/lib/hooks.mjs";
import { POLICY_TEMPLATE, resolvePolicyPath } from "../bin/lib/policy-init.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "skills.mjs");

const UG = HOOK_DEFS["usage-guard"];
const OBS = HOOK_DEFS.observability;
const POLICY = HOOK_DEFS.policy;

function runCli(args, options = {}) {
  return spawnSync("node", [BIN, ...args], {
    cwd: options.cwd ?? ROOT,
    env: {
      ...process.env,
      ...(options.home ? { OZZYLABS_SKILLS_HOME: options.home } : {}),
      ...(options.env ?? {}),
    },
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

// ── policy hook definition (PR 3) ─────────────────────────────────────────────

test("HOOK_DEFS.policy targets PreToolUse (matcher '*') with the policy-hook script", () => {
  assert.deepEqual(POLICY, {
    skill: "policy",
    event: "PreToolUse",
    matcher: "*",
    script: "policy-hook.mjs",
  });
});

test("addHookEntry wires policy alongside usage-guard as a sibling PreToolUse entry", () => {
  // Both are PreToolUse/matcher "*" but carry DIFFERENT scripts, so they coexist
  // (disambiguated by the script filename in the command) rather than dedup.
  const withUg = addHookEntry({}, UG, "node /x/usage-guard-hook.mjs").settings;
  const { settings, changed } = addHookEntry(withUg, POLICY, "node /x/policy-hook.mjs");
  assert.equal(changed, true, "a different script is not an idempotent skip");
  assert.equal(settings.hooks.PreToolUse.length, 2, "usage-guard + policy coexist");
  const commands = settings.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(commands.includes("node /x/usage-guard-hook.mjs"));
  assert.ok(commands.includes("node /x/policy-hook.mjs"));
  // adding policy a second time is idempotent
  const again = addHookEntry(settings, POLICY, "node /y/policy-hook.mjs");
  assert.equal(again.changed, false, "re-adding policy (any path) is a no-op");
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

// ── permissions suggestion (PR 2) ────────────────────────────────────────────

test("buildUsagePermissionRules emits a double-slash Read + a node Bash rule", () => {
  const rules = buildUsagePermissionRules({
    credentialsPath: "/home/alice/.claude/.credentials.json",
    usageCheckPath: "/home/alice/.claude/skills/usage-guard/usage-check.mjs",
  });
  assert.deepEqual(rules, [
    "Read(//home/alice/.claude/.credentials.json)",
    "Bash(node /home/alice/.claude/skills/usage-guard/usage-check.mjs:*)",
  ]);
});

test("addPermissionEntries seeds permissions.allow on empty settings", () => {
  const rules = ["Read(//x/.credentials.json)", "Bash(node /x/usage-check.mjs:*)"];
  const { settings, changed, added } = addPermissionEntries({}, rules);
  assert.equal(changed, true);
  assert.deepEqual(settings.permissions.allow, rules);
  assert.deepEqual(added, rules);
});

test("addPermissionEntries preserves existing allow/deny and appends only new rules", () => {
  const existing = {
    permissions: { allow: ["Read(//keep/me)"], deny: ["Bash(rm:*)"] },
    other: { untouched: true },
  };
  const rules = ["Read(//keep/me)", "Bash(node /x/usage-check.mjs:*)"];
  const { settings, changed, added } = addPermissionEntries(existing, rules);
  assert.equal(changed, true);
  assert.deepEqual(settings.permissions.allow, [
    "Read(//keep/me)",
    "Bash(node /x/usage-check.mjs:*)",
  ]);
  assert.deepEqual(added, ["Bash(node /x/usage-check.mjs:*)"], "only the missing rule is added");
  assert.deepEqual(settings.permissions.deny, ["Bash(rm:*)"], "deny is preserved");
  assert.deepEqual(settings.other, { untouched: true }, "unrelated keys preserved");
  assert.equal(existing.permissions.allow.length, 1, "input settings not mutated");
});

test("addPermissionEntries is idempotent when all rules already present", () => {
  const rules = ["Read(//x/.credentials.json)", "Bash(node /x/usage-check.mjs:*)"];
  const first = addPermissionEntries({}, rules);
  const second = addPermissionEntries(first.settings, rules);
  assert.equal(second.changed, false);
  assert.deepEqual(second.added, []);
  assert.strictEqual(second.settings, first.settings, "unchanged object returned as-is");
});

// ── usage-check source classification / diagnosis (PR 2) ──────────────────────

test("classifyUsageSource: endpoint/cache are effective, jsonl/fail-open degraded", () => {
  for (const s of ["endpoint", "cache"]) {
    const c = classifyUsageSource(s);
    assert.equal(c.effective, true, `${s} → effective`);
    assert.equal(c.symbol, "✅");
  }
  for (const s of ["jsonl", "fail-open"]) {
    const c = classifyUsageSource(s);
    assert.equal(c.effective, false, `${s} → degraded`);
    assert.equal(c.symbol, "⚠️");
    assert.match(c.label, /環境要件/, "degraded label points to §環境要件");
  }
  const unknown = classifyUsageSource(null);
  assert.equal(unknown.effective, null);
  assert.equal(unknown.symbol, "?");
});

test("diagnoseUsageSource honors the env fixture over spawning", () => {
  let spawned = false;
  const d = diagnoseUsageSource({
    scriptPath: "/should/not/run.mjs",
    env: { OZZYLABS_SKILLS_USAGE_CHECK_JSON: '{"source":"endpoint","ok":true}' },
    spawnImpl: () => {
      spawned = true;
      return {};
    },
  });
  assert.equal(d.source, "endpoint");
  assert.equal(spawned, false, "fixture bypasses the spawn");
});

test("diagnoseUsageSource spawns node and parses the last JSON line's source", () => {
  const d = diagnoseUsageSource({
    scriptPath: "/x/usage-check.mjs",
    env: {},
    spawnImpl: (cmd, args) => {
      assert.equal(cmd, "node");
      assert.deepEqual(args, ["/x/usage-check.mjs"]);
      return { stdout: 'warning line\n{"source":"fail-open","ok":true}\n' };
    },
  });
  assert.equal(d.source, "fail-open");
});

test("diagnoseUsageSource fails soft: null path, bad fixture, spawn error → { source: null }", () => {
  assert.equal(diagnoseUsageSource({ scriptPath: null, env: {} }).source, null);
  assert.equal(
    diagnoseUsageSource({
      scriptPath: "/x.mjs",
      env: { OZZYLABS_SKILLS_USAGE_CHECK_JSON: "not json" },
    }).source,
    null,
  );
  const errRes = diagnoseUsageSource({
    scriptPath: "/x.mjs",
    env: {},
    spawnImpl: () => ({ error: new Error("ENOENT") }),
  });
  assert.equal(errRes.source, null);
  assert.match(errRes.error, /ENOENT/);
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

// ── permissions suggestion end-to-end (PR 2) ─────────────────────────────────

test("e2e: hooks add usage-guard also writes the permissions allowlist", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    runCli(["add", "--adapter=claude-code", "--skills=usage-guard", "--force"], { home });
    const r = runCli(["hooks", "add", "usage-guard", "--yes"], { home });
    assert.equal(r.status, 0, `hooks add failed: ${r.stderr}`);

    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.local.json"), "utf8"));
    const allow = settings.permissions.allow;
    const creds = join(home, ".claude", ".credentials.json");
    const usageCheck = join(home, ".claude", "skills", "usage-guard", "usage-check.mjs");
    assert.ok(allow.includes(`Read(/${creds})`), "credentials Read rule added (double-slash)");
    assert.ok(allow.includes(`Bash(node ${usageCheck}:*)`), "node exec Bash rule added");
    // hook wiring is still intact alongside the permissions.
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /usage-guard-hook\.mjs$/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: --no-permissions wires the hook only (no permissions written)", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    runCli(["add", "--adapter=claude-code", "--skills=usage-guard", "--force"], { home });
    const r = runCli(["hooks", "add", "usage-guard", "--no-permissions", "--yes"], { home });
    assert.equal(r.status, 0, r.stderr);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.local.json"), "utf8"));
    assert.ok(settings.hooks.PreToolUse, "hook still wired");
    assert.ok(!("permissions" in settings), "no permissions key written under --no-permissions");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: permissions allowlist is idempotent (second add is a no-op)", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    runCli(["add", "--adapter=claude-code", "--skills=usage-guard", "--force"], { home });
    runCli(["hooks", "add", "usage-guard", "--yes"], { home });
    const settingsFile = join(home, ".claude", "settings.local.json");
    const before = readFileSync(settingsFile, "utf8");
    const r = runCli(["hooks", "add", "usage-guard", "--yes"], { home });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /already wired|Nothing to do/i);
    assert.equal(readFileSync(settingsFile, "utf8"), before, "no duplicate permission entries");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: a hook wired with --no-permissions gains permissions on a later plain add", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    runCli(["add", "--adapter=claude-code", "--skills=usage-guard", "--force"], { home });
    runCli(["hooks", "add", "usage-guard", "--no-permissions", "--yes"], { home });
    // Hook is wired but permissions are absent; a plain re-add must add just the
    // permissions (changed) rather than report "already wired".
    const r = runCli(["hooks", "add", "usage-guard", "--yes"], { home });
    assert.equal(r.status, 0, r.stderr);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.local.json"), "utf8"));
    assert.ok(Array.isArray(settings.permissions.allow), "permissions added on the second add");
    assert.equal(settings.hooks.PreToolUse.length, 1, "hook not duplicated");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ── hooks status end-to-end (PR 2) ────────────────────────────────────────────

test("e2e: hooks status reports per-hook wiring (unwired baseline)", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    const r = runCli(["hooks", "status"], { home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /usage-guard.*not wired/, "usage-guard shows not wired");
    assert.match(r.stdout, /observability.*not wired/, "observability shows not wired");
    assert.match(
      r.stdout,
      /policy.*not wired/,
      "policy is now a real (wireable) hook, shown unwired",
    );
    const summary = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.equal(summary.action, "status");
    assert.equal(summary.hooks.find((h) => h.name === "usage-guard").wired, false);
    assert.equal(
      summary.hooks.find((h) => h.name === "policy").wired,
      false,
      "policy listed as a real hook",
    );
    assert.deepEqual(summary.planned, [], "policy is no longer 'planned' — it is wireable now");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: hooks status shows a wired hook + endpoint source → guard effective", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    runCli(["add", "--adapter=claude-code", "--skills=usage-guard", "--force"], { home });
    runCli(["hooks", "add", "usage-guard", "--yes"], { home });
    const r = runCli(["hooks", "status"], {
      home,
      env: { OZZYLABS_SKILLS_USAGE_CHECK_JSON: '{"source":"endpoint","ok":true}' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /usage-guard.*wired/);
    assert.match(r.stdout, /source=endpoint/);
    assert.match(r.stdout, /effective/);
    const summary = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    const ug = summary.hooks.find((h) => h.name === "usage-guard");
    assert.equal(ug.wired, true);
    assert.equal(ug.usage_source, "endpoint");
    assert.equal(ug.usage_effective, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: hooks status flags a degraded (fail-open) source with a warning", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    runCli(["add", "--adapter=claude-code", "--skills=usage-guard", "--force"], { home });
    runCli(["hooks", "add", "usage-guard", "--yes"], { home });
    const r = runCli(["hooks", "status"], {
      home,
      env: { OZZYLABS_SKILLS_USAGE_CHECK_JSON: '{"source":"fail-open","ok":true}' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DEGRADED/);
    assert.match(r.stdout, /source=fail-open/);
    assert.match(r.stdout, /環境要件/, "points to usage-guard §環境要件");
    const summary = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    const ug = summary.hooks.find((h) => h.name === "usage-guard");
    assert.equal(ug.usage_source, "fail-open");
    assert.equal(ug.usage_effective, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ── hooks add policy end-to-end (PR 3) ────────────────────────────────────────

test("e2e: hooks add policy wires the policy-hook PreToolUse entry (matcher '*')", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    const add = runCli(["add", "--adapter=claude-code", "--skills=policy", "--force"], { home });
    assert.equal(add.status, 0, `install failed: ${add.stderr}`);

    const r = runCli(["hooks", "add", "policy", "--yes"], { home });
    assert.equal(r.status, 0, `hooks add policy failed: ${r.stderr}`);

    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.local.json"), "utf8"));
    const entry = settings.hooks.PreToolUse.find((g) =>
      g.hooks.some((h) => /policy-hook\.mjs$/.test(h.command)),
    );
    assert.ok(entry, "a PreToolUse entry referencing policy-hook.mjs is written");
    assert.equal(entry.matcher, "*");
    // policy is NOT adapter-gated, so it has a shared `.agents/skills` base that
    // readInstalled scans before `.claude/skills`; the resolved path is that base
    // (unlike usage-guard, which is claude-only and resolves to `.claude/skills`).
    // Either is a valid absolute path to the same script — assert the shape.
    const cmd = entry.hooks.find((h) => /policy-hook\.mjs$/.test(h.command)).command;
    assert.match(cmd, /^node .*\/policy\/policy-hook\.mjs$/, "node-prefixed absolute path");
    assert.ok(cmd.includes(home), "the resolved command is an absolute path under HOME");
    assert.ok(
      cmd.includes(join(home, ".agents", "skills", "policy")) ||
        cmd.includes(join(home, ".claude", "skills", "policy")),
      "resolved from an installed policy skill dir (.agents base or .claude wrapper)",
    );
    // policy is not usage-guard → no permissions allowlist suggestion is folded in.
    assert.ok(!("permissions" in settings), "policy add writes no permissions allowlist");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: hooks remove policy leaves a sibling usage-guard PreToolUse hook intact", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-hooks-e2e-"));
  try {
    runCli(["add", "--adapter=claude-code", "--skills=usage-guard,policy", "--force"], { home });
    runCli(["hooks", "add", "usage-guard", "--yes"], { home });
    runCli(["hooks", "add", "policy", "--yes"], { home });

    const settingsFile = join(home, ".claude", "settings.local.json");
    let settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(settings.hooks.PreToolUse.length, 2, "both PreToolUse hooks wired");

    const r = runCli(["hooks", "remove", "policy", "--yes"], { home });
    assert.equal(r.status, 0, `remove policy failed: ${r.stderr}`);
    settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    const remaining = settings.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(
      remaining.some((c) => /usage-guard-hook\.mjs$/.test(c)),
      "usage-guard entry preserved",
    );
    assert.ok(!remaining.some((c) => /policy-hook\.mjs$/.test(c)), "policy entry removed");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ── policy init end-to-end (PR 3) ─────────────────────────────────────────────

test("e2e: policy init writes ~/.agents/policy.yaml from the commented template", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-policy-e2e-"));
  try {
    const r = runCli(["policy", "init", "--yes"], { home });
    assert.equal(r.status, 0, `policy init failed: ${r.stderr}`);
    const file = join(home, ".agents", "policy.yaml");
    assert.ok(existsSync(file), "policy.yaml written under ~/.agents/");
    const body = readFileSync(file, "utf8");
    assert.match(body, /schema_version: 1/);
    assert.match(body, /reversible-local: proceed/);
    assert.match(body, /externally-visible: batch-confirm/);
    assert.match(body, /irreversible: ask/);
    assert.match(r.stdout, /"created": true/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: policy init is non-destructive — an existing policy.yaml is never overwritten", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-policy-e2e-"));
  try {
    const file = join(home, ".agents", "policy.yaml");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "schema_version: 1\n# hand-edited — keep me\n");
    const before = readFileSync(file, "utf8");

    const r = runCli(["policy", "init", "--yes"], { home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /already exists|not overwriting|Nothing to do/i);
    assert.equal(readFileSync(file, "utf8"), before, "existing policy.yaml left untouched");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: policy init --dry-run prints the template and writes nothing", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-policy-e2e-"));
  try {
    const r = runCli(["policy", "init", "--dry-run"], { home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"dry_run": true/);
    assert.match(r.stdout, /schema_version: 1/);
    assert.ok(!existsSync(join(home, ".agents", "policy.yaml")), "dry-run wrote nothing");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: policy init refuses to write non-interactively without --yes", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-policy-e2e-"));
  try {
    const r = runCli(["policy", "init"], { home });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--yes/);
    assert.ok(!existsSync(join(home, ".agents", "policy.yaml")), "nothing written without --yes");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("e2e: policy init --scope=repo writes <repo>/.agents/policy.yaml", async () => {
  const repo = await mkdtemp(join(tmpdir(), "skills-policy-repo-"));
  try {
    const r = runCli(["policy", "init", "--scope=repo", `--repo-root=${repo}`, "--yes"], {
      home: repo,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(repo, ".agents", "policy.yaml")), "repo-scope policy.yaml written");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ── policy init template ⇄ schema (no drift) ──────────────────────────────────

test("POLICY_TEMPLATE parses + validates clean through policy-read (zero-config equivalent)", async () => {
  const parsed = parseYaml(POLICY_TEMPLATE);
  const schema = await loadSchema();
  const { ok, errors } = validatePolicy(parsed, schema);
  assert.ok(ok, `template must validate against policy.schema.json: ${errors.join("; ")}`);
  // A merged effective policy from the template reproduces the zero-config defaults.
  const eff = mergePolicies({ user: parsed });
  assert.equal(eff.classes["reversible-local"], "proceed");
  assert.equal(eff.classes["externally-visible"], "batch-confirm");
  assert.equal(eff.classes.irreversible, "ask");
  assert.deepEqual(eff.actions, {}, "the actions block is commented → no overrides");
});

test("resolvePolicyPath honors user vs repo scope", () => {
  assert.equal(resolvePolicyPath("user", { home: "/h" }), join("/h", ".agents", "policy.yaml"));
  assert.equal(resolvePolicyPath("repo", { repoRoot: "/r" }), join("/r", ".agents", "policy.yaml"));
});
