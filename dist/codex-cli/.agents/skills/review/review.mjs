#!/usr/bin/env node
// review — deterministic engine for the `review` skill (ADR-0028 R1).
//
// Owns the determinism that used to be "prose the LLM re-interprets" in
// SKILL.md, while leaving the actual review judgment (what findings exist) to
// the LLM. Two concerns, both machine-decidable:
//
//   1. perspective SELECTION (ADR-0025 選別ロジック): given the changed-file
//      set + each `perspectives/<axis>.md` frontmatter, decide which axes apply
//      (required always / default_enabled:false only when named / skip_when
//      .diff_only_in highest priority / applies_when OR-match). `--axes` is an
//      explicit override that applies exactly the named axes.
//   2. AGGREGATION + RENDER: given the findings JSON the LLM produced, merge
//      duplicates (same file:line:issue across axes), keep principled conflicts
//      separate (no severity), compute the summary, group axis→severity→file,
//      and emit the human report with the `<!-- review-json:v1 ... -->` embed
//      that drive re-reads. The review-json Schema v1 (ADR-0025) is unchanged.
//
// Prior art (same reason, already scripted): health-check.mjs / usage-check.mjs
// / skill-metrics.mjs. Self-contained (Node stdlib only) so it ships verbatim
// into every adapter payload as a review skill asset. The frontmatter parse is
// intentionally inlined (not imported from scripts/lib) for the same reason.
//
// CLI:
//   node review.mjs select [--axes=a,b] [--perspectives-dir=DIR] [--changed-file=F]
//       Read the changed-file list (from --changed-file, else stdin, one path
//       per line) + the perspective frontmatter, print the "適用観点" block.
//       --json prints the structured selection instead.
//   node review.mjs render [--input=FINDINGS.json]
//       Read the findings JSON (from --input, else stdin), print the human
//       report with the embedded review-json:v1. --json prints just the v1 JSON.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REVIEW_JSON_VERSION = "1";

// ADR-0025 canonical order (category order: required → design → quality → ux).
// Used for deterministic within-category ordering and report grouping. Axes not
// in this list sort after, alphabetically.
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

export const CATEGORY_ORDER = ["required", "design", "quality", "ux"];
const SEVERITY_ORDER = ["critical", "warning", "info"];
const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };

// ---------------------------------------------------------------------------
// glob matching (POSIX-style path globs used in perspective frontmatter)
// ---------------------------------------------------------------------------

/**
 * Convert a path glob (globstar, star, question mark, literals) to an anchored
 * RegExp.
 *  - star matches any run of characters except a slash
 *  - a globstar followed by a slash matches zero or more path segments
 *  - a trailing globstar matches anything, including slashes
 *  - question mark matches a single non-slash character
 * Exported for tests.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++; // consume second '*'
        if (glob[i + 1] === "/") {
          re += "(?:[^/]+/)*"; // "**/" → zero or more path segments
          i++; // consume the '/'
        } else {
          re += ".*"; // trailing "**" → anything, incl. slashes
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

const _reCache = new Map();
function globRe(glob) {
  let re = _reCache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    _reCache.set(glob, re);
  }
  return re;
}

/** True when `file` matches at least one of `globs`. Exported for tests. */
export function matchesAny(file, globs) {
  return (globs ?? []).some((g) => globRe(g).test(file));
}

// ---------------------------------------------------------------------------
// perspective frontmatter parsing (inline flow arrays/objects only)
// ---------------------------------------------------------------------------

function frontmatterBlock(raw) {
  const m = String(raw).match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
}

function topLevelLines(block) {
  const map = {};
  for (const line of block.split("\n")) {
    const fm = line.match(/^([A-Za-z_][\w-]*):(.*)$/);
    if (fm) map[fm[1]] = fm[2].trim();
  }
  return map;
}

function quotedStrings(value) {
  if (!value) return [];
  return [...value.matchAll(/"([^"]*)"|'([^']*)'/g)].map((g) => g[1] ?? g[2]);
}

function unquote(v) {
  const s = String(v ?? "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Parse one perspective MD into the fields selection needs. Returns null when
 * the frontmatter block is missing. `diffOnlyIn` is `null` when `skip_when` is
 * absent (distinct from an empty `[]`, which means "never skip"). Exported for
 * tests.
 * @param {string} raw
 * @returns {{name:string,category:string,appliesWhen:string[],diffOnlyIn:string[]|null,defaultEnabled:boolean}|null}
 */
export function parsePerspectiveFrontmatter(raw) {
  const block = frontmatterBlock(raw);
  if (!block) return null;
  const map = topLevelLines(block);
  return {
    name: unquote(map.name),
    category: unquote(map.category),
    appliesWhen: quotedStrings(map.applies_when),
    diffOnlyIn: "skip_when" in map ? quotedStrings(map.skip_when) : null,
    // default_enabled defaults to true when unspecified (only false opts out).
    defaultEnabled: !("default_enabled" in map) || unquote(map.default_enabled) !== "false",
  };
}

/**
 * Load + parse all `perspectives/<axis>.md` in `dir` (README.md excluded), in
 * filename order. Injectable fs for tests. Skips files with no frontmatter.
 * @param {string} dir
 * @param {{readdirImpl?:(d:string)=>string[], readImpl?:(p:string)=>string}} [deps]
 */
export function loadPerspectives(dir, deps = {}) {
  const readdirImpl = deps.readdirImpl ?? ((d) => readdirSync(d));
  const readImpl = deps.readImpl ?? ((p) => readFileSync(p, "utf8"));
  const files = readdirImpl(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort();
  const list = [];
  for (const f of files) {
    const parsed = parsePerspectiveFrontmatter(readImpl(join(dir, f)));
    if (!parsed) continue;
    if (!parsed.name) parsed.name = f.replace(/\.md$/, "");
    list.push(parsed);
  }
  return list;
}

// ---------------------------------------------------------------------------
// selection (ADR-0025 選別ロジック)
// ---------------------------------------------------------------------------

function axisRank(name) {
  const i = AXIS_ORDER.indexOf(name);
  return i === -1 ? AXIS_ORDER.length : i;
}

function sortAxes(names) {
  return [...names].sort((a, b) => axisRank(a) - axisRank(b) || a.localeCompare(b));
}

/**
 * Decide the applied axes.
 *  - explicitAxes (`--axes`) is an exact override: apply exactly those that
 *    exist as perspectives (ignoring applies_when/skip_when, enabling any
 *    default_enabled:false). Names with no perspective are returned as `unknown`.
 *  - otherwise, per ADR-0025 priority:
 *      1. category:required            → always
 *      2. default_enabled:false        → only when named in --axes (never here)
 *      3. skip_when.diff_only_in match → skip (all changed files ⊆ the glob set)
 *      4. applies_when OR-match        → apply
 *      5. else                         → skip
 * @param {{changedFiles:string[], perspectives:Array, explicitAxes?:string[]|null}} input
 * @returns {{axesApplied:string[], byCategory:Record<string,string[]>, total:number, unknownAxes:string[]}}
 */
export function selectAxes({ changedFiles = [], perspectives = [], explicitAxes = null }) {
  const total = perspectives.length;
  const byName = new Map(perspectives.map((p) => [p.name, p]));
  let applied;
  let unknownAxes = [];

  if (Array.isArray(explicitAxes) && explicitAxes.length > 0) {
    applied = [];
    for (const axis of explicitAxes) {
      if (byName.has(axis)) applied.push(axis);
      else unknownAxes.push(axis);
    }
  } else {
    applied = [];
    for (const p of perspectives) {
      if (p.category === "required") {
        applied.push(p.name);
        continue;
      }
      if (!p.defaultEnabled) continue; // experimental: opt-in via --axes only
      // skip_when has priority: skip when the diff is confined to the glob set.
      if (
        Array.isArray(p.diffOnlyIn) &&
        p.diffOnlyIn.length > 0 &&
        changedFiles.length > 0 &&
        changedFiles.every((f) => matchesAny(f, p.diffOnlyIn))
      ) {
        continue;
      }
      if (changedFiles.some((f) => matchesAny(f, p.appliesWhen))) applied.push(p.name);
    }
  }

  applied = sortAxes(applied);
  unknownAxes = [...new Set(unknownAxes)];

  const byCategory = {};
  for (const cat of CATEGORY_ORDER) byCategory[cat] = [];
  for (const name of applied) {
    const cat = byName.get(name)?.category ?? "other";
    (byCategory[cat] ??= []).push(name);
  }
  for (const cat of Object.keys(byCategory)) {
    if (byCategory[cat].length === 0) delete byCategory[cat];
  }

  return { axesApplied: applied, byCategory, total, unknownAxes };
}

const CATEGORY_LABEL_WIDTH = 10; // aligns "required:"/"design:"/"quality:"/"ux:" + 1 space

/** Render the "適用観点 (n/total):" block. Exported for tests + CLI. */
export function renderSelection(sel) {
  const lines = [`適用観点 (${sel.axesApplied.length}/${sel.total}):`];
  for (const cat of CATEGORY_ORDER) {
    const axes = sel.byCategory[cat];
    if (!axes || axes.length === 0) continue;
    lines.push(`  ${`${cat}:`.padEnd(CATEGORY_LABEL_WIDTH)}${axes.join(", ")}`);
  }
  if (sel.unknownAxes.length > 0) {
    lines.push(`  (未知の観点: ${sel.unknownAxes.join(", ")})`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// aggregation (dedup + conflicts + summary) — Schema v1
// ---------------------------------------------------------------------------

function dedupKey(f) {
  return `${f.file ?? ""} ${f.line ?? ""} ${(f.issue ?? "").trim()}`;
}

function maxSeverity(a, b) {
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

/**
 * Merge findings that share the same file:line:issue (possibly across axes) into
 * one, recording every contributing axis in `axes_merged` and keeping the
 * highest severity. The primary `axis` is the first-seen one (stable input
 * order). Returns the merged list; does not sort. Exported for tests.
 * @param {Array} findings
 */
export function dedupeFindings(findings) {
  const byKey = new Map();
  const order = [];
  for (const f of findings ?? []) {
    const key = dedupKey(f);
    const existing = byKey.get(key);
    if (!existing) {
      const merged = { ...f, axis: f.axis, _axes: new Set(f.axis ? [f.axis] : []) };
      byKey.set(key, merged);
      order.push(key);
      continue;
    }
    existing.severity = maxSeverity(existing.severity, f.severity);
    if (f.axis) existing._axes.add(f.axis);
    // Preserve why/suggestion if the first finding lacked them.
    if (!existing.why && f.why) existing.why = f.why;
    if (!existing.suggestion && f.suggestion) existing.suggestion = f.suggestion;
  }
  return order.map((key) => {
    const f = byKey.get(key);
    const axes = [...f._axes];
    const out = {
      axis: f.axis,
      severity: f.severity,
      file: f.file,
      line: f.line ?? null,
      issue: f.issue,
    };
    if (f.why) out.why = f.why;
    if (f.suggestion) out.suggestion = f.suggestion;
    if (axes.length > 1) out.axes_merged = sortAxes(axes);
    return out;
  });
}

function sortFindings(findings) {
  return [...findings].sort(
    (a, b) =>
      axisRank(a.axis) - axisRank(b.axis) ||
      String(a.axis).localeCompare(String(b.axis)) ||
      (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) ||
      String(a.file).localeCompare(String(b.file)) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

function computeSummary(findings, axesApplied) {
  const by_axis = {};
  for (const axis of axesApplied ?? []) by_axis[axis] = { critical: 0, warning: 0, info: 0 };
  const total = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) {
    const sev = SEVERITY_ORDER.includes(f.severity) ? f.severity : null;
    if (!sev) continue;
    (by_axis[f.axis] ??= { critical: 0, warning: 0, info: 0 })[sev]++;
    total[sev]++;
  }
  return { by_axis, total };
}

/**
 * Build the review-json:v1 result object from raw LLM findings.
 * @param {{mode?:string, axes_applied?:string[], findings?:Array, conflicts?:Array}} input
 * @returns {object}
 */
export function aggregate(input = {}) {
  const mode = input.mode === "deep" ? "deep" : "quick";
  const axesApplied = sortAxes(input.axes_applied ?? []);
  const merged = sortFindings(dedupeFindings(input.findings));
  const summary = computeSummary(merged, axesApplied);
  const result = {
    version: REVIEW_JSON_VERSION,
    mode,
    axes_applied: axesApplied,
    findings: merged,
    summary,
  };
  const conflicts = (input.conflicts ?? []).map((c) => ({
    axes: c.axes ?? [],
    file: c.file,
    line: c.line ?? null,
    description: c.description,
  }));
  if (conflicts.length > 0) result.conflicts = conflicts;
  return result;
}

// ---------------------------------------------------------------------------
// rendering (human report + review-json embed)
// ---------------------------------------------------------------------------

const SEVERITY_LABEL = { critical: "Critical", warning: "Warning", info: "Info" };

function renderFinding(f) {
  const lines = [`[${SEVERITY_LABEL[f.severity] ?? f.severity}] ${f.file}:${f.line ?? "?"}`];
  const merged = f.axes_merged ? ` (${f.axes_merged.join(" + ")})` : "";
  lines[0] += merged;
  if (f.issue) lines.push(`  問題: ${f.issue}`);
  if (f.why) lines.push(`  理由: ${f.why}`);
  if (f.suggestion) lines.push(`  提案: ${f.suggestion}`);
  return lines;
}

/**
 * Render the human-readable report (axis → severity → file grouping + conflicts
 * + summary), WITHOUT the JSON embed. Exported for tests.
 * @param {object} result  an aggregate() result
 */
export function renderReport(result) {
  const lines = [`レビュー結果 (mode: ${result.mode}, axes: ${result.axes_applied.join(", ")}):`];

  const byAxis = new Map();
  for (const f of result.findings) {
    if (!byAxis.has(f.axis)) byAxis.set(f.axis, []);
    byAxis.get(f.axis).push(f);
  }
  for (const axis of sortAxes([...byAxis.keys()])) {
    lines.push("", `## ${axis}`);
    for (const f of byAxis.get(axis)) lines.push(...renderFinding(f));
  }

  if (result.conflicts && result.conflicts.length > 0) {
    lines.push("", "## conflicts");
    for (const c of result.conflicts) {
      lines.push(`[${(c.axes ?? []).join(" ↔ ")}] ${c.file}:${c.line ?? "?"}`);
      if (c.description) lines.push(`  ${c.description}`);
    }
  }

  const t = result.summary.total;
  lines.push("", "## サマリー", `  Critical: ${t.critical} 件`, `  Warning:  ${t.warning} 件`);
  lines.push(`  Info:     ${t.info} 件`, "", "  by_axis:");
  for (const axis of sortAxes(Object.keys(result.summary.by_axis))) {
    const a = result.summary.by_axis[axis];
    lines.push(`    ${`${axis}:`.padEnd(16)}C${a.critical} W${a.warning} I${a.info}`);
  }
  return lines.join("\n");
}

/**
 * Render the report with the `<!-- review-json:v1 ... -->` embed appended (the
 * form drive re-reads). Exported for tests + CLI.
 * @param {object} result  an aggregate() result
 */
export function renderWithJson(result) {
  const report = renderReport(result);
  const json = JSON.stringify(result, null, 2);
  return `${report}\n\n<!-- review-json:v${REVIEW_JSON_VERSION}\n${json}\n-->\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Parse `--key=value` / `--flag` argv into a flat object. Exported for tests. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq === -1) out[body] = true;
    else out[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return out;
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function defaultPerspectivesDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "perspectives");
}

function cmdSelect(args) {
  const dir = typeof args["perspectives-dir"] === "string" ? args["perspectives-dir"] : defaultPerspectivesDir();
  const raw =
    typeof args["changed-file"] === "string" ? readFileSync(args["changed-file"], "utf8") : readStdin();
  const changedFiles = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const explicitAxes =
    typeof args.axes === "string"
      ? args.axes.split(",").map((a) => a.trim()).filter(Boolean)
      : null;
  const perspectives = existsSync(dir) ? loadPerspectives(dir) : [];
  const sel = selectAxes({ changedFiles, perspectives, explicitAxes });
  if (args.json) return `${JSON.stringify(sel, null, 2)}\n`;
  return `${renderSelection(sel)}\n`;
}

function cmdRender(args) {
  const raw = typeof args.input === "string" ? readFileSync(args.input, "utf8") : readStdin();
  let input;
  try {
    input = JSON.parse(raw || "{}");
  } catch (e) {
    process.stderr.write(`review render: invalid findings JSON: ${e.message}\n`);
    process.exitCode = 1;
    return "";
  }
  const result = aggregate(input);
  if (args.json) return `${JSON.stringify(result, null, 2)}\n`;
  return renderWithJson(result);
}

export function run(argv) {
  const args = parseArgs(argv);
  const sub = args._[0];
  if (sub === "select") return cmdSelect(args);
  if (sub === "render") return cmdRender(args);
  return "usage: review.mjs <select|render> [--axes=..] [--perspectives-dir=..] [--changed-file=..] [--input=..] [--json]\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = run(process.argv.slice(2));
  if (out) process.stdout.write(out);
}
