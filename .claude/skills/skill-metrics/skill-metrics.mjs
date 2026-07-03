#!/usr/bin/env node
// skill-metrics — local, read-only aggregator over the observability event log.
//
// Reads ~/.agents/observability/events.jsonl (written by obs-derive/obs-emit)
// and rolls it up into per-skill invocation counts plus notable friction
// signals. Deliberately COUNTS, not rates-with-confidence-intervals: for a
// single author's low-frequency data the statistics rarely reach significance,
// so a rate is only ever shown when its denominator clears a minimum-n guard.
// Everything stays local — this tool never sends anything anywhere.
//
// Output: a single JSON rollup on stdout (the SKILL.md renders it for humans).
//
// HOME-anchored with path.join so no rewritable skills-dir literal appears in
// source (M2): the event log and snapshots dir survive the dist user-scope
// rewrite intact.

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export const EVENTS_PATH = join(homedir(), ".agents", "observability", "events.jsonl");
export const SNAPSHOTS_DIR = join(homedir(), ".agents", "observability", "snapshots");
// Default minimum sample size before any RATE is reported. Below it, only raw
// counts are shown (a "1/1 abort" rate would mislead). Env-overridable.
export const DEFAULT_MIN_N = 5;
// Signal names that represent friction worth surfacing as "notable".
const FRICTION_SIGNALS = new Set([
  "review.deep_to_quick_fallback",
  "usage_guard.fail_open",
  "hitl.rejected",
  "loop.hit_cap",
]);

/**
 * Resolve the minimum-n guard (env override → default).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveMinN(env = process.env) {
  const raw = env?.SKILL_METRICS_MIN_N;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_MIN_N;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MIN_N;
}

/**
 * Parse `--key=value` / `--flag` argv into a flat object.
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
export function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq === -1) out[body] = true;
    else out[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return out;
}

/**
 * Parse an events.jsonl string into valid event objects (malformed lines and
 * non-objects are skipped, never thrown on).
 * @param {string} text
 * @returns {Array<Record<string, any>>}
 */
export function parseEvents(text) {
  const events = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === "object" && !Array.isArray(o)) events.push(o);
    } catch {
      // skip malformed line
    }
  }
  return events;
}

/**
 * Aggregate events into a rollup. Pure (no I/O), so it is fully unit-testable.
 * Rates are emitted only when the denominator >= minN; otherwise the rate is
 * null and `*_suppressed` is true (counts still shown).
 * @param {Array<Record<string, any>>} events
 * @param {{ minN?: number, since?: string, skill?: string }} [opts]
 * @returns {Record<string, any>}
 */
export function aggregate(events, { minN = DEFAULT_MIN_N, since, skill } = {}) {
  const filtered = events.filter((e) => {
    if (since && typeof e.ts === "string" && e.ts < since) return false;
    if (skill && e.skill !== skill) return false;
    return true;
  });

  const sessions = new Set();
  const skills = {};
  const signals = {};
  const notable = [];
  let timeline = { since: null, until: null };

  const ensure = (name) => {
    if (!skills[name]) {
      skills[name] = {
        invocations: 0,
        by_operation: {},
        outcomes: { completed: 0, aborted: 0, fallback: 0 },
      };
    }
    return skills[name];
  };

  for (const e of filtered) {
    if (typeof e.ts === "string") {
      if (!timeline.since || e.ts < timeline.since) timeline.since = e.ts;
      if (!timeline.until || e.ts > timeline.until) timeline.until = e.ts;
    }
    if (typeof e.session_id === "string") sessions.add(e.session_id);

    switch (e.event) {
      case "start": {
        const s = ensure(e.skill);
        s.invocations += 1;
        const op = typeof e.operation === "string" ? e.operation : "unknown";
        s.by_operation[op] = (s.by_operation[op] ?? 0) + 1;
        break;
      }
      case "outcome": {
        const s = ensure(e.skill);
        if (e.status && e.status in s.outcomes) s.outcomes[e.status] += 1;
        if (e.status === "aborted") {
          notable.push({ kind: "outcome", skill: e.skill, status: "aborted", ts: e.ts ?? null });
        }
        break;
      }
      case "signal": {
        if (typeof e.name === "string") {
          signals[e.name] = (signals[e.name] ?? 0) + 1;
          if (FRICTION_SIGNALS.has(e.name)) {
            notable.push({ kind: "signal", skill: e.skill, name: e.name, ts: e.ts ?? null });
          }
        }
        break;
      }
      default:
        break; // heartbeat and unknown events only contribute to window/sessions
    }
  }

  // Derive a min-n-guarded abort rate per skill.
  for (const s of Object.values(skills)) {
    const denom = s.outcomes.completed + s.outcomes.aborted + s.outcomes.fallback;
    if (denom >= minN) {
      s.abort_rate = Math.round((s.outcomes.aborted / denom) * 1000) / 1000;
      s.abort_rate_suppressed = false;
    } else {
      s.abort_rate = null;
      s.abort_rate_suppressed = true; // n < minN → counts only, no misleading rate
    }
  }

  return {
    window: { since: timeline.since, until: timeline.until, events: filtered.length, sessions: sessions.size },
    min_n: minN,
    skills,
    signals,
    notable,
  };
}

/**
 * Compute ISO-8601 year-week (e.g. "2026-W26") for a snapshot filename.
 * @param {Date} d
 * @returns {string}
 */
export function isoYearWeek(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Snapshot filenames are exactly `<ISO year-week>.json` (e.g. "2026-W27.json").
// ISO year-week strings sort chronologically under plain string comparison
// (fixed-width year + zero-padded week), so no date parsing is needed to order
// them — a lexicographic max below the current week is "last week's" baseline.
const SNAPSHOT_RE = /^(\d{4}-W\d{2})\.json$/;

/**
 * Extract the ISO year-week key from a snapshot basename, or null if the name
 * is not a `<YYYY-Www>.json` snapshot file.
 * @param {string} name
 * @returns {string|null}
 */
export function snapshotWeek(name) {
  const m = SNAPSHOT_RE.exec(basename(String(name)));
  return m ? m[1] : null;
}

/**
 * Pick the most recent snapshot strictly older than `currentWeek` — the
 * previous-generation baseline for a trend diff. Non-snapshot names and the
 * current week itself are ignored. Pure (no I/O) for unit-testability.
 * @param {string[]} files snapshot dir entries (basenames)
 * @param {string} currentWeek ISO year-week of the run (e.g. "2026-W27")
 * @returns {{ week: string, file: string }|null}
 */
export function pickPreviousSnapshot(files, currentWeek) {
  let best = null;
  for (const name of files ?? []) {
    const week = snapshotWeek(name);
    if (!week) continue;
    if (currentWeek && week >= currentWeek) continue; // skip current + future
    if (!best || week > best.week) best = { week, file: basename(String(name)) };
  }
  return best;
}

/**
 * Diff the current rollup against a previous-generation snapshot rollup
 * (week-over-week). COUNT deltas (invocations, signals) are always emitted;
 * RATE deltas (abort_rate) inherit skill-metrics' min-n guard — a rate delta is
 * emitted only when BOTH generations cleared the guard (a non-null, un-suppressed
 * abort_rate on each side). Otherwise the delta is null + `*_suppressed: true`.
 * Pure (no I/O) so it is fully unit-testable.
 * @param {Record<string, any>} current current rollup
 * @param {Record<string, any>} previous previous-generation rollup (from a snapshot file)
 * @param {{ minN?: number }} [opts]
 * @returns {Record<string, any>|null}
 */
export function computeTrend(current, previous, { minN = DEFAULT_MIN_N } = {}) {
  if (!previous || typeof previous !== "object") return null;
  const curSkills = current?.skills ?? {};
  const prevSkills = previous?.skills ?? {};
  const skills = {};
  for (const name of new Set([...Object.keys(curSkills), ...Object.keys(prevSkills)])) {
    const cur = curSkills[name] ?? {};
    const prev = prevSkills[name] ?? {};
    const entry = { invocations_delta: (cur.invocations ?? 0) - (prev.invocations ?? 0) };
    // Rate delta only when BOTH sides have a min-n-cleared (non-null) rate.
    const curRate = typeof cur.abort_rate === "number" ? cur.abort_rate : null;
    const prevRate = typeof prev.abort_rate === "number" ? prev.abort_rate : null;
    if (curRate !== null && prevRate !== null) {
      entry.abort_rate_delta = Math.round((curRate - prevRate) * 1000) / 1000;
      entry.abort_rate_delta_suppressed = false;
    } else {
      entry.abort_rate_delta = null;
      entry.abort_rate_delta_suppressed = true; // n<min_n on ≥1 side → counts only
    }
    skills[name] = entry;
  }

  const curSignals = current?.signals ?? {};
  const prevSignals = previous?.signals ?? {};
  const signals = {};
  for (const name of new Set([...Object.keys(curSignals), ...Object.keys(prevSignals)])) {
    signals[name] = (curSignals[name] ?? 0) - (prevSignals[name] ?? 0);
  }

  return {
    min_n: minN,
    baseline_window: previous?.window
      ? { since: previous.window.since ?? null, until: previous.window.until ?? null }
      : null,
    skills,
    signals,
  };
}

/**
 * Load the previous-generation snapshot rollup for trend comparison (fail-open:
 * a missing dir / unreadable or malformed snapshot yields null, never throws).
 * @returns {Promise<{ week: string, file: string, rollup: Record<string, any> }|null>}
 */
async function loadPreviousSnapshot({ snapshotsDir, currentWeek, existsImpl, readdirImpl, readImpl, warn }) {
  try {
    if (!existsImpl(snapshotsDir)) return null;
    const entries = await readdirImpl(snapshotsDir);
    const pick = pickPreviousSnapshot(entries, currentWeek);
    if (!pick) return null;
    const file = join(snapshotsDir, pick.file);
    const rollup = JSON.parse(await readImpl(file));
    if (!rollup || typeof rollup !== "object") return null;
    return { week: pick.week, file, rollup };
  } catch (err) {
    warn(`skill-metrics: previous snapshot unreadable (${err?.message ?? err}); no trend`);
    return null;
  }
}

/**
 * Load + aggregate (fail-open: a missing/unreadable log yields an empty rollup,
 * never an error). Returns the rollup; optionally writes a weekly snapshot.
 * @param {string[]} argv
 * @param {object} [deps]
 * @returns {Promise<Record<string, any>>}
 */
export async function run(
  argv = [],
  {
    readImpl = (p) => readFile(p, "utf8"),
    existsImpl = existsSync,
    writeImpl = writeFile,
    readdirImpl = (d) => readdir(d),
    mkdirImpl = (d) => mkdir(d, { recursive: true }),
    eventsPath = EVENTS_PATH,
    snapshotsDir = SNAPSHOTS_DIR,
    env = process.env,
    now = () => new Date(),
    warn = (msg) => process.stderr.write(`${msg}\n`),
  } = {},
) {
  const args = parseArgs(argv);
  const minN = resolveMinN(env);
  let text = "";
  try {
    if (existsImpl(eventsPath)) text = await readImpl(eventsPath);
  } catch (err) {
    warn(`skill-metrics: events log unreadable (${err?.message ?? err}); empty rollup`);
  }
  const rollup = aggregate(parseEvents(text), {
    minN,
    since: typeof args.since === "string" ? args.since : undefined,
    skill: typeof args.skill === "string" ? args.skill : undefined,
  });

  // Trend vs. the previous-generation snapshot (week-over-week). Computed on
  // every run: a prior snapshot must already exist (written by a past
  // `--snapshot`), and the current week's file — if just being written — is
  // excluded by the strictly-older pick. Absent baseline → trend: null.
  const currentWeek = isoYearWeek(now());
  const prev = await loadPreviousSnapshot({
    snapshotsDir,
    currentWeek,
    existsImpl,
    readdirImpl,
    readImpl,
    warn,
  });
  if (prev) {
    rollup.trend = computeTrend(rollup, prev.rollup, { minN });
    if (rollup.trend) {
      rollup.trend.baseline_week = prev.week;
      rollup.trend.baseline_file = prev.file;
    }
  } else {
    rollup.trend = null;
  }

  if (args.snapshot) {
    try {
      await mkdirImpl(snapshotsDir);
      const file = join(snapshotsDir, `${currentWeek}.json`);
      // Persist a clean baseline: strip the derived `trend`/`snapshot` fields so
      // a future week diffs against pure counts, not a self-referential nesting.
      const baseline = { ...rollup };
      delete baseline.trend;
      delete baseline.snapshot;
      await writeImpl(file, `${JSON.stringify(baseline, null, 2)}\n`);
      rollup.snapshot = file;
    } catch (err) {
      warn(`skill-metrics: snapshot write failed (${err?.message ?? err})`);
    }
  }
  return rollup;
}

// CLI entry: print the rollup JSON for the SKILL.md to render.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2)).then((rollup) => {
    process.stdout.write(`${JSON.stringify(rollup, null, 2)}\n`);
    process.exit(0);
  });
}
