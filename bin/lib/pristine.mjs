// Pristine content store — the merge base for `update --merge` (#151 follow-up).
//
// The per-item marker records an `originalHash` (cheap edit detection) but NOT
// the original CONTENT, so a 3-way merge has no base to reconstruct. This store
// snapshots the as-installed content of each skill directory at install/update
// time, keyed by the installed dir's absolute path, under the scope's
// `.cache/@ozzylabs-skills/pristine/`. It is a rebuildable cache (cleared → merge
// gracefully degrades to --take-theirs/--keep-mine), never a provenance source.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isMarkerFile } from "./marker.mjs";

function keyFor(dir) {
  return createHash("sha256").update(dir).digest("hex").slice(0, 16);
}

/** Cache path holding the pristine snapshot of an installed skill directory. */
export function pristinePath(home, dir) {
  return join(home, ".cache", "@ozzylabs-skills", "pristine", keyFor(dir));
}

export function hasPristine(home, dir) {
  return existsSync(pristinePath(home, dir));
}

/**
 * Snapshot the as-installed content of `dir` (markers excluded) into the cache,
 * overwriting any previous snapshot. Called after a successful install/update so
 * the base always reflects the last clean state.
 */
export async function savePristine(home, dir) {
  return savePristineFrom(home, dir, dir);
}

/**
 * Snapshot `sourceDir`'s content (markers excluded) as the pristine base for the
 * installed directory `dir`. After `update --merge`, the new base is the upstream
 * we merged against, so we snapshot the temp "theirs" tree rather than the
 * (now-merged) on-disk one.
 */
export async function savePristineFrom(home, dir, sourceDir) {
  const dest = pristinePath(home, dir);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dirname(dest), { recursive: true });
  await cp(sourceDir, dest, {
    recursive: true,
    filter: (src) => !isMarkerFile(basename(src)),
  });
}

/** Remove a skill directory's pristine snapshot (used when the skill is removed). */
export async function dropPristine(home, dir) {
  await rm(pristinePath(home, dir), { recursive: true, force: true });
}
