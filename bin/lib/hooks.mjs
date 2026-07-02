// `skills hooks add|remove|status` — wire, unwire, or inspect the optional
// Claude Code hooks that ship as extra files inside a skill directory
// (ozzy-labs/skills#174 PR 1 = add/remove, PR 2 = status + permissions,
// PR 3 = the policy PreToolUse gate).
//
// Three hooks are opt-in today and require a hand-written absolute path in
// settings: usage-guard's PreToolUse ceiling (`usage-guard-hook.mjs`),
// skill-observability's SessionEnd capture (`obs-derive.mjs`), and the central
// autonomy policy's PreToolUse enforcement gate (`policy-hook.mjs`, matcher "*"
// — narrow-gated to irreversible Bash commands like `gh pr merge`, so a non-Bash
// tool call carries no command and is allowed untouched). This verb resolves the
// script's absolute path from the installed skill directory and read-modify-
// writes it into `~/.claude/settings.local.json` (or `settings.json` with
// `--scope=user`), so the user never hand-copies a path. It only ever touches the
// entries it owns (identified by the script filename in the `command`), preserves
// every other entry byte-for-byte, and refuses to overwrite a settings file it
// cannot parse. The repo still ships no settings/hooks — the CLI just writes local
// settings on explicit user consent (same dry-run / diff / confirm UX as `remove`).
//
// PR 2 adds two things on top of that core (#174):
//   - `hooks status`: scans both settings files and reports, per hook, whether it
//     is wired. For a wired usage-guard it runs `usage-check.mjs` once and
//     diagnoses the `source` — `endpoint`/`cache` mean the guard is effective,
//     `jsonl`/`fail-open` mean it has silently degraded to a no-op (the exact
//     failure usage-guard's own SKILL.md §環境要件 warns about).
//   - permissions suggestion: `hooks add usage-guard` also proposes the
//     permissions allowlist the endpoint path needs (`~/.claude/.credentials.json`
//     Read + `node …/usage-check.mjs` exec), folded into the same diff. It is a
//     non-destructive append to `permissions.allow`; `--no-permissions` opts out
//     and still wires the hook.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseFlags } from "./args.mjs";
import { didYouMean } from "./detect.mjs";
import { findPackageRoot } from "./install.mjs";
import { readInstalled } from "./installed.mjs";
import { confirm } from "./prompt.mjs";

// The hook definition table. `skill` is the installed skill directory name that
// carries `script`; `event` + `matcher` describe the Claude Code settings entry.
// SessionEnd entries carry no matcher (matcher: null → omitted from the entry).
export const HOOK_DEFS = {
  "usage-guard": {
    skill: "usage-guard",
    event: "PreToolUse",
    matcher: "*",
    script: "usage-guard-hook.mjs",
  },
  observability: {
    skill: "skill-observability",
    event: "SessionEnd",
    matcher: null,
    script: "obs-derive.mjs",
  },
  // Central autonomy policy PreToolUse enforcement gate (ADR-0028 R3). Same
  // wiring shape as usage-guard (PreToolUse, matcher "*"), a DIFFERENT script,
  // so both can coexist as sibling PreToolUse entries — `addHookEntry`
  // disambiguates by the script filename in the `command`. The hook itself is
  // narrow-gated to irreversible Bash commands, so matcher "*" is safe (a
  // non-Bash tool call has no command and passes through).
  policy: {
    skill: "policy",
    event: "PreToolUse",
    matcher: "*",
    script: "policy-hook.mjs",
  },
};

const HOOK_NAMES = Object.keys(HOOK_DEFS);

// Hooks that `status` lists as forward-looking but that are not wireable yet.
// Empty now that the policy PreToolUse gate is wireable (#174 PR 3); the
// constant stays so `status` keeps rendering the (currently empty) planned
// section without a code change when the next planned hook is queued.
export const PLANNED_HOOK_NAMES = [];

const HELP = `npx @ozzylabs/skills hooks <add|remove|status> [<${HOOK_NAMES.join("|")}>] [options]

Wire, unwire, or inspect the optional Claude Code hooks shipped with a skill. A
hook script's absolute path is resolved from the installed skill dir and written
into your local Claude settings. Only entries this CLI owns are ever modified.

Actions:
  add <name>      Wire a hook. For usage-guard, also suggests (in the same diff)
                  the permissions allowlist the endpoint path needs; opt out with
                  --no-permissions and the hook is still wired.
  remove <name>   Remove only the hook entry this CLI wrote.
  status          Report each hook's wiring state. For a wired usage-guard, run
                  usage-check.mjs once and diagnose whether the guard is effective
                  (source endpoint/cache) or has degraded to a no-op (jsonl/
                  fail-open). Read-only — never writes settings.

Hooks:
  usage-guard     PreToolUse ceiling (usage-guard-hook.mjs, matcher "*").
  observability   SessionEnd capture (obs-derive.mjs).
  policy          PreToolUse autonomy-policy gate (policy-hook.mjs, matcher "*";
                  narrow-gated to irreversible commands like gh pr merge).

Options:
  --scope=<user|local>  Settings file to edit (add/remove): 'local' →
                        settings.local.json (default), 'user' → settings.json.
  --no-permissions      (add usage-guard) Skip the permissions allowlist
                        suggestion; wire the hook only.
  --dry-run             Print the diff + JSON plan and exit. Writes nothing.
  --yes                 Skip the confirmation prompt (required non-interactively).
  -h, --help            Show this help.
`;

const SCHEMA = {
  scope: "string",
  "dry-run": "boolean",
  "no-permissions": "boolean",
  yes: "boolean",
  help: "boolean",
};
const ALIASES = { h: "help" };

/** The absolute command string written into settings for a resolved script. */
export function buildCommand(scriptPath) {
  return `node ${scriptPath}`;
}

/** True when a settings `command` string invokes our hook script (by filename). */
function commandReferencesScript(command, scriptName) {
  return typeof command === "string" && command.includes(scriptName);
}

/**
 * Resolve the absolute path of a hook's script from the first scope root that has
 * the owning skill installed. Two layouts are honored:
 *   1. marker-verified installs (user-scope `add`) — the skill dir carries a
 *      provenance marker, so `readInstalled` finds it.
 *   2. build-output layout (dogfooding inside skills/commons, or a project-scope
 *      `--target` payload) — `<root>/.claude/skills/<skill>/<script>` exists but
 *      carries no marker; accepted as a direct fallback.
 * Returns null when no root has the script (caller surfaces an install hint).
 *
 * @param {string[]} scopeRoots
 * @param {{ skill: string, script: string }} def
 * @returns {Promise<string | null>}
 */
export async function resolveScriptPath(scopeRoots, def) {
  for (const root of scopeRoots) {
    // (1) marker-verified install.
    const installed = await readInstalled(root);
    const entry = installed.get(def.skill);
    if (entry) {
      for (const dir of entry.dirs) {
        const scriptPath = join(dir, def.script);
        if (existsSync(scriptPath)) return scriptPath;
      }
    }
    // (2) build-output layout fallback (no marker).
    const direct = join(root, ".claude", "skills", def.skill, def.script);
    if (existsSync(direct)) return direct;
  }
  return null;
}

/**
 * Pure: return a new settings object with the hook entry added, plus whether it
 * changed. Idempotent — if the event bucket already has an entry invoking our
 * script (any path / env prefix), nothing is added.
 *
 * @param {object} settings
 * @param {{ event: string, matcher: string | null, script: string }} def
 * @param {string} command
 * @returns {{ settings: object, changed: boolean }}
 */
export function addHookEntry(settings, def, command) {
  const next = structuredClone(settings);
  if (!next.hooks || typeof next.hooks !== "object" || Array.isArray(next.hooks)) {
    next.hooks = {};
  }
  if (!Array.isArray(next.hooks[def.event])) next.hooks[def.event] = [];
  const bucket = next.hooks[def.event];

  for (const group of bucket) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (const h of group.hooks) {
      if (commandReferencesScript(h?.command, def.script)) {
        return { settings, changed: false }; // already wired — idempotent skip
      }
    }
  }

  const hookEntry = { type: "command", command };
  const entry = def.matcher
    ? { matcher: def.matcher, hooks: [hookEntry] }
    : { hooks: [hookEntry] };
  bucket.push(entry);
  return { settings: next, changed: true };
}

/**
 * Pure: return a new settings object with only OUR hook entries removed (matched
 * by the script filename in the `command`). Groups we empty are dropped; every
 * other group — including pre-existing empty ones and other hooks in a shared
 * group — is preserved untouched.
 *
 * @param {object} settings
 * @param {{ event: string, script: string }} def
 * @returns {{ settings: object, changed: boolean }}
 */
export function removeHookEntry(settings, def) {
  const bucket = settings?.hooks?.[def.event];
  if (!Array.isArray(bucket)) return { settings, changed: false };

  const next = structuredClone(settings);
  let changed = false;
  const kept = [];
  for (const group of next.hooks[def.event]) {
    if (!group || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const before = group.hooks.length;
    const remaining = group.hooks.filter((h) => !commandReferencesScript(h?.command, def.script));
    if (remaining.length === before) {
      kept.push(group); // untouched — preserve exactly
      continue;
    }
    changed = true;
    if (remaining.length > 0) kept.push({ ...group, hooks: remaining });
    // else: we emptied this group → drop it
  }

  if (!changed) return { settings, changed: false };
  if (kept.length === 0) {
    delete next.hooks[def.event];
    if (Object.keys(next.hooks).length === 0) delete next.hooks;
  } else {
    next.hooks[def.event] = kept;
  }
  return { settings: next, changed: true };
}

/**
 * Build the permissions allowlist rules the usage-guard endpoint path needs
 * (usage-guard SKILL.md §環境要件): a Read of the OAuth credentials file and a
 * Bash exec of the usage-check script. Claude Code permission rule syntax:
 *   - absolute file reads use a DOUBLE-slash prefix → `Read(//abs/path)`
 *   - Bash rules are command prefixes with a `:*` "any trailing args" suffix.
 *
 * @param {{ credentialsPath: string, usageCheckPath: string }} paths
 * @returns {string[]}
 */
export function buildUsagePermissionRules({ credentialsPath, usageCheckPath }) {
  return [`Read(/${credentialsPath})`, `Bash(node ${usageCheckPath}:*)`];
}

/**
 * Pure: non-destructively append permission rules to `permissions.allow`.
 * Idempotent — a rule already present (byte-for-byte) is skipped. `deny`/`ask`
 * and every existing allow entry are preserved untouched.
 *
 * @param {object} settings
 * @param {string[]} rules
 * @returns {{ settings: object, changed: boolean, added: string[] }}
 */
export function addPermissionEntries(settings, rules) {
  const next = structuredClone(settings);
  if (!next.permissions || typeof next.permissions !== "object" || Array.isArray(next.permissions)) {
    next.permissions = {};
  }
  if (!Array.isArray(next.permissions.allow)) next.permissions.allow = [];
  const allow = next.permissions.allow;
  const added = [];
  for (const rule of rules) {
    if (!allow.includes(rule)) {
      allow.push(rule);
      added.push(rule);
    }
  }
  if (added.length === 0) return { settings, changed: false, added: [] };
  return { settings: next, changed: true, added };
}

/**
 * Classify a usage-check `source` for the status diagnosis. `endpoint`/`cache`
 * mean the guard is reading the real OAuth signal (effective); `jsonl`/
 * `fail-open` mean it has degraded to a coarse estimate or a no-op — the exact
 * silent-OFF failure usage-guard's §環境要件 warns about. Anything else is
 * unknown.
 *
 * @param {string|null|undefined} source
 * @returns {{ effective: boolean|null, symbol: string, label: string }}
 */
export function classifyUsageSource(source) {
  if (source === "endpoint" || source === "cache") {
    return { effective: true, symbol: "✅", label: `guard is effective (source=${source})` };
  }
  if (source === "jsonl" || source === "fail-open") {
    return {
      effective: false,
      symbol: "⚠️",
      label: `guard is DEGRADED (source=${source}) — endpoint path unavailable; see usage-guard SKILL.md §環境要件 (endpoint 経路が使えること)`,
    };
  }
  return {
    effective: null,
    symbol: "?",
    label: source ? `unknown source '${source}'` : "could not determine source",
  };
}

/** Find the command string that wires `def` in `settings`, or null. */
function findWiredCommand(settings, def) {
  const bucket = settings?.hooks?.[def.event];
  if (!Array.isArray(bucket)) return null;
  for (const group of bucket) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (const h of group.hooks) {
      if (commandReferencesScript(h?.command, def.script)) return h.command;
    }
  }
  return null;
}

/**
 * Diagnose the usage-check `source` for `hooks status`. Runs `node <scriptPath>`
 * once and parses the last JSON line's `source`. A fixture JSON can be injected
 * via `OZZYLABS_SKILLS_USAGE_CHECK_JSON` (bypasses the spawn) so status is
 * diagnosable without touching the real endpoint / credentials — used by tests
 * and as a manual override. Any failure resolves to `{ source: null }` so status
 * stays read-only and never throws.
 *
 * @param {{ scriptPath: string|null, env?: NodeJS.ProcessEnv, spawnImpl?: Function }} opts
 * @returns {{ source: string|null, error?: string }}
 */
export function diagnoseUsageSource({ scriptPath, env = process.env, spawnImpl = spawnSync }) {
  const fixture = env?.OZZYLABS_SKILLS_USAGE_CHECK_JSON;
  if (fixture !== undefined && fixture !== "") {
    try {
      return { source: JSON.parse(fixture)?.source ?? null };
    } catch {
      return { source: null, error: "invalid OZZYLABS_SKILLS_USAGE_CHECK_JSON fixture" };
    }
  }
  if (!scriptPath) return { source: null, error: "usage-check.mjs not found" };
  try {
    const res = spawnImpl("node", [scriptPath], { encoding: "utf8", timeout: 15_000, env });
    if (res?.error) return { source: null, error: res.error.message };
    const lines = String(res?.stdout ?? "")
      .trim()
      .split("\n")
      .filter(Boolean);
    if (lines.length === 0) return { source: null, error: "no usage-check output" };
    return { source: JSON.parse(lines[lines.length - 1])?.source ?? null };
  } catch (err) {
    return { source: null, error: err.message };
  }
}

/**
 * Minimal LCS line diff. Returns `+`/`-`/`  ` prefixed lines (the caller filters
 * to changed lines for display). Dependency-free — settings files are small.
 *
 * @param {string} before
 * @param {string} after
 * @returns {string[]}
 */
export function diffLines(before, after) {
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < m) out.push(`- ${a[i++]}`);
  while (j < n) out.push(`+ ${b[j++]}`);
  return out;
}

/** Read + validate the settings file. Returns { settings } or { error }. */
async function readSettings(settingsFile) {
  if (!existsSync(settingsFile)) return { settings: {} };
  let raw;
  try {
    raw = await readFile(settingsFile, "utf8");
  } catch (err) {
    return { error: `cannot read ${settingsFile}: ${err.message}` };
  }
  if (raw.trim().length === 0) return { settings: {} };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      error: `${settingsFile} is not valid JSON — refusing to overwrite. Fix it by hand and retry.`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `${settingsFile} does not contain a JSON object — refusing to overwrite.` };
  }
  return { settings: parsed };
}

/**
 * @param {string[]} argv args past the `hooks` subcommand keyword
 * @param {{ isTTY?: boolean, scopeRoots?: string[] }} [opts] `scopeRoots` overrides
 *   the resolution roots (tests inject an empty root to exercise the not-installed
 *   path, which the dogfood build-output fallback would otherwise always resolve).
 * @returns {Promise<number>} exit code
 */
export async function runHooks(argv, opts = {}) {
  let parsed;
  try {
    parsed = parseFlags(argv, SCHEMA, ALIASES);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n\n${HELP}`);
    return 1;
  }
  if (parsed.values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const positionals = parsed.rejected.filter((a) => !a.startsWith("-"));
  const unknownFlags = parsed.rejected.filter((a) => a.startsWith("-"));
  if (unknownFlags.length > 0) {
    process.stderr.write(`error: unknown argument(s): ${unknownFlags.join(", ")}\n\n${HELP}`);
    return 1;
  }

  const [action, name] = positionals;
  if (action !== "add" && action !== "remove" && action !== "status") {
    process.stderr.write(
      `error: expected 'add', 'remove', or 'status'${action ? ` (got '${action}')` : ""}\n\n${HELP}`,
    );
    return 1;
  }

  const base = process.env.OZZYLABS_SKILLS_HOME ?? homedir();

  // `status` takes no hook name and never writes — dispatch before the
  // name/def/scope validation the mutating actions need.
  if (action === "status") {
    return await runStatus({ base, opts, env: process.env });
  }

  if (!name) {
    process.stderr.write(`error: hooks ${action} requires a hook name (${HOOK_NAMES.join(" | ")})\n`);
    return 1;
  }
  const def = HOOK_DEFS[name];
  if (!def) {
    process.stderr.write(
      `error: unknown hook '${name}'${didYouMean(name, HOOK_NAMES)} (choose from: ${HOOK_NAMES.join(", ")})\n`,
    );
    return 1;
  }

  const scope = parsed.values.scope ?? "local";
  if (scope !== "user" && scope !== "local") {
    process.stderr.write(`error: --scope must be 'user' or 'local' (got '${scope}')\n`);
    return 1;
  }

  const claudeDir = join(base, ".claude");
  const settingsFile = join(claudeDir, scope === "user" ? "settings.json" : "settings.local.json");

  const read = await readSettings(settingsFile);
  if (read.error) {
    process.stderr.write(`error: ${read.error}\n`);
    return 1;
  }
  const currentSettings = read.settings;

  let command = null;
  let permissionsAdded = [];
  let result;
  if (action === "add") {
    const scopeRoots = await resolveScopeRoots(base, opts);
    const scriptPath = await resolveScriptPath(scopeRoots, def);
    if (!scriptPath) {
      process.stderr.write(
        `error: '${def.skill}' is not installed — run \`npx @ozzylabs/skills add --skills=${def.skill}\` first.\n`,
      );
      return 1;
    }
    command = buildCommand(scriptPath);
    const hookRes = addHookEntry(currentSettings, def, command);
    let working = hookRes.settings;
    let permsChanged = false;
    // usage-guard also proposes the permissions allowlist its endpoint path needs
    // (credentials Read + node exec, per §環境要件) folded into the same diff.
    // Non-destructive + idempotent; `--no-permissions` opts out yet still wires
    // the hook (#174 PR 2).
    if (name === "usage-guard" && !parsed.values["no-permissions"]) {
      const rules = buildUsagePermissionRules({
        credentialsPath: join(base, ".claude", ".credentials.json"),
        usageCheckPath: join(dirname(scriptPath), "usage-check.mjs"),
      });
      const permsRes = addPermissionEntries(working, rules);
      working = permsRes.settings;
      permsChanged = permsRes.changed;
      permissionsAdded = permsRes.added;
    }
    result = { settings: working, changed: hookRes.changed || permsChanged };
  } else {
    result = removeHookEntry(currentSettings, def);
  }

  if (!result.changed) {
    process.stdout.write(
      action === "add"
        ? `Hook '${name}' (${def.event}) is already wired in ${settingsFile}. Nothing to do.\n`
        : `Hook '${name}' (${def.event}) is not present in ${settingsFile}. Nothing to do.\n`,
    );
    return 0;
  }

  const beforeStr = JSON.stringify(currentSettings, null, 2);
  const afterStr = JSON.stringify(result.settings, null, 2);
  const diff = diffLines(beforeStr, afterStr)
    .filter((l) => l.startsWith("+") || l.startsWith("-"))
    .join("\n");

  const permBlock =
    permissionsAdded.length > 0
      ? `\n  + permissions.allow (suggested — --no-permissions to skip; declining still wires the hook):\n${permissionsAdded
          .map((r) => `      ${r}`)
          .join("\n")}`
      : "";
  const header =
    action === "add"
      ? `hooks add ${name} → ${settingsFile}\n  + ${def.event}${def.matcher ? ` (matcher: ${def.matcher})` : ""}: ${command}${permBlock}`
      : `hooks remove ${name} → ${settingsFile}\n  - ${def.event} entries referencing ${def.script}`;
  process.stdout.write(`${header}\n\nDiff:\n${diff}\n`);

  const summary = {
    action,
    name,
    event: def.event,
    settings_file: settingsFile,
    ...(command ? { command } : {}),
    ...(permissionsAdded.length > 0 ? { permissions_added: permissionsAdded } : {}),
    changed: true,
  };

  if (parsed.values["dry-run"]) {
    process.stdout.write(`${JSON.stringify({ ...summary, dry_run: true }, null, 2)}\n`);
    return 0;
  }

  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);
  if (!parsed.values.yes) {
    if (!isTTY) {
      process.stderr.write("error: refusing to modify settings non-interactively — pass --yes.\n");
      return 1;
    }
    const ok = await confirm("Proceed?", false);
    if (!ok) {
      process.stdout.write("Aborted.\n");
      return 0;
    }
  }

  await mkdir(claudeDir, { recursive: true });
  await writeFile(settingsFile, `${afterStr}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

/** Resolve the roots `resolveScriptPath` scans (tests may inject `scopeRoots`). */
async function resolveScopeRoots(base, opts) {
  if (opts.scopeRoots) return opts.scopeRoots;
  const packageRoot = await findPackageRoot().catch(() => null);
  return packageRoot ? [base, packageRoot] : [base];
}

/**
 * Resolve the usage-check.mjs the status diagnosis should run: prefer the sibling
 * of the actually-wired usage-guard-hook.mjs (so it matches the wired install
 * byte-for-byte), else fall back to normal skill-dir resolution.
 *
 * @param {string|null} wiredCommand the wired PreToolUse command string
 * @param {string[]} scopeRoots
 * @returns {Promise<string|null>}
 */
async function resolveUsageCheckPath(wiredCommand, scopeRoots) {
  const m = /(\S*usage-guard-hook\.mjs)/.exec(wiredCommand ?? "");
  if (m) {
    const sibling = join(dirname(m[1]), "usage-check.mjs");
    if (existsSync(sibling)) return sibling;
  }
  return await resolveScriptPath(scopeRoots, { skill: "usage-guard", script: "usage-check.mjs" });
}

/**
 * `hooks status` — read-only wiring report. Scans both settings files, reports
 * per-hook wiring, and for a wired usage-guard runs usage-check.mjs once to
 * diagnose whether the guard is effective (endpoint/cache) or degraded
 * (jsonl/fail-open). Never writes settings.
 *
 * @param {{ base: string, opts: object, env: NodeJS.ProcessEnv }} ctx
 * @returns {Promise<number>} exit code (always 0 — read-only)
 */
async function runStatus({ base, opts, env }) {
  const claudeDir = join(base, ".claude");
  const files = [
    { label: "settings.local.json", path: join(claudeDir, "settings.local.json") },
    { label: "settings.json", path: join(claudeDir, "settings.json") },
  ];
  const loaded = [];
  for (const f of files) {
    const r = await readSettings(f.path);
    // Read-only diagnostic: a parse error is noted, not fatal (unlike the
    // mutating actions, which refuse to overwrite an unparseable file).
    loaded.push({ ...f, settings: r.error ? {} : r.settings, error: r.error });
  }

  const rows = [];
  for (const hookName of HOOK_NAMES) {
    const def = HOOK_DEFS[hookName];
    let wiredIn = null;
    let command = null;
    for (const f of loaded) {
      const cmd = findWiredCommand(f.settings, def);
      if (cmd) {
        wiredIn = f.label;
        command = cmd;
        break;
      }
    }
    rows.push({ name: hookName, event: def.event, wired: Boolean(command), settings_file: wiredIn, command });
  }

  // usage-guard source diagnosis (only when wired).
  let diagnosis = null;
  const ug = rows.find((r) => r.name === "usage-guard");
  if (ug?.wired) {
    const scopeRoots = await resolveScopeRoots(base, opts);
    const usageCheckPath = await resolveUsageCheckPath(ug.command, scopeRoots);
    diagnosis = diagnoseUsageSource({ scriptPath: usageCheckPath, env });
  }

  // ── render (human-readable) ─────────────────────────────────────────────────
  const out = [`Hook wiring status — ${claudeDir}`, ""];
  for (const row of rows) {
    if (row.wired) {
      out.push(`  ${row.name.padEnd(14)}(${row.event}) ✅ wired [${row.settings_file}]`);
      if (row.name === "usage-guard" && diagnosis) {
        const c = classifyUsageSource(diagnosis.source);
        out.push(`      usage-check: ${c.symbol} ${c.label}`);
      }
    } else {
      out.push(
        `  ${row.name.padEnd(14)}(${row.event}) ✗ not wired — \`npx @ozzylabs/skills hooks add ${row.name}\``,
      );
    }
  }
  for (const planned of PLANNED_HOOK_NAMES) {
    out.push(`  ${planned.padEnd(14)}(planned)    — not yet available`);
  }
  for (const f of loaded.filter((x) => x.error)) {
    out.push(`  note: ${f.label} unreadable — ${f.error}`);
  }
  process.stdout.write(`${out.join("\n")}\n\n`);

  // ── machine-readable summary ────────────────────────────────────────────────
  const summary = {
    action: "status",
    base: claudeDir,
    hooks: rows.map((r) => ({
      name: r.name,
      event: r.event,
      wired: r.wired,
      ...(r.settings_file ? { settings_file: r.settings_file } : {}),
      ...(r.name === "usage-guard" && diagnosis
        ? {
            usage_source: diagnosis.source,
            usage_effective: classifyUsageSource(diagnosis.source).effective,
          }
        : {}),
    })),
    planned: PLANNED_HOOK_NAMES,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

export { HELP };
