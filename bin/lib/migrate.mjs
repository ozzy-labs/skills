// `npx @ozzylabs/skills migrate` implementation.
//
// Removes the legacy project-scoped skill copies that the old Renovate-based
// `/sync-consumers` flow left behind, plus the related `.commons/sync.yaml`
// entries (`skills_adapters` / `skills_commit`). The new world is user-scoped
// install via `npx @ozzylabs/skills install`, so the project-scoped tree is
// dead weight.
//
// The list of skill names is intentionally hard-coded — these are the ten
// generic skills shipped from `@ozzylabs/skills`. Repo-local skills (anything
// else) are left in place.

import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertNoForbiddenFlags, parseFlags } from "./args.mjs";

const HELP = `npx @ozzylabs/skills migrate [options]

Remove the legacy project-scoped skill copies and the related .commons/sync.yaml
entries that the old Renovate-based /sync-consumers flow left behind.

Options:
  --dry-run            Print the migrate plan as JSON and exit. No files are
                       touched.
  --keep-sync-yaml     Leave the .commons/sync.yaml entries (skills_adapters,
                       skills_commit) in place. Default is to remove them.
  --force              Skip the interactive confirmation prompt (non-TTY
                       sessions skip the prompt automatically).
  -h, --help           Show this help.
`;

// The ten generic skills shipped from @ozzylabs/skills. Other skill names
// under .claude/skills/ or .agents/skills/ are treated as repo-local and left
// untouched.
export const GENERIC_SKILLS = Object.freeze([
  "commit",
  "commit-conventions",
  "drive",
  "implement",
  "lint",
  "lint-rules",
  "pr",
  "review",
  "ship",
  "test",
]);

// Directory roots that the legacy sync flow wrote into.
const SKILL_DIRS = [".claude/skills", ".agents/skills"];

const SYNC_YAML_PATH = ".commons/sync.yaml";

const SCHEMA = {
  "dry-run": "boolean",
  "keep-sync-yaml": "boolean",
  force: "boolean",
  help: "boolean",
};

const ALIASES = { h: "help" };

/**
 * Plan a migrate run for `cwd`. Pure: takes inputs and returns the action
 * plan without touching the filesystem.
 *
 * @param {object} args
 * @param {string} args.cwd
 * @param {boolean} args.keepSyncYaml
 * @returns {Promise<{ cwd: string, skill_dirs_to_remove: string[], sync_yaml: { path: string | null, will_modify: boolean, before: string | null, after: string | null } }>}
 */
export async function planMigrate({ cwd, keepSyncYaml }) {
  const skillDirsToRemove = [];
  for (const root of SKILL_DIRS) {
    const rootPath = join(cwd, root);
    if (!existsSync(rootPath)) continue;
    let entries;
    try {
      entries = await readdir(rootPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (GENERIC_SKILLS.includes(entry.name)) {
        skillDirsToRemove.push(join(root, entry.name));
      }
    }
  }
  skillDirsToRemove.sort();

  const syncYamlPath = join(cwd, SYNC_YAML_PATH);
  let syncPlan = { path: null, will_modify: false, before: null, after: null };
  if (!keepSyncYaml && existsSync(syncYamlPath)) {
    const before = await readFile(syncYamlPath, "utf8");
    const after = stripSyncYamlEntries(before);
    syncPlan = {
      path: SYNC_YAML_PATH,
      will_modify: after !== before,
      before,
      after,
    };
  }

  return {
    cwd,
    skill_dirs_to_remove: skillDirsToRemove,
    sync_yaml: syncPlan,
  };
}

/**
 * Strip `skills_adapters` and `skills_commit` blocks from a YAML document.
 *
 * The format we touch is a hand-written `.commons/sync.yaml` so a full YAML
 * round-trip would lose comments and reorder keys. We work at the line level:
 * lines that start at column 0 with `skills_adapters:` or `skills_commit:` are
 * removed, plus any immediately-following list / scalar continuation lines
 * (indented two or more spaces).
 *
 * @param {string} content
 * @returns {string}
 */
export function stripSyncYamlEntries(content) {
  const lines = content.split("\n");
  const out = [];
  let stripping = false;
  for (const line of lines) {
    if (stripping) {
      // Continuation lines are indented; stop stripping when we hit a
      // non-indented line (next top-level key or blank line).
      if (/^[ \t]/.test(line)) {
        continue;
      }
      stripping = false;
    }
    if (/^skills_adapters\s*:/.test(line) || /^skills_commit\s*:/.test(line)) {
      stripping = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Execute a migrate plan against the real filesystem. Mutates disk.
 *
 * @param {Awaited<ReturnType<typeof planMigrate>>} plan
 * @returns {Promise<{ removed: string[], sync_yaml_updated: boolean }>}
 */
export async function executeMigrate(plan) {
  const removed = [];
  for (const rel of plan.skill_dirs_to_remove) {
    const full = join(plan.cwd, rel);
    await rm(full, { recursive: true, force: true });
    removed.push(rel);
  }
  let syncYamlUpdated = false;
  if (plan.sync_yaml.will_modify && plan.sync_yaml.path) {
    await writeFile(join(plan.cwd, plan.sync_yaml.path), plan.sync_yaml.after);
    syncYamlUpdated = true;
  }
  return { removed, sync_yaml_updated: syncYamlUpdated };
}

/**
 * Confirm an interactive destructive operation. See install.mjs#confirm for
 * the TTY semantics — the contract is identical so behavior stays consistent
 * across subcommands.
 */
async function confirm(message, force) {
  if (force) return true;
  if (!process.stdin.isTTY) return false;
  process.stdout.write(`${message} [y/N] `);
  return await new Promise((resolve) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes("\n")) {
        process.stdin.off("data", onData);
        process.stdin.pause();
        const answer = buf.trim().toLowerCase();
        resolve(answer === "y" || answer === "yes");
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

/**
 * Run the `migrate` subcommand from CLI argv. Returns a process exit code.
 *
 * @param {string[]} argv The args after the `migrate` subcommand keyword.
 * @returns {Promise<number>}
 */
export async function runMigrate(argv) {
  try {
    assertNoForbiddenFlags(argv);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n\n${HELP}`);
    return 1;
  }

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
  if (parsed.rejected.length > 0) {
    process.stderr.write(`error: unknown argument(s): ${parsed.rejected.join(", ")}\n\n${HELP}`);
    return 1;
  }

  const dryRun = Boolean(parsed.values["dry-run"]);
  const keepSyncYaml = Boolean(parsed.values["keep-sync-yaml"]);
  const force = Boolean(parsed.values.force);

  const cwd = process.env.OZZYLABS_SKILLS_CWD ?? process.cwd();
  const plan = await planMigrate({ cwd, keepSyncYaml });

  if (dryRun) {
    const summary = {
      cwd: plan.cwd,
      will_remove: plan.skill_dirs_to_remove,
      sync_yaml: {
        path: plan.sync_yaml.path,
        will_modify: plan.sync_yaml.will_modify,
      },
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }

  const hasWork =
    plan.skill_dirs_to_remove.length > 0 || plan.sync_yaml.will_modify;
  if (!hasWork) {
    process.stdout.write(
      `${JSON.stringify({ cwd: plan.cwd, removed: [], sync_yaml_updated: false, note: "nothing to migrate" }, null, 2)}\n`,
    );
    return 0;
  }

  if (!force) {
    const yes = await confirm(
      `About to remove ${plan.skill_dirs_to_remove.length} skill director${plan.skill_dirs_to_remove.length === 1 ? "y" : "ies"} and ${plan.sync_yaml.will_modify ? "update" : "leave"} .commons/sync.yaml in ${plan.cwd}. Proceed?`,
      false,
    );
    if (!yes) {
      process.stderr.write("aborted: user declined\n");
      return 1;
    }
  }

  const result = await executeMigrate(plan);
  const summary = {
    cwd: plan.cwd,
    removed: result.removed,
    sync_yaml_updated: result.sync_yaml_updated,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

export { HELP };
