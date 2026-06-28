// Read installed-skill state from per-item provenance markers (shared by `list`
// and `update`). No central registry — the markers under each scope root are the
// source of truth.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readDirMarker } from "./marker.mjs";

// Roots scanned under a scope root. `.agents/skills` is the shared base
// (ref-counted across adapters); `.claude/skills` carries claude-code-only
// skills (e.g. usage-guard, which has no base).
export const SCAN_ROOTS = [".agents/skills", ".claude/skills"];

async function subdirs(dir) {
  if (!existsSync(dir)) return [];
  return (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/**
 * @param {string} scopeRoot
 * @returns {Promise<Map<string, { version: string, adapters: Set<string>, dirs: string[] }>>}
 */
export async function readInstalled(scopeRoot) {
  const installed = new Map();
  for (const root of SCAN_ROOTS) {
    for (const name of await subdirs(join(scopeRoot, root))) {
      const dir = join(scopeRoot, root, name);
      const marker = await readDirMarker(dir);
      if (!marker) continue; // unmarked dir → not ours
      const entry = installed.get(name) ?? {
        version: marker.bundleVersion,
        adapters: new Set(),
        dirs: [],
      };
      for (const a of marker.adapters ?? []) entry.adapters.add(a);
      entry.version = marker.bundleVersion ?? entry.version;
      entry.dirs.push(dir);
      installed.set(name, entry);
    }
  }
  return installed;
}
