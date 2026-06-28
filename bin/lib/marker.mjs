// Per-item provenance markers — the single source of truth for what the CLI
// installed (see ozzy-labs/skills#151).
//
// Each materialized skill directory carries a co-located `.ozzylabs-skills.json`
// recording that it is ours, which bundle version produced it, and which adapters
// need it (the reference count for the shared `.agents/skills/<name>` base).
// Agents are single files, so they get a sidecar `<name>.md.ozzylabs-skills.json`.
// Markers are filesystem-resident: deleting an item removes its marker, so the
// state can't drift independently and survives a wiped central cache. There is
// NO central registry.
//
// Markers are written by the CLI at install time — never by the build pipeline.
// `scripts/build.mjs` excludes `*ozzylabs-skills.json` from the shipped payload
// (`isMarkerFile` is the shared predicate) so a marker can never leak into dist.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const MARKER_NAME = ".ozzylabs-skills.json";
export const MARKER_SCHEMA = 1;
export const MARKER_SOURCE = "@ozzylabs/skills";

/**
 * True for any provenance marker path — the dir marker `.ozzylabs-skills.json`
 * and the agent sidecar `<name>.md.ozzylabs-skills.json`. Used both by the CLI
 * and by the build pipeline (to keep markers out of dist).
 *
 * @param {string} relOrName
 * @returns {boolean}
 */
export function isMarkerFile(relOrName) {
  return /ozzylabs-skills\.json$/.test(relOrName);
}

/** Path of the marker inside a skill directory. */
export function markerPathForDir(dir) {
  return join(dir, MARKER_NAME);
}

/** Path of the sidecar marker for a single-file item (e.g. an agent .md). */
export function markerPathForFile(filePath) {
  return `${filePath}${MARKER_NAME}`;
}

/**
 * @param {{ bundleVersion: string, adapters?: string[], extra?: object }} fields
 * @returns {object}
 */
function buildMarker({ bundleVersion, adapters, extra }) {
  const marker = {
    schema: MARKER_SCHEMA,
    source: MARKER_SOURCE,
    bundleVersion,
  };
  if (adapters) marker.adapters = [...new Set(adapters)].sort();
  return { ...marker, ...extra };
}

/**
 * Read a marker from an exact path. Returns null when absent or unparseable
 * (a corrupt marker is treated as "not ours" — never throws).
 *
 * @param {string} markerPath
 * @returns {Promise<object | null>}
 */
export async function readMarker(markerPath) {
  if (!existsSync(markerPath)) return null;
  try {
    const parsed = JSON.parse(await readFile(markerPath, "utf8"));
    return parsed && parsed.source === MARKER_SOURCE ? parsed : null;
  } catch {
    return null;
  }
}

/** Read the marker for a skill directory. */
export function readDirMarker(dir) {
  return readMarker(markerPathForDir(dir));
}

/**
 * Write/refresh a marker at an exact path. JSON is stable (sorted adapters,
 * 2-space indent, trailing newline) so re-installs and project-scope commits
 * produce minimal diffs.
 *
 * @param {string} markerPath
 * @param {{ bundleVersion: string, adapters?: string[], extra?: object }} fields
 * @returns {Promise<object>} the written marker
 */
export async function writeMarker(markerPath, fields) {
  const marker = buildMarker(fields);
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

/** Write the marker into a skill directory. */
export function writeDirMarker(dir, fields) {
  return writeMarker(markerPathForDir(dir), fields);
}

/**
 * Reference-count helper for the shared `.agents/skills/<name>` base: merge an
 * adapter into an existing marker's `adapters[]` (or seed a fresh one).
 *
 * @param {object | null} existing
 * @param {string} adapter
 * @param {string} bundleVersion
 * @returns {object} the merged marker fields ({ bundleVersion, adapters })
 */
export function withAdapterAdded(existing, adapter, bundleVersion) {
  const adapters = new Set(existing?.adapters ?? []);
  adapters.add(adapter);
  return { bundleVersion, adapters: [...adapters].sort() };
}

/**
 * Remove an adapter from a marker's `adapters[]`. Returns the remaining adapter
 * list — when empty, the caller deletes the shared base (last reference gone).
 *
 * @param {object | null} existing
 * @param {string} adapter
 * @returns {string[]} remaining adapters
 */
export function withAdapterRemoved(existing, adapter) {
  return (existing?.adapters ?? []).filter((a) => a !== adapter).sort();
}
