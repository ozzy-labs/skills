#!/usr/bin/env node
// drive-plan — deterministic input/DAG/wave engine for the `drive` skill
// (ADR-0028 R1).
//
// Owns the determinism that used to be "prose the LLM re-interprets" in the
// `入力解析` + `Phase 0` sections of SKILL.md: target expansion (`#42` / `42` /
// comma lists / `#3-5` ranges / whitespace lists / mixed / free-text
// instruction), the explicit `->` dependency notation, DAG construction
// (explicit deps + PR base↔head matching + best-effort "depends on #X" in issue
// bodies), topological wave partitioning, cycle detection, the single vs
// orchestration mode decision, and the concurrency / review-mode resolution.
// It returns a structured wave-plan JSON; SKILL.md keeps only the judgment
// layer (drive each unit, review-loop the findings, ask the human where policy
// says to).
//
// The determinism is pure over its inputs, so it is unit-testable without any
// git or gh. Optional target metadata (issue/PR fields the LLM fetched with
// `gh issue view` / `gh pr view`) is passed in for the PR-base and issue-body
// dependency heuristics — the network I/O stays in the judgment layer, the
// graph logic lives here.
//
// Prior art (same reason, already scripted): health-check.mjs / topics.mjs /
// review.mjs / usage-check.mjs. Self-contained (Node stdlib only) so it ships
// verbatim into every adapter payload as a drive skill asset.
//
// CLI:
//   node drive-plan.mjs <args...>              rendered plan (stdout)
//   node drive-plan.mjs <args...> --json       the structured plan JSON
//   node drive-plan.mjs <args...> --meta-file=F merge target metadata (JSON map
//                                               of "#N" -> {kind,title,body,
//                                               baseRefName,headRefName}) for the
//                                               PR-base / issue-body heuristics
//
// `<args...>` is the raw `/drive` argument string (targets + `->` deps +
// user options). `--json` and `--meta-file` are engine-invocation flags and are
// excluded from the preserved `original_args` / `resume_command`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = 1;

// Default parallelism cap (min(4, task count)); N > SOFT_CONCURRENCY_CAP warns
// only (no hard cap — GitHub Actions / rate-limit / cost caveat lives in prose).
export const DEFAULT_CONCURRENCY = 4;
export const SOFT_CONCURRENCY_CAP = 8;

// User-facing option flags that take the following token as their value.
const VALUE_FLAGS = new Set(["concurrency", "review", "meta-file"]);
const VALID_REVIEW_MODES = new Set(["quick", "final-deep", "deep"]);

/**
 * A token is a "ref token" when it is one or more issue/PR references
 * (`#N` / `N`) and/or ranges (`#3-5` / `3-5`), comma-joined.
 * @param {string} token
 * @returns {boolean}
 */
export function isRefToken(token) {
  if (!token) return false;
  return token
    .split(",")
    .every((part) => /^#?\d+(?:-\d+)?$/.test(part.trim()) && part.trim().length > 0);
}

/**
 * Expand one ref token into a list of `#N` targets. Handles single (`#42`/`42`),
 * comma lists (`#1,#2`), ranges (`#3-5`), and mixed (`#1,#3-5`). Reversed ranges
 * (`#5-3`) are normalized ascending. Non-ref tokens yield `[]`.
 * @param {string} token
 * @returns {string[]}
 */
export function expandToken(token) {
  const out = [];
  for (const rawPart of token.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    const m = part.match(/^#?(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const start = Number.parseInt(m[1], 10);
    if (m[2] === undefined) {
      out.push(`#${start}`);
      continue;
    }
    const end = Number.parseInt(m[2], 10);
    const [lo, hi] = start <= end ? [start, end] : [end, start];
    for (let n = lo; n <= hi; n += 1) out.push(`#${n}`);
  }
  return out;
}

/**
 * Tokenize a raw `/drive` argument string. Arguments arrive either as one
 * quoted token (`node drive-plan.mjs "#1,#2 -> #3 --merge"`) or many
 * (`node drive-plan.mjs #1 #2`); joining then splitting on whitespace handles
 * both. `->` is normalized to a standalone token even when written without
 * surrounding spaces (`#1->#2`).
 * @param {string|string[]} argv
 * @returns {string[]}
 */
export function tokenize(argv) {
  const raw = Array.isArray(argv) ? argv.join(" ") : String(argv ?? "");
  return raw
    .replace(/\s*->\s*/g, " -> ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Split argv into the target/dependency expression and the user options,
 * separating engine-only flags. Preserves `->` as its own token in the
 * expression stream. `original_args` reconstructs the user-facing `/drive`
 * args (excludes engine-only `--json` / `--meta-file`).
 * @param {string|string[]} argv
 * @returns {{ exprTokens: string[], options: object, originalArgs: string, metaFile: string|null, json: boolean }}
 */
export function parseArgs(argv) {
  const tokens = tokenize(argv);
  const exprTokens = [];
  const userTokens = [];
  const options = {
    merge: false,
    concurrency: null,
    review: "quick",
    reviewExplicit: false,
    noUsageGuard: false,
    usageGuard: false,
  };
  let metaFile = null;
  let json = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const arg = tokens[i];
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      const key = eq === -1 ? body : body.slice(0, eq);
      let value = eq === -1 ? undefined : body.slice(eq + 1);
      if (value === undefined && VALUE_FLAGS.has(key)) {
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          i += 1;
        }
      }
      switch (key) {
        case "merge":
          options.merge = true;
          userTokens.push("--merge");
          break;
        case "concurrency":
          options.concurrency = value === undefined ? null : Number.parseInt(value, 10);
          userTokens.push(`--concurrency ${value ?? ""}`.trim());
          break;
        case "review":
          if (value !== undefined) {
            options.review = value;
            options.reviewExplicit = true;
          }
          userTokens.push(`--review=${value ?? ""}`);
          break;
        case "no-usage-guard":
          options.noUsageGuard = true;
          userTokens.push("--no-usage-guard");
          break;
        case "usage-guard":
          // Deprecated no-op alias: accepted, but never persisted (dropped from
          // original_args so it is never re-forced on resume).
          options.usageGuard = true;
          break;
        case "json":
          json = true;
          break;
        case "meta-file":
          metaFile = value ?? null;
          break;
        default:
          // Unknown flag: keep it in the user args verbatim (forward-compat).
          userTokens.push(value === undefined ? arg : `--${key}=${value}`);
      }
      continue;
    }
    exprTokens.push(arg);
    userTokens.push(arg);
  }

  return {
    exprTokens,
    options,
    originalArgs: userTokens.join(" ").trim(),
    metaFile,
    json,
  };
}

/**
 * Parse the target/dependency expression into stages (split on `->`), expand
 * every ref token, and decide whether the whole expression is a free-text
 * instruction. Explicit deps: every target in stage k depends on ALL targets in
 * stage k-1 (`#1,#2 -> #3` → #3 deps on #1,#2).
 * @param {string[]} exprTokens
 * @returns {{ targets: string[], explicitDeps: Record<string,string[]>, isInstruction: boolean, instruction: string|null, stages: string[][] }}
 */
export function parseTargetExpression(exprTokens) {
  const expr = exprTokens.join(" ").trim();
  const hasArrow = exprTokens.includes("->");

  // Free-text instruction: no `->` and at least one non-ref token present.
  const nonEmpty = exprTokens.filter((t) => t.length > 0);
  const allRefs = nonEmpty.length > 0 && nonEmpty.every((t) => t === "->" || isRefToken(t));
  if (!hasArrow && (nonEmpty.length === 0 || !allRefs)) {
    if (nonEmpty.length === 0) {
      return { targets: [], explicitDeps: {}, isInstruction: false, instruction: null, stages: [] };
    }
    return {
      targets: [expr],
      explicitDeps: {},
      isInstruction: true,
      instruction: expr,
      stages: [[expr]],
    };
  }

  // Ref mode: split into stages on `->`, expand each stage.
  const stages = [];
  let current = [];
  for (const tok of exprTokens) {
    if (tok === "->") {
      stages.push(current);
      current = [];
    } else {
      current.push(tok);
    }
  }
  stages.push(current);

  const expandedStages = stages.map((stage) => {
    const targets = [];
    for (const tok of stage) targets.push(...expandToken(tok));
    return targets;
  });

  const targets = [];
  const seen = new Set();
  for (const stage of expandedStages) {
    for (const t of stage) {
      if (!seen.has(t)) {
        seen.add(t);
        targets.push(t);
      }
    }
  }

  const explicitDeps = {};
  for (let k = 1; k < expandedStages.length; k += 1) {
    const prev = expandedStages[k - 1];
    for (const t of expandedStages[k]) {
      explicitDeps[t] = [...new Set([...(explicitDeps[t] ?? []), ...prev])];
    }
  }

  return { targets, explicitDeps, isInstruction: false, instruction: null, stages: expandedStages };
}

/**
 * Best-effort scan of an issue/PR body for "depends on #X" style references.
 * Only returns refs that are within the target set (unknown refs are ignored).
 * @param {string} body
 * @param {Set<string>} targetSet
 * @returns {string[]}
 */
export function detectBodyDeps(body, targetSet) {
  if (typeof body !== "string" || body.length === 0) return [];
  const out = new Set();
  const re = /(?:depends on|blocked by|after|requires)\s+#(\d+)/gi;
  let m = re.exec(body);
  while (m !== null) {
    const ref = `#${m[1]}`;
    if (targetSet.has(ref)) out.add(ref);
    m = re.exec(body);
  }
  return [...out];
}

/**
 * Build the dependency map from explicit `->` deps plus optional target
 * metadata (PR base↔head matching + issue-body best-effort). Each edge records
 * its provenance in `depSources`. Self-edges and out-of-set refs are dropped.
 * @param {string[]} targets
 * @param {Record<string,string[]>} explicitDeps
 * @param {Record<string, {kind?: string, body?: string, baseRefName?: string, headRefName?: string}>} [meta]
 * @returns {{ deps: Record<string,string[]>, depSources: Record<string,string> }}
 */
export function buildDag(targets, explicitDeps, meta = {}) {
  const targetSet = new Set(targets);
  const deps = {};
  const depSources = {};
  for (const t of targets) deps[t] = [];

  const addEdge = (from, on, source) => {
    if (from === on) return;
    if (!targetSet.has(from) || !targetSet.has(on)) return;
    if (!deps[from].includes(on)) {
      deps[from].push(on);
      depSources[`${from}<-${on}`] = source;
    }
  };

  // 1. explicit `->` (most authoritative)
  for (const [from, ons] of Object.entries(explicitDeps)) {
    for (const on of ons) addEdge(from, on, "explicit");
  }

  // 2. PR base↔head matching (a PR whose base is another PR's head is stacked).
  const headToTarget = {};
  for (const t of targets) {
    const head = meta[t]?.headRefName;
    if (typeof head === "string" && head.length > 0) headToTarget[head] = t;
  }
  for (const t of targets) {
    const base = meta[t]?.baseRefName;
    if (typeof base === "string" && headToTarget[base] && headToTarget[base] !== t) {
      addEdge(t, headToTarget[base], "pr-base");
    }
  }

  // 3. issue-body best-effort "depends on #X".
  for (const t of targets) {
    for (const on of detectBodyDeps(meta[t]?.body ?? "", targetSet)) {
      addEdge(t, on, "issue-body");
    }
  }

  return { deps, depSources };
}

/**
 * Partition the DAG into topological waves (levels). Nodes with no outstanding
 * dependencies form each successive wave; within a wave, the original target
 * order is preserved. A cycle (nodes that can never be scheduled) is reported.
 * @param {string[]} targets
 * @param {Record<string,string[]>} deps
 * @returns {{ waves: string[][], cycle: string[]|null }}
 */
export function topoWaves(targets, deps) {
  const remaining = new Set(targets);
  const waves = [];
  while (remaining.size > 0) {
    const ready = targets.filter(
      (t) => remaining.has(t) && (deps[t] ?? []).every((d) => !remaining.has(d)),
    );
    if (ready.length === 0) {
      // Nothing schedulable while nodes remain → cycle among the remainder.
      return { waves, cycle: [...remaining] };
    }
    waves.push(ready);
    for (const t of ready) remaining.delete(t);
  }
  return { waves, cycle: null };
}

/**
 * Resolve the effective concurrency and any soft-cap warning.
 * @param {number} taskCount
 * @param {number|null} override
 * @returns {{ concurrency: number, warning: string|null }}
 */
export function computeConcurrency(taskCount, override) {
  const base = Math.min(DEFAULT_CONCURRENCY, Math.max(taskCount, 1));
  if (override === null || override === undefined || Number.isNaN(override)) {
    return { concurrency: base, warning: null };
  }
  const n = Math.max(1, override);
  const warning =
    override > SOFT_CONCURRENCY_CAP
      ? `並列度 ${override} は推奨上限 ${SOFT_CONCURRENCY_CAP} を超過（GitHub Actions 枠 / API rate limit / コストに注意、続行します）`
      : null;
  return { concurrency: n, warning };
}

/**
 * Resolve the effective review mode. Orchestration forces `quick`; an explicit
 * `final-deep` / `deep` there is downgraded with a warning (cost management).
 * An unknown mode also falls back to `quick`.
 * @param {string} requested
 * @param {boolean} reviewExplicit
 * @param {"single"|"orchestration"} mode
 * @returns {{ review: string, warning: string|null }}
 */
export function effectiveReview(requested, reviewExplicit, mode) {
  if (!VALID_REVIEW_MODES.has(requested)) {
    return { review: "quick", warning: reviewExplicit ? `未知の --review=${requested}、quick にフォールバック` : null };
  }
  if (mode === "orchestration" && requested !== "quick") {
    return {
      review: "quick",
      warning: `オーケストレーションでは --review=quick を強制（指定された ${requested} を無視、コスト管理）`,
    };
  }
  return { review: requested, warning: null };
}

/** Strip the deprecated `--usage-guard` no-op alias from a user-args string. */
export function restoreArgs(originalArgs) {
  return String(originalArgs ?? "")
    .split(/\s+/)
    .filter((t) => t.length > 0 && t !== "--usage-guard")
    .join(" ");
}

/**
 * Full run: parse → expand targets → build DAG → topo waves → mode / concurrency
 * / review resolution. Never throws; returns the structured plan.
 * @param {string[]} argv
 * @param {{ meta?: object }} [deps]
 * @returns {object}
 */
export function run(argv = [], deps = {}) {
  const parsed = parseArgs(argv);
  let meta = deps.meta ?? {};
  if (!deps.meta && parsed.metaFile) {
    try {
      meta = JSON.parse(readFileSync(parsed.metaFile, "utf8"));
    } catch (err) {
      meta = {};
      parsed.metaError = `meta-file 読込失敗: ${err.message}`;
    }
  }

  const { targets, explicitDeps, isInstruction, instruction } = parseTargetExpression(
    parsed.exprTokens,
  );

  const result = {
    schema_version: SCHEMA_VERSION,
    raw_args: (Array.isArray(argv) ? argv.join(" ") : String(argv ?? "")).trim(),
    original_args: parsed.originalArgs,
    resume_command: `/drive ${restoreArgs(parsed.originalArgs)}`.trim(),
    options: {
      merge: parsed.options.merge,
      concurrency: parsed.options.concurrency,
      review: parsed.options.review,
      no_usage_guard: parsed.options.noUsageGuard,
    },
    is_instruction: isInstruction,
    instruction,
    targets,
  };
  if (parsed.metaError) result.meta_error = parsed.metaError;

  if (targets.length === 0) {
    result.mode = "single";
    result.error = "no target or instruction provided";
    result.deps = {};
    result.waves = [];
    result.concurrency = 1;
    result.review = "quick";
    return result;
  }

  const { deps: depMap, depSources } = isInstruction
    ? { deps: { [targets[0]]: [] }, depSources: {} }
    : buildDag(targets, explicitDeps, meta);
  result.deps = depMap;
  result.dep_sources = depSources;

  const hasDeps = Object.values(depMap).some((d) => d.length > 0);
  const mode = targets.length >= 2 || hasDeps ? "orchestration" : "single";
  result.mode = mode;

  const { waves, cycle } = topoWaves(targets, depMap);
  if (cycle) {
    result.error = "circular dependency detected";
    result.cycle = cycle;
    result.waves = [];
    result.concurrency = 1;
    result.review = "quick";
    return result;
  }
  result.waves = waves;

  const { concurrency, warning: concWarning } = computeConcurrency(
    targets.length,
    parsed.options.concurrency,
  );
  result.concurrency = concurrency;

  const { review, warning: reviewWarning } = effectiveReview(
    parsed.options.review,
    parsed.options.reviewExplicit,
    mode,
  );
  result.review = review;

  const warnings = [concWarning, reviewWarning].filter(Boolean);
  if (parsed.options.usageGuard) {
    warnings.push("--usage-guard は deprecated no-op エイリアス（既定 ON のため無視）");
  }
  result.warnings = warnings;

  return result;
}

// ---------------------------------------------------------------------------
// rendering (deterministic; owned by the engine, not the LLM)
// ---------------------------------------------------------------------------

/**
 * Render the structured plan into the human `drive 開始` block.
 * @param {object} plan
 * @returns {string}
 */
export function render(plan) {
  const lines = [];
  if (plan.error) {
    lines.push(`Error: ${plan.error}`);
    if (plan.cycle?.length) lines.push(`  循環: ${plan.cycle.join(" -> ")}`);
    return lines.join("\n");
  }

  if (plan.mode === "single") {
    lines.push("drive 開始 (単一モード):");
    lines.push(`  Target:   ${plan.is_instruction ? "(指示) " : ""}${plan.targets[0]}`);
    lines.push(`  --merge:  ${plan.options.merge ? "有効" : "無効"}`);
    lines.push(`  review:   ${plan.review}`);
    for (const w of plan.warnings ?? []) lines.push(`  ⚠️ ${w}`);
    return lines.join("\n");
  }

  lines.push("drive 開始:");
  lines.push(`  Targets:  ${plan.targets.join(", ")}`);
  lines.push(`  並列度:    ${plan.concurrency} (既定: min(4, タスク数))`);
  lines.push(`  --merge:  ${plan.options.merge ? "有効" : "無効"}`);
  lines.push(`  review:   ${plan.review}`);
  lines.push("  Waves:");
  plan.waves.forEach((wave, i) => {
    const upstream = [
      ...new Set(wave.flatMap((t) => plan.deps[t] ?? [])),
    ];
    const parallel = wave.length > 1 ? "並列" : "";
    const dep = upstream.length ? `← ${upstream.join(", ")}` : "";
    const note = [parallel, dep].filter(Boolean).join(", ");
    lines.push(`    Wave ${i + 1}: ${wave.join(", ")}${note ? ` (${note})` : ""}`);
  });
  for (const w of plan.warnings ?? []) lines.push(`  ⚠️ ${w}`);
  return lines.join("\n");
}

// CLI entry: render the plan (or --json for the structured result).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const plan = run(argv);
  if (parseArgs(argv).json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  else process.stdout.write(`${render(plan)}\n`);
  process.exit(0);
}
