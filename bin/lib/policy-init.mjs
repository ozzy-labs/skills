// `skills policy init` — scaffold a commented `policy.yaml` template
// (ozzy-labs/skills#174 PR 3, ADR-0028 R3).
//
// The central autonomy policy (the `policy` skill) is read from a two-level
// hierarchy: `~/.agents/policy.yaml` (user default) and `<repo>/.agents/policy.yaml`
// (repo override). Both are hand-authored today. This verb writes a template a
// user can edit, spelling out the three zero-config class defaults plus commented
// per-action override examples, so nobody has to reverse-engineer the schema.
//
// It is deliberately NON-DESTRUCTIVE: if the target already exists it is left
// byte-for-byte untouched (skip + a note), never overwritten — the same
// "never clobber the user's edits" stance the rest of the CLI takes. The written
// template is a valid, zero-config-equivalent policy (parses + validates clean
// via policy-read.mjs, degraded:false), so `policy init` followed by no edits
// reproduces today's behavior.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseFlags } from "./args.mjs";
import { confirm } from "./prompt.mjs";

// The scaffolded template. Kept in sync with policy.schema.json by a test that
// parses + validates this exact string through policy-read.mjs (no drift). The
// three `classes` lines are the zero-config defaults spelled out; `actions` is
// commented so the file validates as a pure zero-config-equivalent policy until
// the user opts into an override.
export const POLICY_TEMPLATE = `# Central autonomy policy (ADR-0028 R3) — contract lives in the \`policy\` skill.
#
# Skills classify each action into one of three CLASSES and read the resolved
# GATE before acting. Gates:
#   proceed        do it and leave an audit trail (no confirmation)
#   batch-confirm  confirm once, in bulk, before a batch of actions
#   ask            an Approval Gate on every single operation
#
# This file OVERRIDES the zero-config defaults (which reproduce today's behavior).
# Hierarchy — repo wins over user, user wins over the built-in defaults:
#   ~/.agents/policy.yaml        user default (this file, HOME-anchored)
#   <repo>/.agents/policy.yaml   repo override (\`policy init --scope=repo\`)
# Unknown top-level keys are rejected; an invalid value fails safe to \`ask\`.
schema_version: 1

# Per-class gate. These three lines are the zero-config defaults written out —
# change a value to tighten (→ ask) or loosen (→ proceed) a whole class.
classes:
  reversible-local: proceed        # branch-scoped edits, safe branch delete, worktree prune
  externally-visible: batch-confirm # issue create, PR create, PR comment, topics apply
  irreversible: ask                # merge, publish, force-push, release create, stash drop

# Per-action overrides (kebab-case action name -> gate). An action override wins
# over its class default. Uncomment and edit to override a single action:
# actions:
#   merge: ask            # always require explicit approval before gh pr merge
#   issue-create: proceed # let issue creation run without a confirmation
#   publish: ask
`;

const HELP = `npx @ozzylabs/skills policy <init> [options]

Scaffold a commented policy.yaml for the central autonomy policy (the \`policy\`
skill). Non-destructive: an existing policy.yaml is never overwritten.

Actions:
  init            Write a policy.yaml template. Skips (no-op) if one exists.

Options:
  --scope=<user|repo>  Where to write: 'user' -> ~/.agents/policy.yaml (default),
                       'repo' -> <repo>/.agents/policy.yaml.
  --repo-root=<dir>    Repo root for --scope=repo (default: current directory).
  --dry-run            Print the template + target path and exit. Writes nothing.
  --yes                Skip the confirmation prompt (required non-interactively).
  -h, --help           Show this help.
`;

const SCHEMA = {
  scope: "string",
  "repo-root": "string",
  "dry-run": "boolean",
  yes: "boolean",
  help: "boolean",
};
const ALIASES = { h: "help" };

/**
 * Resolve the target policy.yaml path for a scope.
 *   user → <HOME>/.agents/policy.yaml (HOME overridable via OZZYLABS_SKILLS_HOME
 *          for tests, matching the hooks verb).
 *   repo → <repo-root|cwd>/.agents/policy.yaml.
 *
 * @param {"user"|"repo"} scope
 * @param {{ home?: string, repoRoot?: string }} [ctx]
 * @returns {string}
 */
export function resolvePolicyPath(scope, { home, repoRoot } = {}) {
  const base = scope === "repo" ? (repoRoot ?? process.cwd()) : (home ?? homedir());
  return join(base, ".agents", "policy.yaml");
}

/**
 * @param {string[]} argv args past the `policy` subcommand keyword
 * @param {{ isTTY?: boolean }} [opts]
 * @returns {Promise<number>} exit code
 */
export async function runPolicy(argv, opts = {}) {
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

  const [action] = positionals;
  if (action !== "init") {
    process.stderr.write(`error: expected 'init'${action ? ` (got '${action}')` : ""}\n\n${HELP}`);
    return 1;
  }

  const scope = parsed.values.scope ?? "user";
  if (scope !== "user" && scope !== "repo") {
    process.stderr.write(`error: --scope must be 'user' or 'repo' (got '${scope}')\n`);
    return 1;
  }

  const home = process.env.OZZYLABS_SKILLS_HOME ?? homedir();
  const targetFile = resolvePolicyPath(scope, {
    home,
    repoRoot: parsed.values["repo-root"],
  });

  // Non-destructive: never overwrite an existing policy.yaml.
  if (existsSync(targetFile)) {
    process.stdout.write(
      `policy.yaml already exists at ${targetFile} — not overwriting. ` +
        `Edit it by hand (or remove it first to regenerate). Nothing to do.\n`,
    );
    return 0;
  }

  process.stdout.write(`policy init (${scope}) → ${targetFile}\n\n${POLICY_TEMPLATE}\n`);

  const summary = { action: "init", scope, policy_file: targetFile, created: true };

  if (parsed.values["dry-run"]) {
    process.stdout.write(`${JSON.stringify({ ...summary, created: false, dry_run: true }, null, 2)}\n`);
    return 0;
  }

  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);
  if (!parsed.values.yes) {
    if (!isTTY) {
      process.stderr.write("error: refusing to write policy.yaml non-interactively — pass --yes.\n");
      return 1;
    }
    const ok = await confirm("Write this policy.yaml?", false);
    if (!ok) {
      process.stdout.write("Aborted.\n");
      return 0;
    }
  }

  // Guard against a TOCTOU race: re-check right before writing so a file that
  // appeared between the first check and the confirm is still not clobbered.
  if (existsSync(targetFile)) {
    process.stdout.write(`policy.yaml now exists at ${targetFile} — not overwriting. Nothing to do.\n`);
    return 0;
  }

  await mkdir(dirname(targetFile), { recursive: true });
  await writeFile(targetFile, POLICY_TEMPLATE);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

export { HELP };
