// `skills diff <skill>` — show a skill's local edits vs the current upstream
// (ozzy-labs/skills#151 PR7). The pristine version is re-materialized into a
// temp HOME (identical bytes to a clean install, since refs are rewritten to the
// literal `~/` form either way), then each non-marker file is compared. Output
// is a unified diff per changed file.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { readInstalled } from "./installed.mjs";
import { executeInstall, findPackageRoot, planInstall } from "./install.mjs";
import { isMarkerFile } from "./marker.mjs";

const HELP = `npx @ozzylabs/skills diff <skill>

Show how an installed skill differs from the current upstream version
(i.e. your local edits). No changes are made.
`;

async function walkRel(root) {
  const out = [];
  async function go(dir) {
    if (!existsSync(dir)) return;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await go(full);
      else if (e.isFile() && !isMarkerFile(e.name)) out.push(relative(root, full));
    }
  }
  await go(root);
  return out.sort();
}

export async function runDiff(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const [skill, ...extra] = argv.filter((a) => !a.startsWith("-"));
  if (!skill || extra.length > 0) {
    process.stderr.write(`error: usage: skills diff <skill>\n\n${HELP}`);
    return 1;
  }

  const packageRoot = await findPackageRoot();
  const home = process.env.OZZYLABS_SKILLS_HOME ?? homedir();
  const installed = await readInstalled(home);
  const entry = installed.get(skill);
  if (!entry) {
    process.stderr.write(`error: '${skill}' is not installed.\n`);
    return 1;
  }

  const tmp = await mkdtemp(join(tmpdir(), "skills-diff-"));
  let changed = 0;
  try {
    for (const adapter of entry.adapters) {
      const plan = await planInstall({ packageRoot, home: tmp, adapter, skillsFilter: [skill] });
      await executeInstall(plan, { upgrade: true, force: true });
    }
    for (const installedDir of entry.dirs) {
      const rel = relative(home, installedDir);
      const pristineDir = join(tmp, rel);
      const files = new Set([...(await walkRel(pristineDir)), ...(await walkRel(installedDir))]);
      for (const f of [...files].sort()) {
        const a = join(pristineDir, f);
        const b = join(installedDir, f);
        const res = spawnSync(
          "git",
          ["diff", "--no-index", existsSync(a) ? a : "/dev/null", existsSync(b) ? b : "/dev/null"],
          { encoding: "utf8" },
        );
        if (res.stdout) {
          process.stdout.write(`${res.stdout}\n`);
          changed += 1;
        }
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  if (changed === 0) process.stdout.write(`'${skill}' matches upstream (no local edits).\n`);
  return 0;
}

export { HELP };
