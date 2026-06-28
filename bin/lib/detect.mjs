// Adapter detection and "did you mean" suggestions for the @ozzylabs/skills CLI.
//
// On an interactive (TTY) run, `add` defaults `--adapter` to the agent CLIs the
// user actually has on this machine — detected from each CLI's config directory
// under $HOME. This matches "install for the agents you have" without hardcoding
// a privileged default (no differentiation between Claude and the others). On a
// non-interactive run (CI, pipe) detection is unsafe, so `--adapter` is required.

import { existsSync } from "node:fs";
import { join } from "node:path";

// Per-adapter signals: if ANY of these paths exists under $HOME, the adapter is
// considered present. Config dirs are stable, cheap to probe, and don't require
// the binary to be on PATH.
const ADAPTER_SIGNALS = {
  "claude-code": [".claude"],
  "codex-cli": [".codex", ".agents"],
  "gemini-cli": [".gemini"],
  copilot: [".copilot"],
};

/**
 * Detect which adapter CLIs are present on this machine.
 *
 * @param {string} home
 * @returns {string[]} sorted adapter ids
 */
export function detectAdapters(home) {
  const found = [];
  for (const [id, signals] of Object.entries(ADAPTER_SIGNALS)) {
    if (signals.some((rel) => existsSync(join(home, rel)))) found.push(id);
  }
  return found.sort();
}

/**
 * Levenshtein distance (small inputs — flag/adapter/skill names).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Return the closest candidate to `input` within an edit distance threshold, or
 * null when nothing is close enough. Used to build "did you mean X?" errors.
 *
 * @param {string} input
 * @param {string[]} candidates
 * @returns {string | null}
 */
export function suggest(input, candidates) {
  let best = null;
  let bestDist = Number.POSITIVE_INFINITY;
  // Allow up to ~40% of the input length in edits (min 2), so short typos and
  // longer near-misses both resolve without matching wildly different strings.
  const threshold = Math.max(2, Math.floor(input.length * 0.4));
  for (const c of candidates) {
    const d = levenshtein(input, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return bestDist <= threshold ? best : null;
}

/**
 * Format a "did you mean" suffix, e.g. " — did you mean 'drive'?".
 *
 * @param {string} input
 * @param {string[]} candidates
 * @returns {string}
 */
export function didYouMean(input, candidates) {
  const s = suggest(input, candidates);
  return s ? ` — did you mean '${s}'?` : "";
}
