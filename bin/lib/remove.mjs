// `skills remove` (alias: uninstall) — uninstall skills (ozzy-labs/skills#151 PR5).
//
// Only directories carrying our provenance marker are ever touched (a skill the
// user authored, or one from another source, is left alone). The shared
// `.agents/skills/<name>` base is reference-counted: removing one adapter drops
// it from the marker's `adapters[]`; the base directory is deleted only when the
// last adapter is gone. Removal is destructive, so it previews the plan and
// requires confirmation (a TTY prompt, or `--yes` in non-interactive runs).

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFlags } from "./args.mjs";
import { didYouMean } from "./detect.mjs";
import { ADAPTER_LAYOUT, findPackageRoot, SUPPORTED_ADAPTERS } from "./install.mjs";
import { readDirMarker, writeDirMarker } from "./marker.mjs";
import { dropPristine } from "./pristine.mjs";
import { confirm } from "./prompt.mjs";

const SHARED_BASE_ROOT = ".agents/skills";

const HELP = `npx @ozzylabs/skills remove --skills <list> [options]

Uninstall skills. Only directories installed by @ozzylabs/skills are touched.

Options:
  --skills=<list>  REQUIRED. Comma-separated skill names to remove.
  --adapter=<list> Limit removal to these adapters (default: all).
  --target=<dir>   Remove from a project repo instead of user scope ($HOME).
  --dry-run        Print the removal plan as JSON and exit.
  --yes            Skip the confirmation prompt (required in non-interactive runs).
  -h, --help       Show this help.

Alias: \`uninstall\`.
`;

const SCHEMA = {
  skills: "string",
  adapter: "string",
  target: "string",
  "dry-run": "boolean",
  yes: "boolean",
  help: "boolean",
};
const ALIASES = { h: "help" };

function splitList(value) {
  return value ? value.split(",").map((s) => s.trim()).filter(Boolean) : null;
}

/** Adapter-owned roots (everything except the shared base). */
function ownedRoots(adapter) {
  return (ADAPTER_LAYOUT[adapter]?.skillsRoots ?? []).filter((r) => r !== SHARED_BASE_ROOT);
}

/**
 * Build the removal plan for one skill: which marker-owned directories to delete
 * outright, and how the shared base marker is reference-count-updated.
 *
 * @returns {Promise<{ skill: string, deletions: string[], baseUpdate: object | null, installed: boolean }>}
 */
async function planSkill(scopeRoot, skill, removeAdapters) {
  const deletions = [];
  let installed = false;

  // Adapter-owned dirs (e.g. .claude/skills/<name>) — delete when ours.
  for (const adapter of removeAdapters) {
    for (const root of ownedRoots(adapter)) {
      const dir = join(scopeRoot, root, skill);
      if (existsSync(dir) && (await readDirMarker(dir))) {
        deletions.push(dir);
        installed = true;
      }
    }
  }

  // Shared base — reference count.
  let baseUpdate = null;
  const baseDir = join(scopeRoot, SHARED_BASE_ROOT, skill);
  const baseMarker = await readDirMarker(baseDir);
  if (baseMarker) {
    installed = true;
    const current = baseMarker.adapters ?? [];
    const left = current.filter((a) => !removeAdapters.includes(a));
    if (left.length === 0) {
      deletions.push(baseDir);
      baseUpdate = { dir: baseDir, action: "delete" };
    } else if (left.length !== current.length) {
      baseUpdate = {
        dir: baseDir,
        action: "rewrite",
        adapters: left,
        version: baseMarker.bundleVersion,
      };
    }
  }

  return { skill, deletions: [...new Set(deletions)], baseUpdate, installed };
}

/**
 * @param {string[]} argv args past the `remove` subcommand keyword
 * @param {{ isTTY?: boolean }} [opts]
 * @returns {Promise<number>} exit code
 */
export async function runRemove(argv, opts = {}) {
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
  const skills = splitList(parsed.values.skills);
  if (!skills || skills.length === 0) {
    process.stderr.write(`error: --skills is required\n\n${HELP}`);
    return 1;
  }

  let removeAdapters = SUPPORTED_ADAPTERS;
  if (parsed.values.adapter) {
    removeAdapters = splitList(parsed.values.adapter);
    for (const a of removeAdapters) {
      if (!SUPPORTED_ADAPTERS.includes(a)) {
        process.stderr.write(
          `error: unknown adapter '${a}'${didYouMean(a, SUPPORTED_ADAPTERS)}\n`,
        );
        return 1;
      }
    }
  }

  await findPackageRoot(); // validates we are running from the package
  const scopeRoot = parsed.values.target ?? process.env.OZZYLABS_SKILLS_HOME ?? homedir();
  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);

  const plans = [];
  for (const skill of skills) plans.push(await planSkill(scopeRoot, skill, removeAdapters));

  const actionable = plans.filter((p) => p.installed);
  if (actionable.length === 0) {
    process.stdout.write("Nothing to remove (no matching installed skills).\n");
    return 0;
  }

  // Preview.
  const lines = ["The following will be removed:"];
  for (const p of actionable) {
    for (const d of p.deletions) lines.push(`  delete  ${d}`);
    if (p.baseUpdate?.action === "rewrite") {
      lines.push(`  keep    ${p.baseUpdate.dir}  (still needed by: ${p.baseUpdate.adapters.join(", ")})`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);

  if (parsed.values["dry-run"]) {
    process.stdout.write(`${JSON.stringify({ scope: parsed.values.target ? "project" : "user", plans: actionable }, null, 2)}\n`);
    return 0;
  }

  if (!parsed.values.yes) {
    if (!isTTY) {
      process.stderr.write("error: refusing to remove non-interactively — pass --yes.\n");
      return 1;
    }
    const ok = await confirm("Proceed?", false);
    if (!ok) {
      process.stdout.write("Aborted.\n");
      return 0;
    }
  }

  // Execute.
  for (const p of actionable) {
    for (const d of p.deletions) {
      await rm(d, { recursive: true, force: true });
      // Drop the merge-base snapshot for a fully removed skill dir.
      await dropPristine(scopeRoot, d);
    }
    if (p.baseUpdate?.action === "rewrite") {
      await writeDirMarker(p.baseUpdate.dir, {
        bundleVersion: p.baseUpdate.version,
        adapters: p.baseUpdate.adapters,
      });
    }
  }
  process.stdout.write(
    `${JSON.stringify({ removed: actionable.map((p) => p.skill) }, null, 2)}\n`,
  );
  return 0;
}

export { HELP };
