#!/usr/bin/env node
// policy-hook — PreToolUse architecture-enforcement gate for the central
// autonomy policy (ADR-0028 R3, ozzy-labs/skills#181 PR 4/4).
//
// Wired into ~/.claude/settings.local.json as a PreToolUse hook (same wiring
// shape as usage-guard-hook.mjs), this fires BEFORE every tool call — including
// ones originating inside subagents, which carry an `agent_id` in the payload.
// It is the execution-engine side of the policy stack: the SKILL.md prose layer
// asks a skill to "classify your action and read the gate", but prose is only a
// request. This hook makes a SPECIFIC set of irreversible commands
// (`gh pr merge`, `gh release create`, `git push --force`/`-f`, `npm publish`)
// physically un-runnable when the resolved gate is `ask` — the model cannot
// talk its way past it.
//
// Detection is intentionally NARROW. The hook only pulls the policy when the
// tool call's command matches one of the irreversible matchers below; every
// other tool call (reads, edits, safe git/gh/npm, non-Bash tools) is allowed
// untouched. This is the core safety property: because we only gate on a match,
// a bug in the matcher can at worst FAIL to gate a dangerous command — it can
// never deny ALL tools and wedge the session.
//
// Decision (PreToolUse contract):
//   - matched + gate `ask` → DENY (exit 2 + a reason on stderr). Exit 2 is the
//     harness signal that blocks the call even on older harnesses that key off
//     the exit code.
//   - matched + gate `proceed`/`batch-confirm` → ALLOW (the hook only hard-
//     blocks `ask`; a batch confirmation is the caller/prose layer's job).
//   - not matched → ALLOW (exit 0, silent).
//
// Fail-open (inherited from usage-guard-hook — "never hard-stop on our own
// bug"):
//   (a) file kill-switch: if `~/.claude/policy-guard/DISABLE` exists, the hook
//       is an instant no-op ALLOW (checked FIRST, before any I/O, and itself
//       fail-open). Escape hatch for a wedged session, no settings edit needed.
//   (b) policy unreadable / unparseable (policy-read returns `degraded`, or the
//       resolver throws / is missing) → ALLOW + a stderr warning. If we cannot
//       even trust the gate, we do NOT block: the resumable prose-layer
//       checkpoint (drive / health / lessons-triage) consults the SAME
//       policy-read — which is fail-SAFE to `ask` — and is the primary gate. The
//       hook is a secondary net, so it errs open to avoid wedging the session on
//       a broken policy file.
//   (c) proceed-override: a caller that has ALREADY resolved the gate and been
//       granted autonomy (e.g. `drive --merge`, whose prose overrides merge to
//       `proceed`) exports `POLICY_GUARD_PROCEED=<action>[,<action>...]`; the
//       hook then allows that action without re-gating. This is how a legitimate
//       opt-in merge is not blocked by the enforcement net.
//
// Design-for-tests: the matcher (`matchAction`), payload parse (`parsePayload`),
// override check (`resolveProceedOverride`) and gate resolution
// (`resolveGateForAction`) are all pure/injectable, and `run()` takes every
// effect (stdin, kill-switch, gate resolver, warn/deny sinks) as a dep, so tests
// exercise the whole thing with no network, no real ~/.claude reads, no spawned
// process.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// PreToolUse "deny" is signaled to the harness with exit code 2 (stderr is
// surfaced to the model); 0 = allow. Named for clarity.
const EXIT_ALLOW = 0;
const EXIT_DENY = 2;

// File kill-switch — the escape hatch. Built with path.join (HOME-anchored) so
// no rewritable `.claude/skills/` literal appears in source (the dist user-scope
// rewrite only targets `.agents|.claude/skills/` refs; `policy-guard/` is safe).
export const DISABLE_PATH = join(homedir(), ".claude", "policy-guard", "DISABLE");

// Env var a caller sets to pre-authorize specific actions (comma-separated
// action names, or `all`/`*`). This is the `--merge`→proceed override channel:
// a caller that has already been granted autonomy names the action here so the
// enforcement net does not re-block it.
export const PROCEED_ENV = "POLICY_GUARD_PROCEED";

// Force-push flag detector: `--force`, `--force-with-lease`, or a short flag
// token containing `f` (`-f`, `-fq`, …). Anchored on a token boundary so it does
// not fire on `--foo` or a filename.
const FORCE_FLAG = /(?:--force(?:-with-lease)?\b|(?:^|\s)-[a-z]*f[a-z]*(?=\s|$))/i;

/**
 * The irreversible-command matchers. Each entry maps a command shape to the
 * central-policy action name + class the gate resolves against. The `class` is
 * passed alongside the action so `resolveGate` can fall back to the class
 * default even for an action not in policy-read's ACTION_CLASSES map (so a new
 * irreversible command still resolves to the `irreversible` default = `ask`).
 *
 * Kept deliberately short + irreversible-only (ADR-0028's "irreversible /
 * destructive" class). Reversible-local and externally-visible actions are the
 * prose layer's job — the hook does NOT gate `gh pr create`, plain `git push`,
 * etc., which keeps the "can only ever fail to gate, never deny everything"
 * property.
 * @type {ReadonlyArray<{action: string, class: string, test: (cmd: string) => boolean}>}
 */
export const IRREVERSIBLE_MATCHERS = Object.freeze([
  { action: "merge", class: "irreversible", test: (c) => /\bgh\s+pr\s+merge\b/.test(c) },
  {
    action: "release-create",
    class: "irreversible",
    test: (c) => /\bgh\s+release\s+create\b/.test(c),
  },
  {
    action: "force-push",
    class: "irreversible",
    test: (c) => /\bgit\s+push\b/.test(c) && FORCE_FLAG.test(c),
  },
  {
    action: "publish",
    class: "irreversible",
    test: (c) => /\b(?:npm|pnpm|yarn)\s+publish\b/.test(c),
  },
]);

/**
 * Classify a command string. Returns the first matching irreversible action +
 * class, or null when the command is not one the hook gates.
 * @param {string|null|undefined} command
 * @returns {{ action: string, class: string }|null}
 */
export function matchAction(command) {
  if (typeof command !== "string" || command.trim() === "") return null;
  for (const m of IRREVERSIBLE_MATCHERS) {
    if (m.test(command)) return { action: m.action, class: m.class };
  }
  return null;
}

/**
 * Read the entire hook stdin payload. Mirrors usage-guard-hook: resolves on end
 * or error, and does not hang on a TTY (nothing piped).
 * @param {NodeJS.ReadableStream} [stream]
 * @returns {Promise<string>}
 */
export function readStdin(stream = process.stdin) {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk) => {
      data += chunk;
    });
    stream.on("end", done);
    stream.on("error", done);
    if (stream.isTTY) done();
  });
}

/**
 * Parse the PreToolUse payload for the fields the hook needs: the tool name, the
 * Bash command string (`tool_input.command`), and `agent_id` (present for
 * subagent-originated calls) for logging. Tolerates empty / malformed input.
 * @param {string} raw
 * @returns {{ toolName: string|null, command: string|null, agentId: string|null }}
 */
export function parsePayload(raw) {
  if (!raw?.trim()) return { toolName: null, command: null, agentId: null };
  try {
    const obj = JSON.parse(raw);
    const toolName =
      typeof obj?.tool_name === "string"
        ? obj.tool_name
        : typeof obj?.toolName === "string"
          ? obj.toolName
          : null;
    const input = obj?.tool_input ?? obj?.toolInput ?? {};
    const command = typeof input?.command === "string" ? input.command : null;
    const agentId = obj?.agent_id ?? obj?.agentId ?? null;
    return { toolName, command, agentId: typeof agentId === "string" ? agentId : null };
  } catch {
    return { toolName: null, command: null, agentId: null };
  }
}

/**
 * Whether the caller pre-authorized `action` via the proceed-override env var.
 * The value is a comma-separated list of action names; `all` / `*` authorize
 * everything. Missing/blank → not authorized.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} action
 * @returns {boolean}
 */
export function resolveProceedOverride(env, action) {
  const raw = env?.[PROCEED_ENV];
  if (!raw || typeof raw !== "string") return false;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(action) || list.includes("all") || list.includes("*");
}

/**
 * Resolve the effective gate for one {action, class} against the central policy
 * by importing the sibling policy-read.mjs and reusing ITS reader (`run`) +
 * ITS resolver (`resolveGate`) — no policy logic is duplicated here. Returns a
 * shape the hook interprets:
 *   - { gate, degraded: false }            → a trusted gate token
 *   - { gate: null, degraded: true, reason } → could not trust a gate (module
 *       missing/broken, or policy-read reported `degraded`); caller fails open.
 *
 * A dynamic import (not static) is deliberate: an install missing a healthy
 * policy-read must degrade (→ fail open) rather than crash the hook at load.
 * @param {{ action: string, klass: string, repoRoot: string }} query
 * @param {{ importImpl?: (u: string) => Promise<unknown> }} [deps]
 * @returns {Promise<{ gate: string|null, degraded: boolean, reason?: string, source?: string }>}
 */
export async function resolveGateForAction({ action, klass, repoRoot }, { importImpl } = {}) {
  const imp = importImpl ?? ((u) => import(u));
  const url = new URL("./policy-read.mjs", import.meta.url).href;
  const mod = await imp(url);
  if (!mod || typeof mod.run !== "function" || typeof mod.resolveGate !== "function") {
    return { gate: null, degraded: true, reason: "policy-read missing run/resolveGate" };
  }
  const effective = await mod.run(["--repo-root", repoRoot]);
  if (!effective || effective.degraded === true) {
    return { gate: null, degraded: true, reason: "policy unreadable/unparseable (degraded)" };
  }
  const resolved = mod.resolveGate(effective, { action, class: klass });
  if (!resolved || typeof resolved.gate !== "string") {
    return { gate: null, degraded: true, reason: "gate could not be resolved" };
  }
  return { gate: resolved.gate, degraded: false, source: resolved.source };
}

/**
 * Build the deny reason for a gated action. Names the action, the gate, and the
 * three ways to proceed (opt-in env, edit policy, or the kill-switch).
 * @param {string} action
 * @param {string} gate
 * @returns {string}
 */
export function buildDenyReason(action, gate) {
  return (
    `policy-guard: '${action}' is an irreversible action gated by the central autonomy policy ` +
    `(gate=${gate}). Tool call blocked pending explicit approval. To authorize: set ` +
    `${PROCEED_ENV}=${action} for a pre-approved run (e.g. drive --merge), relax the gate in ` +
    `~/.agents/policy.yaml, or touch ${DISABLE_PATH} to disable the hook.`
  );
}

/**
 * Run the hook end to end. Returns the intended exit code (the CLI wrapper
 * applies it). Every effect goes through an injected dep so tests assert without
 * spawning a process or touching the network / real ~/.claude.
 *
 * @param {object} [deps]
 * @param {() => Promise<string>} [deps.readStdinImpl]
 * @param {() => boolean} [deps.killSwitchImpl]   // true → hook disabled (no-op)
 * @param {(command: string|null) => ({action:string,class:string}|null)} [deps.matchActionImpl]
 * @param {(q: {action:string,klass:string,repoRoot:string}) => Promise<{gate:string|null,degraded:boolean,reason?:string}>} [deps.resolveGateImpl]
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {string} [deps.cwd]
 * @param {(msg: string) => void} [deps.warn]
 * @param {(msg: string) => void} [deps.deny]
 * @returns {Promise<number>} exit code (0 allow / 2 deny)
 */
export async function run({
  readStdinImpl = () => readStdin(),
  killSwitchImpl = () => existsSync(DISABLE_PATH),
  matchActionImpl = matchAction,
  resolveGateImpl = resolveGateForAction,
  env = process.env,
  cwd = process.cwd(),
  warn = (msg) => process.stderr.write(`${msg}\n`),
  deny = (msg) => process.stderr.write(`${msg}\n`),
} = {}) {
  // (a) File kill-switch — checked FIRST, before any I/O, and itself fail-open
  // (a check error → treated as not disabled → continue normally).
  let disabled = false;
  try {
    disabled = !!killSwitchImpl();
  } catch {
    disabled = false;
  }
  if (disabled) {
    warn(`policy-guard hook: disabled via kill-switch (${DISABLE_PATH}); allowing (no-op)`);
    return EXIT_ALLOW;
  }

  const { command, agentId } = parsePayload(await readStdinImpl());
  const origin = agentId ? `subagent ${agentId}` : "main session";

  // Narrow gating: only pull the policy for a matched irreversible command.
  // Everything else is allowed untouched (the "never deny all tools" property).
  const matched = matchActionImpl(command);
  if (!matched) return EXIT_ALLOW;

  // (c) proceed-override: a caller already granted autonomy for this action
  // (e.g. drive --merge overriding merge→proceed) named it in the env var.
  if (resolveProceedOverride(env, matched.action)) {
    warn(
      `policy-guard hook: '${matched.action}' pre-authorized via ${PROCEED_ENV} (${origin}); allowing.`,
    );
    return EXIT_ALLOW;
  }

  // Resolve the gate. Any failure to obtain a TRUSTED gate → fail open + warn.
  let gateResult;
  try {
    gateResult = await resolveGateImpl({
      action: matched.action,
      klass: matched.class,
      repoRoot: cwd,
    });
  } catch (err) {
    warn(
      `policy-guard hook: gate resolution failed (${err?.message ?? err}) (${origin}); allowing (fail-open) — the prose-layer checkpoint still guards.`,
    );
    return EXIT_ALLOW;
  }
  // (b) policy unreadable / unparseable / unresolvable → fail open + warn.
  if (!gateResult || gateResult.degraded === true || typeof gateResult.gate !== "string") {
    const why = gateResult?.reason ? ` (${gateResult.reason})` : "";
    warn(
      `policy-guard hook: policy unreadable/unparseable${why} (${origin}); allowing (fail-open) — the prose-layer checkpoint still guards.`,
    );
    return EXIT_ALLOW;
  }

  // The hook only HARD-blocks `ask`. `proceed` / `batch-confirm` → allow (a
  // batch confirmation belongs to the caller / prose layer, not this net).
  if (gateResult.gate === "ask") {
    deny(`${buildDenyReason(matched.action, gateResult.gate)} [origin: ${origin}]`);
    return EXIT_DENY;
  }
  return EXIT_ALLOW;
}

// CLI entry — only when executed directly (not when imported by tests).
const __isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (__isMain) {
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      // Any unexpected error in the hook itself must fail open, never block.
      process.stderr.write(
        `policy-guard hook: fatal ${err?.message ?? err}; allowing (fail-open)\n`,
      );
      process.exitCode = EXIT_ALLOW;
    });
}
