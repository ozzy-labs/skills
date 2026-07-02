// `skills hooks add|remove` — wire the optional Claude Code hooks that ship as
// extra files inside a skill directory (ozzy-labs/skills#174 PR 1).
//
// Two hooks are opt-in today and require a hand-written absolute path in
// settings: usage-guard's PreToolUse ceiling (`usage-guard-hook.mjs`) and
// skill-observability's SessionEnd capture (`obs-derive.mjs`). This verb resolves
// the script's absolute path from the installed skill directory and read-modify-
// writes it into `~/.claude/settings.local.json` (or `settings.json` with
// `--scope=user`), so the user never hand-copies a path. It only ever touches the
// entries it owns (identified by the script filename in the `command`), preserves
// every other entry byte-for-byte, and refuses to overwrite a settings file it
// cannot parse. The repo still ships no settings/hooks — the CLI just writes local
// settings on explicit user consent (same dry-run / diff / confirm UX as `remove`).

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
};

const HOOK_NAMES = Object.keys(HOOK_DEFS);

const HELP = `npx @ozzylabs/skills hooks <add|remove> <${HOOK_NAMES.join("|")}> [options]

Wire (or unwire) an optional Claude Code hook shipped with a skill. The hook
script's absolute path is resolved from the installed skill dir and written into
your local Claude settings. Only entries this CLI owns are ever modified.

Hooks:
  usage-guard     PreToolUse ceiling (usage-guard-hook.mjs, matcher "*").
  observability   SessionEnd capture (obs-derive.mjs).

Options:
  --scope=<user|local>  Settings file to edit: 'local' → settings.local.json
                        (default), 'user' → settings.json.
  --dry-run             Print the diff + JSON plan and exit. Writes nothing.
  --yes                 Skip the confirmation prompt (required non-interactively).
  -h, --help            Show this help.
`;

const SCHEMA = {
  scope: "string",
  "dry-run": "boolean",
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
  if (action !== "add" && action !== "remove") {
    process.stderr.write(
      `error: expected 'add' or 'remove'${action ? ` (got '${action}')` : ""}\n\n${HELP}`,
    );
    return 1;
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

  const base = process.env.OZZYLABS_SKILLS_HOME ?? homedir();
  const claudeDir = join(base, ".claude");
  const settingsFile = join(claudeDir, scope === "user" ? "settings.json" : "settings.local.json");

  const read = await readSettings(settingsFile);
  if (read.error) {
    process.stderr.write(`error: ${read.error}\n`);
    return 1;
  }
  const currentSettings = read.settings;

  let command = null;
  let result;
  if (action === "add") {
    let scopeRoots = opts.scopeRoots;
    if (!scopeRoots) {
      const packageRoot = await findPackageRoot().catch(() => null);
      scopeRoots = packageRoot ? [base, packageRoot] : [base];
    }
    const scriptPath = await resolveScriptPath(scopeRoots, def);
    if (!scriptPath) {
      process.stderr.write(
        `error: '${def.skill}' is not installed — run \`npx @ozzylabs/skills add --skills=${def.skill}\` first.\n`,
      );
      return 1;
    }
    command = buildCommand(scriptPath);
    result = addHookEntry(currentSettings, def, command);
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

  const header =
    action === "add"
      ? `hooks add ${name} → ${settingsFile}\n  + ${def.event}${def.matcher ? ` (matcher: ${def.matcher})` : ""}: ${command}`
      : `hooks remove ${name} → ${settingsFile}\n  - ${def.event} entries referencing ${def.script}`;
  process.stdout.write(`${header}\n\nDiff:\n${diff}\n`);

  const summary = {
    action,
    name,
    event: def.event,
    settings_file: settingsFile,
    ...(command ? { command } : {}),
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

export { HELP };
