#!/usr/bin/env node
// drive-report — deterministic aggregation/report engine for the `drive` skill
// (ADR-0028 R1).
//
// Owns the determinism that used to be "prose the LLM re-interprets" in the
// `Phase 5` (single-mode completion report) and `Phase Final-6` (orchestration
// aggregate report) sections of SKILL.md: aggregating worker return JSON
// (status counts, review by_axis / totals, review-iteration sum), rendering the
// two report shapes, aggregating + displaying cross-cutting gaps, and — the
// #168 contract this engine must preserve exactly — the `再開: /drive <元の引数>`
// resume line:
//
//   - single mode: emitted when the run ended `failed` / `merge-ready`,
//     suppressed when it completed (`merged` / `auto-merge enabled`);
//   - orchestration: emitted when ANY target is `failed` / a `merge-ready`
//     leftover / `skipped`, suppressed when every target `merged`;
//   - argument-restoration convention: re-present the original `/drive` args
//     as-is, but drop the deprecated no-op `--usage-guard` alias (never force
//     it on resume); `--no-usage-guard` is carried only when the user specified
//     it (naturally preserved because we restore from the original args).
//
// Pure over its inputs (worker return JSON + Final-phase metadata the host
// gathered), so it is unit-testable without any git or gh. Self-contained (Node
// stdlib only) so it ships verbatim into every adapter payload as a drive skill
// asset.
//
// CLI:
//   node drive-report.mjs single [--input=F]     Phase 5 report from one result
//   node drive-report.mjs aggregate [--input=F]  Phase Final-6 report from
//                                                 { results, ...final-meta }
//   (input is read from --input=<path>, else stdin; --json prints the parsed
//    structured summary instead of the human report.)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = 1;

// ADR-0025 canonical axis order (mirrors review.mjs) for deterministic by_axis
// rendering. Axes not listed sort after, alphabetically.
export const AXIS_ORDER = [
  "correctness",
  "security",
  "conventions",
  "architecture",
  "compatibility",
  "maintainability",
  "testing",
  "performance",
  "observability",
  "usability",
  "documentation",
];

// Statuses that keep the resume line alive.
const SINGLE_RESUME_STATUSES = new Set(["failed", "merge-ready"]);
const AGG_RESUME_STATUSES = new Set(["failed", "merge-ready", "skipped"]);

/**
 * Rebuild the resume command from the original `/drive` args, applying the
 * #168 restoration convention: drop the deprecated no-op `--usage-guard`
 * (never re-force it), carry everything else (targets, deps, `--merge`,
 * `--concurrency`, `--review`, `--no-usage-guard`) verbatim.
 * @param {string} originalArgs
 * @returns {string}
 */
export function buildResumeCommand(originalArgs) {
  const restored = String(originalArgs ?? "")
    .split(/\s+/)
    .filter((t) => t.length > 0 && t !== "--usage-guard")
    .join(" ");
  return `/drive ${restored}`.trim();
}

/** Whether the single-mode Phase 5 report must carry the resume line. */
export function shouldEmitResumeSingle(status) {
  return SINGLE_RESUME_STATUSES.has(status);
}

/** Whether the orchestration Phase Final-6 report must carry the resume line. */
export function shouldEmitResumeAggregate(results) {
  return (results ?? []).some((r) => AGG_RESUME_STATUSES.has(r?.status));
}

/**
 * Count worker results by status (missing status → "failed", the safe default).
 * @param {Array<{status?: string}>} results
 * @returns {Record<string, number>}
 */
export function statusCounts(results) {
  const counts = {};
  for (const r of results ?? []) {
    const s = r?.status ?? "failed";
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return counts;
}

/**
 * Sum review totals (critical / warning / info) across worker results.
 * @param {Array<{review?: {total?: object}}>} results
 * @returns {{critical: number, warning: number, info: number}}
 */
export function aggregateReviewTotals(results) {
  const total = { critical: 0, warning: 0, info: 0 };
  for (const r of results ?? []) {
    const t = r?.review?.total ?? {};
    total.critical += Number(t.critical ?? 0);
    total.warning += Number(t.warning ?? 0);
    total.info += Number(t.info ?? 0);
  }
  return total;
}

/** Total review iterations across worker results (falls back to summing). */
export function totalReviewIterations(results) {
  let sum = 0;
  for (const r of results ?? []) sum += Number(r?.review?.iterations ?? 0);
  return sum;
}

function axisRank(axis) {
  const i = AXIS_ORDER.indexOf(axis);
  return i === -1 ? AXIS_ORDER.length : i;
}

/**
 * Render a by_axis map as `correctness:C0W0I0 security:C0W0I0 ...` in canonical
 * axis order.
 * @param {Record<string, {critical?: number, warning?: number, info?: number}>} byAxis
 * @returns {string}
 */
export function formatByAxis(byAxis) {
  if (!byAxis || typeof byAxis !== "object") return "";
  return Object.keys(byAxis)
    .sort((a, b) => axisRank(a) - axisRank(b) || a.localeCompare(b))
    .map((axis) => {
      const v = byAxis[axis] ?? {};
      return `${axis}:C${Number(v.critical ?? 0)}W${Number(v.warning ?? 0)}I${Number(v.info ?? 0)}`;
    })
    .join(" ");
}

/**
 * Render the single-mode Phase 5 completion report.
 * @param {object} result  one worker/single-mode result (+ optional original_args)
 * @param {{ originalArgs?: string }} [opts]
 * @returns {string}
 */
export function renderSingle(result, opts = {}) {
  const r = result ?? {};
  const review = r.review ?? {};
  const total = review.total ?? { critical: 0, warning: 0, info: 0 };
  const lines = [];
  lines.push("drive 完了:");
  lines.push(`  Issue:    ${r.target ?? "?"} ${r.title ?? ""}`.trimEnd());
  lines.push(`  ブランチ: ${r.branch ?? "-"}`);
  lines.push(`  PR:       ${r.pr_url ?? "-"}`);
  lines.push(`  レビュー: ${Number(review.iterations ?? 0)} 回実施 (mode: ${review.mode ?? "quick"})`);
  lines.push(
    `            総計 Critical: ${Number(total.critical ?? 0)}, Warning: ${Number(total.warning ?? 0)}, Info: ${Number(total.info ?? 0)}`,
  );
  const byAxis = formatByAxis(review.by_axis);
  if (byAxis) lines.push(`            by_axis: ${byAxis}`);
  lines.push(`  状態:     ${r.status ?? "failed"}`);
  if (shouldEmitResumeSingle(r.status)) {
    const cmd = buildResumeCommand(opts.originalArgs ?? r.original_args ?? "");
    lines.push(`  再開:     ${cmd}`);
  }
  return lines.join("\n");
}

/** Build the `(X/Y merged[, N merge-ready][, N skipped][, N failed])` header tail. */
function headerCounts(counts, total) {
  const merged = counts.merged ?? 0;
  const parts = [`${merged}/${total} merged`];
  for (const s of ["merge-ready", "skipped", "failed"]) {
    if (counts[s]) parts.push(`${counts[s]} ${s}`);
  }
  return parts.join(", ");
}

function statusColumn(r) {
  const status = r?.status ?? "failed";
  const reason = r?.error ? ` (${r.error})` : "";
  if (status === "skipped" || status === "failed") return `${status}${reason}`;
  return status;
}

function reviewNote(r) {
  const t = r?.review?.total;
  if (!t) return "";
  return `  (Review: C${Number(t.critical ?? 0)} W${Number(t.warning ?? 0)} I${Number(t.info ?? 0)})`;
}

/**
 * Render the orchestration Phase Final-6 aggregate report.
 * @param {object} data  { results, targets_order?, original_args?,
 *   review_iterations_total?, cross_cutting?, cleanup?, integrity_warnings? }
 * @returns {string}
 */
export function renderAggregate(data) {
  const results = data?.results ?? [];
  const order = data?.targets_order ?? results.map((r) => r.target);
  const byTarget = new Map(results.map((r) => [r.target, r]));
  const counts = statusCounts(results);
  const total = results.length;
  const lines = [];

  lines.push(`drive 完了 (${headerCounts(counts, total)}):`);
  const labelWidth = order.reduce((m, t) => {
    const r = byTarget.get(t) ?? {};
    return Math.max(m, `${t} ${r.title ?? ""}`.trimEnd().length);
  }, 0);
  for (const t of order) {
    const r = byTarget.get(t) ?? { target: t, status: "failed" };
    const label = `${t} ${r.title ?? ""}`.trimEnd().padEnd(labelWidth);
    const pr = r.pr_number ? ` | PR #${r.pr_number}` : "";
    lines.push(`  ${label}${pr} | ${statusColumn(r)}${reviewNote(r)}`.trimEnd());
  }

  lines.push("");
  lines.push("集計:");
  for (const s of ["merged", "merge-ready", "skipped", "failed"]) {
    if (counts[s]) lines.push(`  ${`${s}:`.padEnd(17)}${counts[s]}`);
  }
  const iterations = data?.review_iterations_total ?? totalReviewIterations(results);
  lines.push(`  ${"総レビュー反復:".padEnd(13)}${iterations} 回`);
  lines.push(`  ${"cross-cutting:".padEnd(17)}${crossCuttingSummary(data?.cross_cutting)}`);
  if (data?.cleanup) lines.push(`  ${"cleanup:".padEnd(17)}${cleanupSummary(data.cleanup)}`);

  // resume line — after the 集計 block, gated on leftovers.
  if (shouldEmitResumeAggregate(results)) {
    lines.push("");
    lines.push(buildResumeCommand(data?.original_args ?? ""));
  }

  // warning blocks
  const warnBlocks = [];
  const cc = data?.cross_cutting;
  if (cc?.unresolved && cc.unresolved > 0) {
    warnBlocks.push("⚠️ Cross-cutting gaps unresolved (fail-soft):");
    for (const g of cc.unresolved_gaps ?? []) warnBlocks.push(`  ${typeof g === "string" ? g : JSON.stringify(g)}`);
    warnBlocks.push("  Recommended: 手動で follow-up 対応");
  }
  for (const w of data?.integrity_warnings ?? []) warnBlocks.push(`⚠️ ${w}`);
  if (data?.cleanup?.preserved?.length) {
    const preserved = data.cleanup.preserved
      .map((p) => (typeof p === "string" ? p : p.status ?? "?"))
      .join(", ");
    warnBlocks.push(`⚠️ 残置された作業コピー: ${preserved}（手動 cleanup / /health 領域 #7）`);
  }
  if (warnBlocks.length) {
    lines.push("");
    lines.push(...warnBlocks);
  }

  return lines.join("\n");
}

/** Summary text for the `cross-cutting:` 集計 line. */
export function crossCuttingSummary(cc) {
  if (!cc) return "none";
  const resolved = Number(cc.resolved ?? 0);
  const unresolved = Number(cc.unresolved ?? 0);
  if (resolved === 0 && unresolved === 0) return "none";
  const folded = (cc.folded_into ?? []).join(", ");
  if (unresolved > 0) {
    const base = `${resolved} resolved, ${unresolved} unresolved (warning)`;
    return folded ? `${base}; folded into ${folded}` : base;
  }
  return folded
    ? `${resolved} gaps resolved (folded into ${folded})`
    : `${resolved} gaps resolved`;
}

/** Summary text for the `cleanup:` 集計 line. */
export function cleanupSummary(cleanup) {
  const removed = Number(cleanup.removed ?? 0);
  const total = Number(cleanup.total ?? 0);
  const preserved = cleanup.preserved ?? [];
  if (!preserved.length) return `${removed}/${total} removed`;
  const breakdown = {};
  for (const p of preserved) {
    const s = typeof p === "string" ? p : p.status ?? "?";
    breakdown[s] = (breakdown[s] ?? 0) + 1;
  }
  const detail = Object.entries(breakdown)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
  return `${removed}/${total} removed (${preserved.length} preserved: ${detail})`;
}

function readInput(argv) {
  const fileArg = argv.find((a) => a.startsWith("--input="));
  const path = fileArg ? fileArg.slice("--input=".length) : null;
  const raw = path ? readFileSync(path, "utf8") : readFileSync(0, "utf8");
  return JSON.parse(raw);
}

// CLI entry: single | aggregate subcommand over JSON input.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const json = argv.includes("--json");
  let out = "";
  try {
    const input = readInput(argv.slice(1));
    if (sub === "single") {
      out = json ? JSON.stringify(input, null, 2) : renderSingle(input);
    } else if (sub === "aggregate") {
      out = json ? JSON.stringify(input, null, 2) : renderAggregate(input);
    } else {
      process.stderr.write("usage: drive-report.mjs <single|aggregate> [--input=F] [--json]\n");
      process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`drive-report: ${err.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`${out}\n`);
  process.exit(0);
}
