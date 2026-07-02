// Tests for review.mjs AGGREGATION + RENDER (ADR-0028 R1 / ADR-0025 Schema v1).
//
// The LLM produces raw findings; the engine merges duplicates (same
// file:line:issue across axes), keeps principled conflicts separate, computes
// the summary, groups axis→severity→file, and embeds the `<!-- review-json:v1
// ... -->` marker that drive re-reads. The Schema v1 contract must not change.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  aggregate,
  dedupeFindings,
  REVIEW_JSON_VERSION,
  renderReport,
  renderWithJson,
  run,
} from "../.agents/skills/review/review.mjs";

function finding(axis, severity, file, line, issue, extra = {}) {
  return { axis, severity, file, line, issue, ...extra };
}

// ---------------------------------------------------------------------------
// dedup
// ---------------------------------------------------------------------------

test("dedupeFindings: same file:line:issue across axes merges into one with axes_merged", () => {
  const merged = dedupeFindings([
    finding("security", "warning", "src/x.ts", 42, "unsanitized input"),
    finding("correctness", "warning", "src/x.ts", 42, "unsanitized input"),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].axis, "security"); // first-seen primary
  assert.deepEqual(merged[0].axes_merged, ["correctness", "security"]);
});

test("dedupeFindings: distinct file:line stays separate; no axes_merged on singletons", () => {
  const merged = dedupeFindings([
    finding("security", "warning", "src/x.ts", 42, "a"),
    finding("security", "warning", "src/x.ts", 43, "b"),
  ]);
  assert.equal(merged.length, 2);
  assert.ok(!("axes_merged" in merged[0]));
});

test("dedupeFindings: merge keeps the highest severity and backfills why/suggestion", () => {
  const merged = dedupeFindings([
    finding("correctness", "warning", "src/x.ts", 1, "bug", { suggestion: "fix it" }),
    finding("security", "critical", "src/x.ts", 1, "bug", { why: "exploitable" }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].severity, "critical");
  assert.equal(merged[0].why, "exploitable");
  assert.equal(merged[0].suggestion, "fix it");
});

// ---------------------------------------------------------------------------
// aggregate → Schema v1
// ---------------------------------------------------------------------------

test("aggregate: produces version 1, sorted axes, and a correct summary", () => {
  const result = aggregate({
    mode: "quick",
    axes_applied: ["security", "correctness"],
    findings: [
      finding("security", "critical", "a.ts", 1, "x"),
      finding("correctness", "info", "b.ts", 2, "y"),
      finding("correctness", "warning", "c.ts", 3, "z"),
    ],
  });
  assert.equal(result.version, "1");
  assert.equal(result.mode, "quick");
  assert.deepEqual(result.axes_applied, ["correctness", "security"]);
  assert.deepEqual(result.summary.total, { critical: 1, warning: 1, info: 1 });
  assert.deepEqual(result.summary.by_axis.security, { critical: 1, warning: 0, info: 0 });
  assert.deepEqual(result.summary.by_axis.correctness, { critical: 0, warning: 1, info: 1 });
});

test("aggregate: applied axes with zero findings still appear in by_axis (drive_loop reads them)", () => {
  const result = aggregate({
    axes_applied: ["correctness", "security", "conventions"],
    findings: [finding("security", "warning", "a.ts", 1, "x")],
  });
  assert.deepEqual(result.summary.by_axis.correctness, { critical: 0, warning: 0, info: 0 });
  assert.deepEqual(result.summary.by_axis.conventions, { critical: 0, warning: 0, info: 0 });
});

test("aggregate: conflicts are preserved verbatim without severity", () => {
  const result = aggregate({
    axes_applied: ["security", "usability"],
    findings: [],
    conflicts: [
      { axes: ["security", "usability"], file: "src/y.ts", line: 10, description: "tradeoff" },
    ],
  });
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].description, "tradeoff");
  assert.ok(!("severity" in result.conflicts[0]));
  // no conflicts → the field is omitted
  assert.ok(!("conflicts" in aggregate({ axes_applied: [], findings: [] })));
});

test("aggregate: mode defaults to quick and non-'deep' coerces to quick", () => {
  assert.equal(aggregate({}).mode, "quick");
  assert.equal(aggregate({ mode: "bogus" }).mode, "quick");
  assert.equal(aggregate({ mode: "deep" }).mode, "deep");
});

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

test("renderReport: groups by axis, shows summary and by_axis", () => {
  const result = aggregate({
    mode: "quick",
    axes_applied: ["correctness", "security"],
    findings: [
      finding("security", "critical", "a.ts", 1, "boom", { why: "w", suggestion: "s" }),
      finding("correctness", "warning", "b.ts", 2, "oops"),
    ],
  });
  const report = renderReport(result);
  assert.match(report, /レビュー結果 \(mode: quick, axes: correctness, security\):/);
  assert.match(report, /## correctness/);
  assert.match(report, /## security/);
  assert.match(report, /\[Critical\] a\.ts:1/);
  assert.match(report, /問題: boom/);
  assert.match(report, /Critical: 1 件/);
  assert.match(report, /correctness: +C0 W1 I0/);
});

test("renderReport: shows a conflicts section with the ↔ separator", () => {
  const result = aggregate({
    axes_applied: ["security", "usability"],
    findings: [],
    conflicts: [
      { axes: ["security", "usability"], file: "src/y.ts", line: 10, description: "DX vs safety" },
    ],
  });
  const report = renderReport(result);
  assert.match(report, /## conflicts/);
  assert.match(report, /\[security ↔ usability\] src\/y\.ts:10/);
  assert.match(report, /DX vs safety/);
});

test("renderWithJson: embeds a parseable review-json:v1 that drive can re-read", () => {
  const result = aggregate({
    mode: "quick",
    axes_applied: ["security"],
    findings: [finding("security", "warning", "a.ts", 1, "x")],
  });
  const out = renderWithJson(result);
  assert.match(out, new RegExp(`<!-- review-json:v${REVIEW_JSON_VERSION}`));
  assert.match(out, /-->\s*$/);
  const m = out.match(/<!-- review-json:v1\n([\s\S]*?)\n-->/);
  assert.ok(m, "embed present");
  const parsed = JSON.parse(m[1]);
  assert.equal(parsed.version, "1");
  assert.equal(parsed.summary.total.warning, 1);
  assert.deepEqual(parsed.axes_applied, ["security"]);
});

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

test("run render reads findings JSON and prints the embedded report", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-render-"));
  const input = join(dir, "findings.json");
  writeFileSync(
    input,
    JSON.stringify({
      mode: "quick",
      axes_applied: ["security", "correctness"],
      findings: [
        { axis: "security", severity: "warning", file: "a.ts", line: 1, issue: "dup" },
        { axis: "correctness", severity: "warning", file: "a.ts", line: 1, issue: "dup" },
      ],
    }),
  );
  const out = run(["render", `--input=${input}`]);
  const m = out.match(/<!-- review-json:v1\n([\s\S]*?)\n-->/);
  const parsed = JSON.parse(m[1]);
  assert.equal(parsed.findings.length, 1); // deduped
  assert.deepEqual(parsed.findings[0].axes_merged, ["correctness", "security"]);
});

test("run render --json emits just the v1 object", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-render-json-"));
  const input = join(dir, "f.json");
  writeFileSync(input, JSON.stringify({ axes_applied: [], findings: [] }));
  const parsed = JSON.parse(run(["render", "--json", `--input=${input}`]));
  assert.equal(parsed.version, "1");
});
