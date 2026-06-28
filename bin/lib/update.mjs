// `skills update` — update installed skills, preserving local edits
// (ozzy-labs/skills#151 PR6). Editable-skill protection: each installed skill
// dir was baselined with an `originalHash` at install time. On update we re-hash
// the on-disk content; an UNEDITED skill is re-materialized from the current
// bundle, while an EDITED skill is NOT clobbered — it is reported and the user
// resolves it with `--take-theirs` (adopt upstream) or `--keep-mine` (skip).
// (3-way `--merge` lands in PR7.) Edit detection is user-scope only; project
// scope relies on git diff.

import { homedir } from "node:os";
import { parseFlags } from "./args.mjs";
import { readInstalled } from "./installed.mjs";
import { executeInstall, findPackageRoot, planInstall } from "./install.mjs";
import { getBundleVersion, writeMarkers } from "./install-markers.mjs";
import { computeDirHash, readDirMarker } from "./marker.mjs";

const HELP = `npx @ozzylabs/skills update [<skill>...] [options]

Update installed skills to the current bundle, preserving your local edits.
With no skill names, updates everything installed.

Options:
  --take-theirs    For edited skills, adopt the upstream version (discard edits).
  --keep-mine      For edited skills, keep your version (skip the update).
  --dry-run        Print the plan as JSON and exit.
  -h, --help       Show this help.

Edited skills are never overwritten unless --take-theirs is given.
`;

const SCHEMA = {
  "take-theirs": "boolean",
  "keep-mine": "boolean",
  "dry-run": "boolean",
  help: "boolean",
};
const ALIASES = { h: "help" };

/** True when any of a skill's installed directories differs from its baseline. */
async function isEdited(dirs) {
  for (const dir of dirs) {
    const marker = await readDirMarker(dir);
    if (!marker?.originalHash) continue; // no baseline → can't tell, treat as clean
    if ((await computeDirHash(dir)) !== marker.originalHash) return true;
  }
  return false;
}

/**
 * @param {string[]} argv args past the `update` subcommand keyword
 * @returns {Promise<number>} exit code
 */
export async function runUpdate(argv) {
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
  const unknownFlags = parsed.rejected.filter((a) => a.startsWith("-"));
  if (unknownFlags.length > 0) {
    process.stderr.write(`error: unknown argument(s): ${unknownFlags.join(", ")}\n\n${HELP}`);
    return 1;
  }
  const requested = parsed.rejected.filter((a) => !a.startsWith("-"));
  const takeTheirs = Boolean(parsed.values["take-theirs"]);
  const keepMine = Boolean(parsed.values["keep-mine"]);
  const dryRun = Boolean(parsed.values["dry-run"]);

  const packageRoot = await findPackageRoot();
  const home = process.env.OZZYLABS_SKILLS_HOME ?? homedir();
  const installed = await readInstalled(home);

  const targets = requested.length > 0 ? requested : [...installed.keys()];
  const updated = [];
  const modified = [];
  const skipped = [];

  for (const skill of targets) {
    const entry = installed.get(skill);
    if (!entry) {
      process.stderr.write(`warning: '${skill}' is not installed — skipping.\n`);
      continue;
    }
    const edited = await isEdited(entry.dirs);
    if (edited && !takeTheirs) {
      if (keepMine) skipped.push(skill);
      else modified.push(skill);
      continue;
    }
    if (!dryRun) {
      const bundleVersion = await getBundleVersion(packageRoot);
      for (const adapter of entry.adapters) {
        const plan = await planInstall({ packageRoot, home, adapter, skillsFilter: [skill] });
        await executeInstall(plan, { upgrade: true, force: true });
        await writeMarkers({ home, adapter, skills: [skill], bundleVersion });
      }
    }
    updated.push(skill);
  }

  if (modified.length > 0) {
    process.stderr.write(
      `\nmodified locally (not updated): ${modified.join(", ")}\n` +
        `  resolve with: skills update ${modified.join(" ")} --take-theirs | --keep-mine\n`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({ updated, modified, skipped, dryRun }, null, 2)}\n`,
  );
  return modified.length > 0 && !dryRun ? 1 : 0;
}

export { HELP };
