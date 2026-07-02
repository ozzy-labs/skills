// Tests for the policy PreToolUse enforcement hook (ozzy-labs/skills#181 PR 4/4,
// ADR-0028 R3). Everything is exercised through injected deps (payload, kill-
// switch, gate resolver, warn/deny sinks) — no network, no real ~/.claude reads,
// no spawned process. Mirrors tests/usage-guard-hook.test.mjs.
//
// Required cases (issue #181 PR4):
//   - irreversible command + gate=ask → deny (exit 2)
//   - gate=proceed / batch-confirm → allow
//   - non-target command → allow
//   - kill-switch present → allow (no-op)
//   - policy unreadable/unparseable → allow (fail-open) + stderr warn
//   - `--merge`-style proceed override context → allow
// Plus: matcher unit coverage, payload parsing, deny message content, real
// resolveGate wiring against policy-read.mjs, and the structural adapter-payload
// asserts (the extra file ships to every adapter).

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile as realReadFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildDenyReason,
  matchAction,
  PROCEED_ENV,
  parsePayload,
  resolveGateForAction,
  resolveProceedOverride,
  run,
} from "../.agents/skills/policy/policy-hook.mjs";
import {
  mergePolicies,
  resolveGate as realResolveGate,
} from "../.agents/skills/policy/policy-read.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Hermetic run() deps: kill-switch off, no proceed-override env, cwd fixed.
const killOff = () => false;
const bashPayload = (command) => async () =>
  JSON.stringify({ tool_name: "Bash", tool_input: { command } });

// --- (1) irreversible command + gate=ask → deny ------------------------------

test("(1) gh pr merge + gate=ask → deny (exit 2) with the action + origin", async () => {
  const denies = [];
  const code = await run({
    readStdinImpl: bashPayload("gh pr merge 123 --squash"),
    killSwitchImpl: killOff,
    resolveGateImpl: async ({ action }) => {
      assert.equal(action, "merge", "gh pr merge classifies as the merge action");
      return { gate: "ask", degraded: false };
    },
    env: {},
    deny: (m) => denies.push(m),
  });
  assert.equal(code, 2, "gate=ask on an irreversible command → deny (exit 2)");
  assert.equal(denies.length, 1, "exactly one deny message");
  assert.match(denies[0], /'merge' is an irreversible action/);
  assert.match(denies[0], /gate=ask/);
  assert.match(denies[0], /main session/, "origin is tagged");
});

// --- (2) gate=proceed / batch-confirm → allow --------------------------------

test("(2) gate=proceed → allow (exit 0), no deny", async () => {
  const denies = [];
  const code = await run({
    readStdinImpl: bashPayload("gh pr merge 123 --squash"),
    killSwitchImpl: killOff,
    resolveGateImpl: async () => ({ gate: "proceed", degraded: false }),
    env: {},
    deny: (m) => denies.push(m),
  });
  assert.equal(code, 0, "gate=proceed → allow");
  assert.equal(denies.length, 0);
});

test("(2b) gate=batch-confirm → allow (the hook only hard-blocks ask)", async () => {
  const denies = [];
  const code = await run({
    readStdinImpl: bashPayload("npm publish"),
    killSwitchImpl: killOff,
    resolveGateImpl: async () => ({ gate: "batch-confirm", degraded: false }),
    env: {},
    deny: (m) => denies.push(m),
  });
  assert.equal(code, 0, "batch-confirm is not a hard block at the hook layer");
  assert.equal(denies.length, 0);
});

// --- (3) non-target command → allow (never gates reads/edits/safe commands) ---

test("(3) non-target commands → allow without ever resolving the policy", async () => {
  for (const command of [
    "gh pr view 3",
    "gh pr list --state open",
    "gh pr create --fill",
    "git push origin feat/x", // plain push is NOT irreversible → not gated
    "git status",
    "npm test",
    "ls -la && cat README.md",
  ]) {
    let resolverCalled = false;
    const code = await run({
      readStdinImpl: bashPayload(command),
      killSwitchImpl: killOff,
      resolveGateImpl: async () => {
        resolverCalled = true;
        return { gate: "ask", degraded: false };
      },
      env: {},
    });
    assert.equal(code, 0, `${command} → allow`);
    assert.equal(resolverCalled, false, `${command} must not even consult the policy`);
  }
});

test("(3b) non-Bash payload (no command) → allow", async () => {
  const code = await run({
    readStdinImpl: async () =>
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } }),
    killSwitchImpl: killOff,
    resolveGateImpl: async () => {
      throw new Error("must not resolve for a non-command tool");
    },
    env: {},
  });
  assert.equal(code, 0, "no command string → allow (nothing to gate)");
});

// --- (4) kill-switch present → allow (no-op), before any I/O -----------------

test("(4) kill-switch present → ALLOW (exit 0), short-circuits before reading stdin", async () => {
  const warnings = [];
  let stdinRead = false;
  const code = await run({
    readStdinImpl: async () => {
      stdinRead = true;
      return bashPayload("gh pr merge 1")();
    },
    killSwitchImpl: () => true,
    resolveGateImpl: async () => ({ gate: "ask", degraded: false }),
    env: {},
    warn: (m) => warnings.push(m),
  });
  assert.equal(code, 0, "kill-switch → no-op ALLOW");
  assert.equal(stdinRead, false, "kill-switch short-circuits before any I/O");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /kill-switch/);
});

test("(4b) kill-switch check throwing → treated as not disabled → gate normally", async () => {
  const denies = [];
  const code = await run({
    readStdinImpl: bashPayload("gh pr merge 1"),
    killSwitchImpl: () => {
      throw new Error("fs error");
    },
    resolveGateImpl: async () => ({ gate: "ask", degraded: false }),
    env: {},
    deny: (m) => denies.push(m),
  });
  assert.equal(code, 2, "a broken kill-switch check must not disable enforcement");
  assert.equal(denies.length, 1);
});

// --- (5) policy unreadable/unparseable → allow (fail-open) + warn ------------

test("(5) resolver reports degraded → ALLOW (fail-open) + a warning", async () => {
  const warnings = [];
  const denies = [];
  const code = await run({
    readStdinImpl: bashPayload("gh pr merge 1"),
    killSwitchImpl: killOff,
    resolveGateImpl: async () => ({
      gate: null,
      degraded: true,
      reason: "policy.yaml unparseable",
    }),
    env: {},
    warn: (m) => warnings.push(m),
    deny: (m) => denies.push(m),
  });
  assert.equal(code, 0, "degraded policy → fail-open ALLOW (prose checkpoint still guards)");
  assert.equal(denies.length, 0, "never deny when the gate cannot be trusted");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unreadable\/unparseable/);
  assert.match(warnings[0], /fail-open/);
  assert.match(warnings[0], /policy\.yaml unparseable/);
});

test("(5b) resolver throwing → ALLOW (fail-open) + a warning", async () => {
  const warnings = [];
  const denies = [];
  const code = await run({
    readStdinImpl: bashPayload("git push --force origin main"),
    killSwitchImpl: killOff,
    resolveGateImpl: async () => {
      throw new Error("import blew up");
    },
    env: {},
    warn: (m) => warnings.push(m),
    deny: (m) => denies.push(m),
  });
  assert.equal(code, 0, "a thrown resolver must fail open, never hard-stop");
  assert.equal(denies.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /fail-open/);
});

// --- (6) `--merge`-style proceed-override context → allow --------------------

test("(6) POLICY_GUARD_PROCEED=merge → allow even though the gate would be ask", async () => {
  const warnings = [];
  const denies = [];
  let resolverCalled = false;
  const code = await run({
    readStdinImpl: bashPayload("gh pr merge 42 --squash"),
    killSwitchImpl: killOff,
    resolveGateImpl: async () => {
      resolverCalled = true;
      return { gate: "ask", degraded: false };
    },
    env: { [PROCEED_ENV]: "merge" },
    warn: (m) => warnings.push(m),
    deny: (m) => denies.push(m),
  });
  assert.equal(code, 0, "a pre-authorized action is allowed (the --merge opt-in path)");
  assert.equal(denies.length, 0);
  assert.equal(resolverCalled, false, "override short-circuits before re-resolving the gate");
  assert.ok(warnings.some((w) => /pre-authorized/.test(w)));
});

test("(6b) resolveProceedOverride: list / all / * / miss", () => {
  assert.equal(resolveProceedOverride({ [PROCEED_ENV]: "merge,publish" }, "publish"), true);
  assert.equal(resolveProceedOverride({ [PROCEED_ENV]: "merge" }, "publish"), false);
  assert.equal(resolveProceedOverride({ [PROCEED_ENV]: "all" }, "force-push"), true);
  assert.equal(resolveProceedOverride({ [PROCEED_ENV]: "*" }, "merge"), true);
  assert.equal(resolveProceedOverride({}, "merge"), false);
  assert.equal(resolveProceedOverride({ [PROCEED_ENV]: "  " }, "merge"), false);
});

// --- matcher unit coverage ---------------------------------------------------

test("matchAction detects each irreversible command", () => {
  assert.deepEqual(matchAction("gh pr merge 12"), { action: "merge", class: "irreversible" });
  assert.deepEqual(matchAction("cd x && gh   pr   merge --admin"), {
    action: "merge",
    class: "irreversible",
  });
  assert.deepEqual(matchAction("gh release create v1.2.3 --notes x"), {
    action: "release-create",
    class: "irreversible",
  });
  assert.deepEqual(matchAction("git push --force origin main"), {
    action: "force-push",
    class: "irreversible",
  });
  assert.deepEqual(matchAction("git push -f"), { action: "force-push", class: "irreversible" });
  assert.deepEqual(matchAction("git push --force-with-lease origin main"), {
    action: "force-push",
    class: "irreversible",
  });
  assert.deepEqual(matchAction("npm publish --access public"), {
    action: "publish",
    class: "irreversible",
  });
  assert.deepEqual(matchAction("pnpm publish"), { action: "publish", class: "irreversible" });
});

test("matchAction ignores safe / non-target commands", () => {
  for (const c of [
    "gh pr view 3",
    "gh pr create",
    "gh release view v1",
    "gh release list",
    "git push origin main", // plain (non-force) push is not gated
    "git status",
    "npm test",
    "npm run publish:dry", // not the `publish` subcommand
    "echo publish",
    "",
    "   ",
  ]) {
    assert.equal(matchAction(c), null, `must not gate: ${JSON.stringify(c)}`);
  }
  assert.equal(matchAction(null), null);
  assert.equal(matchAction(undefined), null);
});

// --- payload parsing ---------------------------------------------------------

test("parsePayload extracts tool_name, command and agent_id; tolerates junk", () => {
  const p = parsePayload(
    '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 1"},"agent_id":"w-7"}',
  );
  assert.equal(p.toolName, "Bash");
  assert.equal(p.command, "gh pr merge 1");
  assert.equal(p.agentId, "w-7");
  assert.deepEqual(parsePayload(""), { toolName: null, command: null, agentId: null });
  assert.deepEqual(parsePayload("not json"), { toolName: null, command: null, agentId: null });
  assert.equal(parsePayload('{"tool_name":"Bash"}').command, null, "no command → null");
});

test("run() tags the deny message with the subagent origin", async () => {
  const denies = [];
  await run({
    readStdinImpl: async () =>
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 1" },
        agent_id: "worker-7",
      }),
    killSwitchImpl: killOff,
    resolveGateImpl: async () => ({ gate: "ask", degraded: false }),
    env: {},
    deny: (m) => denies.push(m),
  });
  assert.match(denies[0], /subagent worker-7/, "deny message records the subagent origin");
});

// --- buildDenyReason ---------------------------------------------------------

test("buildDenyReason names the action, gate, opt-in env and kill-switch", () => {
  const r = buildDenyReason("merge", "ask");
  assert.match(r, /'merge'/);
  assert.match(r, /gate=ask/);
  assert.match(r, new RegExp(PROCEED_ENV));
  assert.match(r, /policy\.yaml/);
  assert.match(r, /DISABLE/);
});

// --- real resolveGate wiring against policy-read.mjs -------------------------
//
// These drive the REAL resolveGateForAction with an injected module whose
// `run` returns a hand-built effective policy (so no HOME ~/.agents/policy.yaml
// dependency) but whose resolver is policy-read's REAL resolveGate — proving the
// hook consumes policy-read's contract correctly.

test("resolveGateForAction: zero-config merge resolves to ask via real resolveGate", async () => {
  const effective = mergePolicies({}); // zero-config defaults
  const res = await resolveGateForAction(
    { action: "merge", klass: "irreversible", repoRoot: "/x" },
    {
      importImpl: async () => ({
        run: async () => ({ ...effective, degraded: false }),
        resolveGate: realResolveGate,
      }),
    },
  );
  assert.equal(res.degraded, false);
  assert.equal(res.gate, "ask", "irreversible zero-config default = ask");
});

test("resolveGateForAction: repo action override merge=proceed wins", async () => {
  const effective = mergePolicies({ repo: { actions: { merge: "proceed" } } });
  const res = await resolveGateForAction(
    { action: "merge", klass: "irreversible", repoRoot: "/x" },
    {
      importImpl: async () => ({
        run: async () => ({ ...effective, degraded: false }),
        resolveGate: realResolveGate,
      }),
    },
  );
  assert.equal(res.gate, "proceed");
});

test("resolveGateForAction: policy-read degraded → degraded passthrough (hook fails open)", async () => {
  const effective = mergePolicies({});
  const res = await resolveGateForAction(
    { action: "merge", klass: "irreversible", repoRoot: "/x" },
    {
      importImpl: async () => ({
        run: async () => ({ ...effective, degraded: true }),
        resolveGate: realResolveGate,
      }),
    },
  );
  assert.equal(res.degraded, true);
  assert.equal(res.gate, null);
});

test("resolveGateForAction: module missing run/resolveGate → degraded", async () => {
  const res = await resolveGateForAction(
    { action: "merge", klass: "irreversible", repoRoot: "/x" },
    { importImpl: async () => ({}) },
  );
  assert.equal(res.degraded, true);
  assert.match(res.reason, /missing run\/resolveGate/);
});

// --- structural: the hook extra file ships to every adapter payload ----------

test("policy-hook.mjs ships in the claude-code payload (verbatim, no rewritten self-path)", async () => {
  const script = await realReadFile(
    join(ROOT, "dist", "claude-code", ".claude", "skills", "policy", "policy-hook.mjs"),
    "utf8",
  );
  assert.match(script, /PreToolUse/, "hook extra file must ship verbatim");
  assert.doesNotMatch(
    script,
    /~\/\.claude\/skills\/policy\/policy-hook\.mjs/,
    "hook must not contain a rewritten .claude/skills/ self-path literal",
  );
});

test("policy-hook.mjs ships to EVERY adapter payload (policy is not adapter-gated)", () => {
  // policy has no `adapters:` gate → it (and its extras, incl. the hook) ships
  // to all adapters. The hook is a Claude Code convention but inert elsewhere;
  // shipping it verbatim keeps the extra-file plumbing uniform (like policy-read).
  const cases = [
    ["claude-code", join(".claude", "skills", "policy", "policy-hook.mjs")],
    ["codex-cli", join(".agents", "skills", "policy", "policy-hook.mjs")],
    ["gemini-cli", join(".agents", "skills", "policy", "policy-hook.mjs")],
    ["copilot", join(".agents", "skills", "policy", "policy-hook.mjs")],
  ];
  for (const [adapter, rel] of cases) {
    const adapterRoot = join(ROOT, "dist", adapter);
    if (!existsSync(adapterRoot)) continue;
    assert.equal(
      existsSync(join(adapterRoot, rel)),
      true,
      `policy-hook.mjs must ship to dist/${adapter}/${rel}`,
    );
  }
  // The SSOT lives under .agents/skills/policy/ (authored directly).
  assert.equal(
    existsSync(join(ROOT, ".agents", "skills", "policy", "policy-hook.mjs")),
    true,
    "policy-hook.mjs SSOT lives under .agents/skills/policy/",
  );
});
