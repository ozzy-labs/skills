// 3-way merge for `update --merge` (#151 follow-up). For an edited skill:
//   base   = the pristine snapshot taken at install/last-merge (merge base)
//   mine   = the current on-disk content (the user's edits)
//   theirs = the current upstream, re-materialized into a temp HOME
// Each file is merged with `git merge-file`; conflicts are left with standard
// markers. Afterwards the baseline is advanced to `theirs` (marker hash +
// pristine), so the skill stays correctly flagged as edited vs the new upstream.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { executeInstall, planInstall } from "./install.mjs";
import { computeDirHash, isMarkerFile, readDirMarker, writeDirMarker } from "./marker.mjs";
import { hasPristine, pristinePath, savePristineFrom } from "./pristine.mjs";

async function nonMarkerFiles(root) {
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
  return out;
}

/**
 * @returns {Promise<{ skill: string, status: "merged"|"merged-with-conflicts"|"no-base", conflicts: number }>}
 */
export async function mergeSkill({ home, packageRoot, skill, entry, bundleVersion }) {
  // Need a base for every dir; without it, fall back (caller suggests --take-theirs/--keep-mine).
  if (entry.dirs.some((dir) => !hasPristine(home, dir))) {
    return { skill, status: "no-base", conflicts: 0 };
  }

  const theirsHome = await mkdtemp(join(tmpdir(), "skills-merge-"));
  let conflicts = 0;
  try {
    for (const adapter of entry.adapters) {
      const plan = await planInstall({ packageRoot, home: theirsHome, adapter, skillsFilter: [skill] });
      await executeInstall(plan, { upgrade: true, force: true });
    }

    for (const dir of entry.dirs) {
      const rel = relative(home, dir);
      const theirsDir = join(theirsHome, rel);
      const baseDir = pristinePath(home, dir);
      const files = new Set([
        ...(await nonMarkerFiles(baseDir)),
        ...(await nonMarkerFiles(dir)),
        ...(await nonMarkerFiles(theirsDir)),
      ]);
      for (const f of files) {
        const mine = join(dir, f);
        const base = join(baseDir, f);
        const theirs = join(theirsDir, f);
        if (existsSync(mine) && existsSync(base) && existsSync(theirs)) {
          // -p prints the merge to stdout; exit status = conflict count.
          const r = spawnSync("git", ["merge-file", "-p", mine, base, theirs], { encoding: "utf8" });
          await writeFile(mine, r.stdout);
          if (r.status > 0) conflicts += r.status;
        } else if (existsSync(theirs) && !existsSync(mine) && !existsSync(base)) {
          // New upstream file — add it.
          await mkdir(dirname(mine), { recursive: true });
          await cp(theirs, mine);
        }
        // Otherwise keep mine (user-added, or upstream-deleted) — conservative.
      }
    }

    // Advance the baseline to the upstream we merged against.
    for (const dir of entry.dirs) {
      const theirsDir = join(theirsHome, relative(home, dir));
      const existing = await readDirMarker(dir);
      const originalHash = await computeDirHash(theirsDir);
      await writeDirMarker(dir, {
        adapters: existing?.adapters,
        bundleVersion,
        extra: { originalHash },
      });
      await savePristineFrom(home, dir, theirsDir);
    }
  } finally {
    await rm(theirsHome, { recursive: true, force: true });
  }

  return { skill, status: conflicts > 0 ? "merged-with-conflicts" : "merged", conflicts };
}
