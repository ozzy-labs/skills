// Provenance-marker integration for `skills add` (ozzy-labs/skills#151 PR3).
//
// After files are materialized, each installed skill directory gets a marker
// recording it is ours, the bundle version, and (for the shared
// `.agents/skills/<name>` base) the reference-counted set of adapters that need
// it. Before installing, a collision guard refuses to claim a pre-existing skill
// directory that is NOT ours (no marker) unless `--force` is given.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ADAPTER_LAYOUT } from "./install.mjs";
import { computeDirHash, readDirMarker, withAdapterAdded, writeDirMarker } from "./marker.mjs";

// The cross-tool base root is shared by every adapter; its marker carries the
// adapter reference count. Other roots (e.g. `.claude/skills`) are adapter-owned.
const SHARED_BASE_ROOT = ".agents/skills";

/** Read the installed bundle version from the package root's package.json. */
export async function getBundleVersion(packageRoot) {
  try {
    const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Every (root, skill) directory a given adapter materializes.
 * @returns {Array<{ dir: string, root: string }>}
 */
function skillDirs(home, adapter, skills) {
  const roots = ADAPTER_LAYOUT[adapter]?.skillsRoots ?? [];
  const out = [];
  for (const skill of skills) {
    for (const root of roots) out.push({ dir: join(home, root, skill), root });
  }
  return out;
}

/**
 * Find skill directories that already exist but are NOT ours (no marker) — these
 * would be clobbered. The caller blocks unless `--force`.
 *
 * @returns {Promise<string[]>} offending absolute paths
 */
export async function findCollisions({ home, adapter, skills }) {
  const offenders = [];
  for (const { dir } of skillDirs(home, adapter, skills)) {
    if (existsSync(dir) && (await readDirMarker(dir)) === null) offenders.push(dir);
  }
  return offenders;
}

/**
 * Write/refresh provenance markers for the skills just installed by one adapter.
 * The shared base marker is reference-count-merged (adds this adapter to the
 * existing `adapters[]`); adapter-owned roots get a fresh single-adapter marker.
 */
export async function writeMarkers({ home, adapter, skills, bundleVersion }) {
  for (const { dir, root } of skillDirs(home, adapter, skills)) {
    if (!existsSync(dir)) continue;
    // originalHash baselines the as-installed content so `update` can detect a
    // user's local edits. Markers are excluded from the hash, so order vs. write
    // does not matter.
    const originalHash = await computeDirHash(dir);
    if (root === SHARED_BASE_ROOT) {
      const merged = withAdapterAdded(await readDirMarker(dir), adapter, bundleVersion);
      await writeDirMarker(dir, { ...merged, extra: { originalHash } });
    } else {
      await writeDirMarker(dir, { bundleVersion, adapters: [adapter], extra: { originalHash } });
    }
  }
}

export { SHARED_BASE_ROOT };
