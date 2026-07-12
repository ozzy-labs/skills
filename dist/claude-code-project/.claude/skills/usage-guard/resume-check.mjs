#!/usr/bin/env node
// resume-check — SessionStart surfacing of a pending / overdue usage-guard
// resume (#212).
//
// Wired as a SessionStart hook, this reads the pending-resume marker
// (resume-marker.mjs) and, at the start of a session, surfaces:
//   - an OVERDUE resume — the planned resume time (`fire_at`) has already passed
//     but the marker was never cleared, i.e. work paused for the Usage Limit and
//     the reset arrived but nothing resumed. THIS is the exact failure usage-
//     guard exists to prevent; making it visible lets the operator (or an
//     automation) re-run the continuation instead of silently staying stuck.
//   - a still-pending resume — paused, `fire_at` not yet reached (informational).
//
// It is read-only and fail-open: it never blocks a session start, and any error
// is swallowed (exit 0, no output). The pure `evaluateResumeCheck` decides the
// message with no I/O so tests need no real fs.

import { readResumeMarker } from "./resume-marker.mjs";

/**
 * Pure decision: given a marker (or null) decide what to surface.
 *
 * @param {object|null|undefined} marker  the resume marker (readResumeMarker)
 * @param {() => number} [now]
 * @returns {{ pending: boolean, overdue: boolean, message: string|null }}
 */
export function evaluateResumeCheck(marker, now = Date.now) {
  if (!marker || typeof marker !== "object") {
    return { pending: false, overdue: false, message: null };
  }
  const cont = typeof marker.continuation === "string" && marker.continuation.trim()
    ? marker.continuation.trim()
    : "(unknown continuation)";
  const fireMs = typeof marker.fire_at === "string" ? Date.parse(marker.fire_at) : NaN;
  const overdue = Number.isFinite(fireMs) && fireMs <= now();
  if (overdue) {
    return {
      pending: true,
      overdue: true,
      message:
        `⚠️ usage-guard: a paused resume is OVERDUE — the planned resume time (${marker.fire_at}) has passed ` +
        `but work did not resume. Re-run: ${cont}`,
    };
  }
  const whenTxt = Number.isFinite(fireMs) ? ` until ${marker.fire_at}` : "";
  return {
    pending: true,
    overdue: false,
    message: `⏸ usage-guard: work is paused${whenTxt} for the Usage Limit (resume: ${cont}).`,
  };
}

/**
 * Run the SessionStart check. Reads the marker and surfaces a message. Always
 * resolves to exit code 0 (never blocks a session start).
 *
 * @param {object} [deps]
 * @param {() => Promise<object|null>} [deps.readMarkerImpl]
 * @param {() => number} [deps.now]
 * @param {(msg: string) => void} [deps.out]
 * @returns {Promise<number>}
 */
export async function run({ readMarkerImpl = () => readResumeMarker(), now = Date.now, out = (m) => process.stdout.write(`${m}\n`) } = {}) {
  let marker = null;
  try {
    marker = await readMarkerImpl();
  } catch {
    return 0; // fail-open: never block a session start.
  }
  const { pending, message } = evaluateResumeCheck(marker, now);
  if (pending && message) out(message);
  return 0;
}

// CLI entry — only when executed directly (not when imported by tests).
const __isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (__isMain) {
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 0; // fail-open
    });
}
