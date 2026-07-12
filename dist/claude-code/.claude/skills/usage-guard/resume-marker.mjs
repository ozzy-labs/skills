#!/usr/bin/env node
// resume-marker — the pending-resume marker for usage-guard (#212).
//
// When a caller (drive / the standalone /usage-guard form) pauses on an
// over-threshold budget, it records a marker: "work is paused; here is the
// continuation command and when it should resume". On a successful resume it
// clears the marker. A SessionStart hook (resume-check.mjs) reads the marker and
// surfaces "a paused resume is OVERDUE" if the planned resume time has passed —
// which is exactly the failure usage-guard exists to prevent (stuck after the
// reset). The marker is the code-side net for the one thing the engine cannot do
// itself: it cannot call the host scheduling tools, so it cannot GUARANTEE the
// arm — but it can DETECT a missed resume after the fact.
//
// M2 (path-literal note): the marker path is HOME-anchored via path.join (NOT a
// rewritable `~/.claude/skills/...` literal), so it survives the dist build intact
// and is shared across scopes just like the cache / hook-state files.
//
// All operations are best-effort and fail-open: a marker error must never
// hard-stop work. Pure/injectable so tests need no real fs.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// HOME-anchored, beside the cache / hook-state (OUTSIDE any skills dir) so it is
// shared across scopes and never wiped when a skills mirror is rebuilt.
export const RESUME_MARKER_PATH = join(homedir(), ".claude", "usage-guard", "resume-pending.json");

// Monotonic sequence for unique temp filenames in atomic (write-temp → rename)
// persistence, mirroring usage-check.mjs / usage-guard-hook.mjs (#211/#212).
let __markerSeq = 0;

/**
 * Write (arm) the pending-resume marker atomically (temp → rename).
 *
 * @param {object} marker  the marker payload, typically:
 *   `{ continuation: string, fire_at: string (ISO), trigger?: string, reason?: string }`
 * @param {object} [deps]
 * @param {typeof writeFile} [deps.writeFileImpl]
 * @param {typeof mkdir} [deps.mkdirImpl]
 * @param {(from: string, to: string) => Promise<void>} [deps.renameImpl]
 * @param {string} [deps.markerPath]
 * @param {() => number} [deps.now]
 */
export async function writeResumeMarker(
  marker,
  { writeFileImpl = writeFile, mkdirImpl = mkdir, renameImpl = rename, markerPath = RESUME_MARKER_PATH, now = Date.now } = {},
) {
  try {
    await mkdirImpl(join(markerPath, ".."), { recursive: true });
    const record = { armed_at: new Date(now()).toISOString(), ...(marker && typeof marker === "object" ? marker : {}) };
    const tmpPath = `${markerPath}.tmp.${process.pid}.${__markerSeq++}`;
    await writeFileImpl(tmpPath, JSON.stringify(record));
    await renameImpl(tmpPath, markerPath);
  } catch {
    // best-effort; a marker write must never hard-stop work.
  }
}

/**
 * Read the pending-resume marker, or null when absent / malformed.
 *
 * @param {object} [deps]
 * @param {typeof readFile} [deps.readFileImpl]
 * @param {string} [deps.markerPath]
 * @returns {Promise<object|null>}
 */
export async function readResumeMarker({ readFileImpl = readFile, markerPath = RESUME_MARKER_PATH } = {}) {
  try {
    const parsed = JSON.parse(await readFileImpl(markerPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Clear (disarm) the marker — called by the caller on a successful resume.
 * Tolerates an already-absent marker.
 *
 * @param {object} [deps]
 * @param {(p: string) => Promise<void>} [deps.unlinkImpl]
 * @param {string} [deps.markerPath]
 */
export async function clearResumeMarker({ unlinkImpl = unlink, markerPath = RESUME_MARKER_PATH } = {}) {
  try {
    await unlinkImpl(markerPath);
  } catch {
    // already gone / never written — nothing to clear.
  }
}
