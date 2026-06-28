// `skills fork <skill> <new-name>` — copy an installed skill to a user-owned
// name the CLI does not manage (ozzy-labs/skills#151 PR7). The original stays
// pristine and upgradeable; the fork carries NO provenance marker, so update /
// remove never touch it, and the user can edit it freely. The copied SKILL.md's
// `name:` is rewritten to the new name so it loads under that name.

import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readInstalled } from "./installed.mjs";
import { findPackageRoot } from "./install.mjs";
import { MARKER_NAME } from "./marker.mjs";

const HELP = `npx @ozzylabs/skills fork <skill> <new-name>

Copy an installed skill to a user-owned, unmanaged name. The original stays
managed (upgradeable); the fork is yours to edit and is never touched by
update/remove.
`;

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export async function runFork(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const [skill, newName, ...extra] = argv.filter((a) => !a.startsWith("-"));
  if (!skill || !newName || extra.length > 0) {
    process.stderr.write(`error: usage: skills fork <skill> <new-name>\n\n${HELP}`);
    return 1;
  }
  if (!NAME_RE.test(newName)) {
    process.stderr.write(`error: invalid skill name '${newName}' (use lowercase letters, digits, hyphens)\n`);
    return 1;
  }

  await findPackageRoot();
  const home = process.env.OZZYLABS_SKILLS_HOME ?? homedir();
  const installed = await readInstalled(home);
  const entry = installed.get(skill);
  if (!entry) {
    process.stderr.write(`error: '${skill}' is not installed — nothing to fork.\n`);
    return 1;
  }

  const created = [];
  for (const srcDir of entry.dirs) {
    const destDir = join(dirname(srcDir), newName);
    if (existsSync(destDir)) {
      process.stderr.write(`error: '${destDir}' already exists — pick another name.\n`);
      return 1;
    }
    await cp(srcDir, destDir, { recursive: true });
    // A fork is user-owned: strip the provenance marker so the CLI won't manage it.
    await rm(join(destDir, MARKER_NAME), { force: true });
    // Rewrite the skill name so it loads under the new name.
    const skillMd = join(destDir, "SKILL.md");
    if (existsSync(skillMd)) {
      const text = await readFile(skillMd, "utf8");
      await writeFile(skillMd, text.replace(/^name:\s*.*$/m, `name: ${newName}`));
    }
    created.push(destDir);
  }

  process.stdout.write(
    `${JSON.stringify({ forked: skill, into: newName, dirs: created.map((d) => basename(dirname(d)) + "/" + newName) }, null, 2)}\n`,
  );
  return 0;
}

export { HELP };
