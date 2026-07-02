// Tests for drive-report.mjs — the deterministic aggregation/report engine for
// the `drive` skill (ADR-0028 R1). Covers the Phase 5 (single) and Phase
// Final-6 (aggregate) report shapes, by_axis / total aggregation, cross-cutting
// display, and — the #168 contract this engine must preserve — the
// `再開: /drive <元の引数>` resume line output/suppression conditions and the
// argument-restoration convention (drop the deprecated --usage-guard).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateReviewTotals,
  buildResumeCommand,
  cleanupSummary,
  crossCuttingSummary,
  formatByAxis,
  renderAggregate,
  renderSingle,
  shouldEmitResumeAggregate,
  shouldEmitResumeSingle,
  statusCounts,
  totalReviewIterations,
} from "../.agents/skills/drive/drive-report.mjs";

const RESUME_PREFIX = "再開:";

// --- resume-command restoration (argument-restoration convention) ------------

test("buildResumeCommand: drops the deprecated --usage-guard, keeps the rest", () => {
  assert.equal(
    buildResumeCommand("#1,#2 --merge --usage-guard --no-usage-guard"),
    "/drive #1,#2 --merge --no-usage-guard",
  );
  assert.equal(buildResumeCommand("#180 --review=quick"), "/drive #180 --review=quick");
  assert.equal(buildResumeCommand(""), "/drive");
});

// --- single-mode resume gate -------------------------------------------------

test("shouldEmitResumeSingle: failed / merge-ready → yes; completed → no", () => {
  assert.ok(shouldEmitResumeSingle("failed"));
  assert.ok(shouldEmitResumeSingle("merge-ready"));
  assert.ok(!shouldEmitResumeSingle("merged"));
  assert.ok(!shouldEmitResumeSingle("auto-merge enabled"));
});

// --- aggregate resume gate ---------------------------------------------------

test("shouldEmitResumeAggregate: any failed / merge-ready / skipped → yes", () => {
  assert.ok(shouldEmitResumeAggregate([{ status: "merged" }, { status: "failed" }]));
  assert.ok(shouldEmitResumeAggregate([{ status: "skipped" }]));
  assert.ok(shouldEmitResumeAggregate([{ status: "merge-ready" }]));
  assert.ok(!shouldEmitResumeAggregate([{ status: "merged" }, { status: "merged" }]));
});

// --- by_axis / totals aggregation --------------------------------------------

test("formatByAxis: canonical axis order, C<n>W<n>I<n> format", () => {
  const s = formatByAxis({
    security: { critical: 0, warning: 1, info: 0 },
    correctness: { critical: 0, warning: 0, info: 2 },
  });
  // correctness precedes security in the ADR-0025 canonical order
  assert.equal(s, "correctness:C0W0I2 security:C0W1I0");
});

test("formatByAxis: unknown axes sort after known ones, alphabetically", () => {
  const s = formatByAxis({ zeta: { info: 1 }, correctness: { info: 1 }, alpha: { info: 1 } });
  assert.equal(s, "correctness:C0W0I1 alpha:C0W0I1 zeta:C0W0I1");
});

test("aggregateReviewTotals: sums critical/warning/info across results", () => {
  const total = aggregateReviewTotals([
    { review: { total: { critical: 1, warning: 2, info: 3 } } },
    { review: { total: { critical: 0, warning: 1, info: 0 } } },
    { status: "skipped" },
  ]);
  assert.deepEqual(total, { critical: 1, warning: 3, info: 3 });
});

test("totalReviewIterations: sums iterations, missing → 0", () => {
  assert.equal(
    totalReviewIterations([{ review: { iterations: 2 } }, { review: { iterations: 3 } }, {}]),
    5,
  );
});

test("statusCounts: counts by status; missing status → failed", () => {
  const counts = statusCounts([
    { status: "merged" },
    { status: "merged" },
    {},
    { status: "skipped" },
  ]);
  assert.deepEqual(counts, { merged: 2, failed: 1, skipped: 1 });
});

// --- Phase 5 single-mode report ----------------------------------------------

test("renderSingle: full report + resume line for merge-ready (usage-guard stripped)", () => {
  const out = renderSingle({
    target: "#180",
    title: "R1 engine",
    branch: "feat/drive-engine",
    pr_url: "https://x/pr/9",
    pr_number: 9,
    status: "merge-ready",
    review: {
      mode: "quick",
      iterations: 2,
      by_axis: { security: { critical: 0, warning: 1, info: 0 } },
      total: { critical: 0, warning: 1, info: 2 },
    },
    original_args: "#180 --review=quick --usage-guard",
  });
  assert.match(out, /^drive 完了:/);
  assert.ok(out.includes("Issue:    #180 R1 engine"));
  assert.ok(out.includes("レビュー: 2 回実施 (mode: quick)"));
  assert.ok(out.includes("総計 Critical: 0, Warning: 1, Info: 2"));
  assert.ok(out.includes("by_axis: security:C0W1I0"));
  assert.ok(out.includes("状態:     merge-ready"));
  // resume line present, and --usage-guard dropped
  assert.ok(out.includes(`${RESUME_PREFIX}     /drive #180 --review=quick`));
  assert.ok(!out.includes("--usage-guard"));
});

test("renderSingle: resume line suppressed when the run completed (merged)", () => {
  const out = renderSingle({
    target: "#5",
    status: "merged",
    review: { mode: "quick", iterations: 1, total: { critical: 0, warning: 0, info: 0 } },
    original_args: "#5",
  });
  assert.ok(out.includes("状態:     merged"));
  assert.ok(!out.includes(RESUME_PREFIX), "no resume line for a completed single run");
});

test("renderSingle: resume line present for a failed run", () => {
  const out = renderSingle({ target: "#7", status: "failed", original_args: "#7" });
  assert.ok(out.includes(`${RESUME_PREFIX}     /drive #7`));
});

test("renderSingle: opts.originalArgs overrides the result field", () => {
  const out = renderSingle({ target: "#7", status: "failed" }, { originalArgs: "#7 --merge" });
  assert.ok(out.includes("/drive #7 --merge"));
});

// --- Phase Final-6 aggregate report ------------------------------------------

const AGG = {
  results: [
    {
      target: "#1",
      title: "feat: a",
      pr_number: 100,
      status: "merged",
      review: { total: { critical: 0, warning: 0, info: 0 }, iterations: 1 },
    },
    {
      target: "#2",
      title: "fix: b",
      pr_number: 101,
      status: "merged",
      review: { total: { critical: 0, warning: 0, info: 2 }, iterations: 2 },
    },
    { target: "#4", title: "chore: c", status: "skipped", error: "upstream failed: #5" },
    { target: "#5", title: "refactor: d", status: "failed", error: "test loop" },
  ],
  original_args: "#1,#2 -> #4 #5",
  cross_cutting: { resolved: 2, folded_into: ["#100", "#101"] },
  cleanup: { removed: 2, total: 4, preserved: [{ status: "failed" }, { status: "skipped" }] },
};

test("renderAggregate: header, per-target lines, 集計 block", () => {
  const out = renderAggregate(AGG);
  assert.ok(out.startsWith("drive 完了 (2/4 merged, 1 skipped, 1 failed):"));
  assert.ok(out.includes("#1 feat: a"));
  assert.ok(out.includes("| PR #100 | merged"));
  assert.ok(out.includes("(Review: C0 W0 I2)"), "merged rows show review totals");
  assert.ok(out.includes("skipped (upstream failed: #5)"));
  assert.ok(out.includes("failed (test loop)"));
  assert.match(out, /merged:\s+2/);
  assert.match(out, /skipped:\s+1/);
  assert.match(out, /failed:\s+1/);
  assert.match(out, /総レビュー反復:\s+3 回/);
});

test("renderAggregate: cross-cutting + cleanup lines", () => {
  const out = renderAggregate(AGG);
  assert.ok(
    out.includes("cross-cutting:") && out.includes("2 gaps resolved (folded into #100, #101)"),
  );
  assert.ok(
    out.includes("cleanup:") && out.includes("2/4 removed (2 preserved: 1 failed, 1 skipped)"),
  );
});

test("renderAggregate: resume line emitted (leftovers present), usage-guard stripped", () => {
  const out = renderAggregate({ ...AGG, original_args: "#1,#2 -> #4 #5 --usage-guard" });
  assert.ok(out.includes("/drive #1,#2 -> #4 #5"));
  assert.ok(!out.includes("--usage-guard"));
});

test("renderAggregate: resume line suppressed when every target merged", () => {
  const out = renderAggregate({
    results: [
      { target: "#1", title: "a", pr_number: 1, status: "merged" },
      { target: "#2", title: "b", pr_number: 2, status: "merged" },
    ],
    original_args: "#1,#2",
  });
  assert.ok(out.startsWith("drive 完了 (2/2 merged):"));
  assert.ok(!out.includes("再開:"), "no resume line when all merged");
  assert.ok(!out.includes("/drive"), "no resume command when all merged");
});

test("renderAggregate: preserved worktrees surface a warning block", () => {
  const out = renderAggregate(AGG);
  assert.ok(out.includes("残置された作業コピー"));
});

test("renderAggregate: fail-soft cross-cutting shows unresolved warning block", () => {
  const out = renderAggregate({
    ...AGG,
    cross_cutting: {
      resolved: 1,
      unresolved: 1,
      folded_into: ["#100"],
      unresolved_gaps: ["src/cli/foo.ts:213 — help text missing new kind"],
    },
  });
  assert.ok(out.includes("1 resolved, 1 unresolved (warning)"));
  assert.ok(out.includes("Cross-cutting gaps unresolved"));
  assert.ok(out.includes("src/cli/foo.ts:213"));
});

// --- cross-cutting / cleanup summary helpers ---------------------------------

test("crossCuttingSummary: none / resolved / fail-soft variants", () => {
  assert.equal(crossCuttingSummary(null), "none");
  assert.equal(crossCuttingSummary({ resolved: 0, unresolved: 0 }), "none");
  assert.equal(
    crossCuttingSummary({ resolved: 2, folded_into: ["#100"] }),
    "2 gaps resolved (folded into #100)",
  );
  assert.equal(
    crossCuttingSummary({ resolved: 1, unresolved: 2 }),
    "1 resolved, 2 unresolved (warning)",
  );
});

test("cleanupSummary: plain removed vs preserved breakdown", () => {
  assert.equal(cleanupSummary({ removed: 3, total: 3, preserved: [] }), "3/3 removed");
  assert.equal(
    cleanupSummary({
      removed: 2,
      total: 4,
      preserved: [{ status: "failed" }, { status: "skipped" }],
    }),
    "2/4 removed (2 preserved: 1 failed, 1 skipped)",
  );
});
