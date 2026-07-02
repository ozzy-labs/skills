// Tests for drive-plan.mjs — the deterministic input/DAG/wave engine for the
// `drive` skill (ADR-0028 R1). Pure over its inputs (no git/gh), so every
// target-expansion pattern, the `->` dependency notation, DAG construction
// (explicit + PR-base + issue-body), topological wave partitioning, cycle
// detection, and the mode / concurrency / review resolution are exercised
// directly on data.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDag,
  computeConcurrency,
  detectBodyDeps,
  effectiveReview,
  expandToken,
  isRefToken,
  parseArgs,
  parseTargetExpression,
  restoreArgs,
  run,
  tokenize,
  topoWaves,
} from "../.agents/skills/drive/drive-plan.mjs";

// --- tokenization ------------------------------------------------------------

test("tokenize: one quoted arg and many args are equivalent; normalizes ->", () => {
  assert.deepEqual(tokenize(["#1,#2 -> #3"]), ["#1,#2", "->", "#3"]);
  assert.deepEqual(tokenize(["#1", "#2"]), ["#1", "#2"]);
  assert.deepEqual(tokenize("#1->#2"), ["#1", "->", "#2"]);
  assert.deepEqual(tokenize("  #1   ->   #2  "), ["#1", "->", "#2"]);
});

// --- ref-token classification + expansion ------------------------------------

test("isRefToken: refs/ranges/comma-lists are refs; prose is not", () => {
  assert.ok(isRefToken("#42"));
  assert.ok(isRefToken("42"));
  assert.ok(isRefToken("#1,#2"));
  assert.ok(isRefToken("#3-5"));
  assert.ok(isRefToken("#1,#3-5"));
  assert.ok(!isRefToken("add"));
  assert.ok(!isRefToken("dark-mode"));
  assert.ok(!isRefToken(""));
});

test("expandToken: single / comma / range / mixed / reversed range", () => {
  assert.deepEqual(expandToken("#42"), ["#42"]);
  assert.deepEqual(expandToken("42"), ["#42"]);
  assert.deepEqual(expandToken("#1,#2"), ["#1", "#2"]);
  assert.deepEqual(expandToken("#3-5"), ["#3", "#4", "#5"]);
  assert.deepEqual(expandToken("#1,#3-5"), ["#1", "#3", "#4", "#5"]);
  assert.deepEqual(expandToken("#5-3"), ["#3", "#4", "#5"], "reversed range normalizes ascending");
  assert.deepEqual(expandToken("dark-mode"), []);
});

// --- target expansion (all argument shapes) ----------------------------------

test("expand: single #42 / 42 → single-mode, one target", () => {
  for (const arg of ["#42", "42"]) {
    const plan = run([arg]);
    assert.equal(plan.mode, "single");
    assert.deepEqual(plan.targets, ["#42"]);
    assert.equal(plan.is_instruction, false);
  }
});

test("expand: comma list #1,#2 → orchestration, two parallel targets", () => {
  const plan = run(["#1,#2"]);
  assert.deepEqual(plan.targets, ["#1", "#2"]);
  assert.equal(plan.mode, "orchestration");
  assert.deepEqual(plan.waves, [["#1", "#2"]]);
});

test("expand: range #3-5 → #3,#4,#5", () => {
  const plan = run(["#3-5"]);
  assert.deepEqual(plan.targets, ["#3", "#4", "#5"]);
  assert.deepEqual(plan.waves, [["#3", "#4", "#5"]]);
});

test("expand: whitespace list #1 #2 → two targets (single quoted arg)", () => {
  const plan = run(["#1 #2"]);
  assert.deepEqual(plan.targets, ["#1", "#2"]);
});

test("expand: mixed #1,#3-5 → #1,#3,#4,#5 (dedup, order preserved)", () => {
  const plan = run(["#1,#3-5"]);
  assert.deepEqual(plan.targets, ["#1", "#3", "#4", "#5"]);
});

test("expand: dedup keeps first-seen order across comma+range", () => {
  const plan = run(["#3 #1,#3-5"]);
  assert.deepEqual(plan.targets, ["#3", "#1", "#4", "#5"]);
});

test("expand: free-text instruction → single mode, whole string is the target", () => {
  const plan = run(["add a dark mode toggle"]);
  assert.equal(plan.mode, "single");
  assert.equal(plan.is_instruction, true);
  assert.deepEqual(plan.targets, ["add a dark mode toggle"]);
  assert.equal(plan.instruction, "add a dark mode toggle");
});

test("expand: mixed ref + prose (no arrow) is treated as an instruction", () => {
  const plan = run(["#1 fix the flaky test"]);
  assert.equal(plan.is_instruction, true);
  assert.deepEqual(plan.targets, ["#1 fix the flaky test"]);
});

// --- explicit -> dependency notation -----------------------------------------

test("explicit deps: #1,#2 -> #3 (parallel then join)", () => {
  const { targets, explicitDeps } = parseTargetExpression(["#1,#2", "->", "#3"]);
  assert.deepEqual(targets, ["#1", "#2", "#3"]);
  assert.deepEqual(explicitDeps, { "#3": ["#1", "#2"] });
});

test("explicit deps: #1 -> #2 -> #3 (fully serial) → one target per wave", () => {
  const plan = run(["#1 -> #2 -> #3"]);
  assert.equal(plan.mode, "orchestration");
  assert.deepEqual(plan.deps, { "#1": [], "#2": ["#1"], "#3": ["#2"] });
  assert.deepEqual(plan.waves, [["#1"], ["#2"], ["#3"]]);
});

test("explicit deps: single target with an arrow still forces orchestration", () => {
  // #1 -> #2 has two targets, but even a lone dependency makes it orchestration
  const plan = run(["#1 -> #2"]);
  assert.equal(plan.mode, "orchestration");
});

// --- DAG construction from metadata ------------------------------------------

test("buildDag: PR base↔head matching registers a stacked dependency", () => {
  const meta = {
    "#1": { kind: "pr", headRefName: "feat/a", baseRefName: "main" },
    "#2": { kind: "pr", headRefName: "feat/b", baseRefName: "feat/a" },
  };
  const { deps, depSources } = buildDag(["#1", "#2"], {}, meta);
  assert.deepEqual(deps["#2"], ["#1"], "#2 (base=feat/a) depends on #1 (head=feat/a)");
  assert.deepEqual(deps["#1"], []);
  assert.equal(depSources["#2<-#1"], "pr-base");
});

test("detectBodyDeps: best-effort 'depends on #X' only within the target set", () => {
  const set = new Set(["#1", "#2"]);
  assert.deepEqual(detectBodyDeps("This depends on #1 and blocked by #2", set), ["#1", "#2"]);
  assert.deepEqual(detectBodyDeps("after #1", set), ["#1"]);
  assert.deepEqual(detectBodyDeps("depends on #99", set), [], "out-of-set refs ignored");
  assert.deepEqual(detectBodyDeps("no refs here", set), []);
});

test("buildDag: issue-body dependency detected via metadata", () => {
  const meta = { "#3": { kind: "issue", body: "blocked by #1" } };
  const { deps, depSources } = buildDag(["#1", "#3"], {}, meta);
  assert.deepEqual(deps["#3"], ["#1"]);
  assert.equal(depSources["#3<-#1"], "issue-body");
});

test("buildDag: explicit deps win provenance over body detection (no dup edge)", () => {
  const meta = { "#2": { body: "depends on #1" } };
  const { deps, depSources } = buildDag(["#1", "#2"], { "#2": ["#1"] }, meta);
  assert.deepEqual(deps["#2"], ["#1"]);
  assert.equal(depSources["#2<-#1"], "explicit");
});

// --- topological wave partitioning -------------------------------------------

test("topoWaves: diamond DAG partitions into correct topological levels", () => {
  // #1 -> #2, #1 -> #3, #2/#3 -> #4
  const deps = { "#1": [], "#2": ["#1"], "#3": ["#1"], "#4": ["#2", "#3"] };
  const { waves, cycle } = topoWaves(["#1", "#2", "#3", "#4"], deps);
  assert.equal(cycle, null);
  assert.deepEqual(waves, [["#1"], ["#2", "#3"], ["#4"]]);
});

test("topoWaves: independent targets all land in wave 1", () => {
  const deps = { "#1": [], "#2": [], "#3": [] };
  const { waves } = topoWaves(["#1", "#2", "#3"], deps);
  assert.deepEqual(waves, [["#1", "#2", "#3"]]);
});

test("topoWaves: within a wave, original target order is preserved", () => {
  const deps = { "#3": [], "#1": [], "#2": [] };
  const { waves } = topoWaves(["#3", "#1", "#2"], deps);
  assert.deepEqual(waves, [["#3", "#1", "#2"]]);
});

// --- cycle detection ---------------------------------------------------------

test("topoWaves: 2-cycle is detected and reported", () => {
  const deps = { "#1": ["#2"], "#2": ["#1"] };
  const { waves, cycle } = topoWaves(["#1", "#2"], deps);
  assert.deepEqual(waves, []);
  assert.deepEqual(new Set(cycle), new Set(["#1", "#2"]));
});

test("topoWaves: partial cycle leaves the acyclic prefix scheduled", () => {
  const deps = { "#0": [], "#1": ["#2"], "#2": ["#1"] };
  const { waves, cycle } = topoWaves(["#0", "#1", "#2"], deps);
  assert.deepEqual(waves, [["#0"]]);
  assert.deepEqual(new Set(cycle), new Set(["#1", "#2"]));
});

test("run: circular dependency (via metadata) surfaces an error + cycle", () => {
  const meta = { "#1": { body: "depends on #2" }, "#2": { body: "depends on #1" } };
  const plan = run(["#1,#2"], { meta });
  assert.equal(plan.error, "circular dependency detected");
  assert.deepEqual(new Set(plan.cycle), new Set(["#1", "#2"]));
  assert.deepEqual(plan.waves, []);
});

// --- concurrency resolution --------------------------------------------------

test("computeConcurrency: default is min(4, taskCount)", () => {
  assert.equal(computeConcurrency(2, null).concurrency, 2);
  assert.equal(computeConcurrency(10, null).concurrency, 4);
  assert.equal(computeConcurrency(1, null).concurrency, 1);
});

test("computeConcurrency: override wins; N>8 warns only (no hard cap)", () => {
  assert.equal(computeConcurrency(2, 6).concurrency, 6);
  const over = computeConcurrency(2, 12);
  assert.equal(over.concurrency, 12);
  assert.match(over.warning, /推奨上限/);
});

// --- review-mode resolution --------------------------------------------------

test("effectiveReview: single mode honors quick/final-deep/deep", () => {
  assert.equal(effectiveReview("final-deep", true, "single").review, "final-deep");
  assert.equal(effectiveReview("deep", true, "single").review, "deep");
  assert.equal(effectiveReview("quick", false, "single").review, "quick");
});

test("effectiveReview: orchestration forces quick and warns on final-deep/deep", () => {
  const r = effectiveReview("deep", true, "orchestration");
  assert.equal(r.review, "quick");
  assert.match(r.warning, /quick を強制/);
});

test("effectiveReview: unknown mode falls back to quick", () => {
  assert.equal(effectiveReview("turbo", true, "single").review, "quick");
});

test("run: orchestration downgrades an explicit --review=deep to quick (warning)", () => {
  const plan = run(["#1,#2 --review=deep"]);
  assert.equal(plan.review, "quick");
  assert.ok(plan.warnings.some((w) => /quick を強制/.test(w)));
});

// --- option parsing + argument restoration -----------------------------------

test("parseArgs: --merge / --concurrency / --review / --no-usage-guard captured", () => {
  const parsed = parseArgs(["#1 --merge --concurrency 3 --review=final-deep --no-usage-guard"]);
  assert.equal(parsed.options.merge, true);
  assert.equal(parsed.options.concurrency, 3);
  assert.equal(parsed.options.review, "final-deep");
  assert.equal(parsed.options.noUsageGuard, true);
});

test("restoreArgs: drops the deprecated --usage-guard, keeps everything else", () => {
  assert.equal(
    restoreArgs("#1 --merge --usage-guard --no-usage-guard"),
    "#1 --merge --no-usage-guard",
  );
  assert.equal(restoreArgs("#1 --review=deep"), "#1 --review=deep");
});

test("run: resume_command restores original args without --usage-guard", () => {
  const plan = run(["#1,#2 --merge --usage-guard"]);
  assert.equal(plan.resume_command, "/drive #1,#2 --merge");
  assert.ok(!plan.resume_command.includes("--usage-guard"));
});

test("run: --usage-guard is accepted but flagged as a deprecated no-op", () => {
  const plan = run(["#1 --usage-guard"]);
  assert.ok(plan.warnings.some((w) => /deprecated no-op/.test(w)));
  assert.ok(!plan.original_args.includes("--usage-guard"));
});

// --- empty / error inputs ----------------------------------------------------

test("run: no targets → single-mode error, no throw", () => {
  const plan = run([""]);
  assert.equal(plan.error, "no target or instruction provided");
  assert.equal(plan.mode, "single");
});
