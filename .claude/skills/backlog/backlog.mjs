#!/usr/bin/env node
// backlog — deterministic collect/prioritize/handoff engine for the `backlog`
// skill (ADR-0028 R1).
//
// Owns ALL the determinism for "what should drive work on next": open-issue
// collection (`gh issue list --state open --json …`), dependency extraction
// (REUSED from the drive engine — see below), the fixed-vocabulary priority
// sort, the `auto-ok` label gating for `--auto` (HATL), and the emission of a
// drive-ready argument string (`#12,#15 -> #18`). It returns a structured JSON
// result; SKILL.md keeps only the judgment layer: how to present the
// candidates, where the policy `externally-visible` gate confirms the drive
// launch, and (Claude Code) the AskUserQuestion / `/drive` wiring.
//
// Dependency-notation SSOT is the drive skill, NOT this engine. The "depends on
// #X" / "blocked by #X" / "after #X" grammar and the topological wave split are
// imported verbatim from `../drive/drive-plan.mjs` (detectBodyDeps + topoWaves)
// so the rule lives in exactly one place and never drifts (issue #175). This is
// deliberate reuse — this file does NOT re-encode that regex.
//
// Prior art (same reason, already scripted): drive-plan.mjs / topics.mjs /
// health-check.mjs / policy-read.mjs. Node stdlib only (plus the sibling drive
// engine import); the pure/injectable functions are exported so tests drive it
// without a network or a real gh.
//
// Output modes (CLI):
//   node backlog.mjs                    collect + prioritize + present a PLAN
//                                       (drive-ready arg string), rendered text
//   node backlog.mjs --drive[=N]        select the top-N closure for a drive
//                                       handoff (host confirms, then launches)
//   node backlog.mjs --auto             confirmation-free handoff, but ONLY over
//                                       `auto-ok`-labelled issues (HATL gate)
//   node backlog.mjs --json             the structured JSON result (any mode)
//   node backlog.mjs --repo owner/repo  target repo (default: cwd's origin)
//   node backlog.mjs --label <filter>   pass-through issue label filter
//   node backlog.mjs --limit N          collection cap (default 20)

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// Dependency-notation SSOT: reuse the drive engine's rule + wave split verbatim.
import { detectBodyDeps, topoWaves } from "../drive/drive-plan.mjs";

export const SCHEMA_VERSION = 1;

// Default collection cap for `gh issue list`.
export const DEFAULT_LIMIT = 20;

// HATL boundary label: `--auto` only ever hands issues carrying THIS label to
// drive. The human sets the boundary by applying the label; the engine never
// invents approval.
export const AUTO_OK_LABEL = "auto-ok";

// Fixed high-priority label vocabulary (priority rule (c)). Matched case-
// insensitively against issue label names. Documented in SKILL.md; Claude does
// not extend this by free judgment.
export const HIGH_PRIORITY_LABELS = new Set(["priority:high", "priority: high", "p0", "p1"]);

// Missing/undated milestone sorts last in priority rule (b).
const FAR_FUTURE = Number.MAX_SAFE_INTEGER;

// Flags that consume the following argv token as their value.
const VALUE_FLAGS = new Set(["repo", "repo-root", "label", "limit"]);

/**
 * Build a spawnSync-backed command runner bound to a cwd. Mirrors
 * topics.mjs / health-check.mjs so tests inject a fake in the same shape.
 * @param {string} cmd
 * @param {string} cwd
 * @returns {(args: string[]) => { status: number, stdout: string, stderr: string, error: Error|null }}
 */
export function makeRunner(cmd, cwd) {
  return (args) => {
    const res = spawnSync(cmd, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30000,
    });
    return {
      status: res.status === null ? (res.error ? -1 : 1) : res.status,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      error: res.error ?? null,
    };
  };
}

/**
 * Parse argv into flags. `--repo` / `--repo-root` / `--label` / `--limit`
 * consume the next token (or use `--key=value`); `--drive` is boolean OR takes
 * `=N`; other `--flags` are booleans.
 * @param {string[]} argv
 * @returns {{ repo?: string, "repo-root"?: string, label?: string, limit: number, drive: boolean, driveN: number|null, auto: boolean, json: boolean }}
 */
export function parseArgs(argv) {
  const out = { limit: DEFAULT_LIMIT, drive: false, driveN: null, auto: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue; // backlog takes no positional args
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);
    let value = eq === -1 ? undefined : body.slice(eq + 1);
    if (value === undefined && VALUE_FLAGS.has(key)) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i += 1;
      }
    }
    switch (key) {
      case "drive": {
        out.drive = true;
        const n = value === undefined ? Number.NaN : Number.parseInt(value, 10);
        out.driveN = Number.isFinite(n) && n > 0 ? n : null;
        break;
      }
      case "auto":
        out.auto = true;
        break;
      case "json":
        out.json = true;
        break;
      case "limit": {
        const n = Number.parseInt(String(value ?? ""), 10);
        if (Number.isFinite(n) && n > 0) out.limit = n;
        break;
      }
      default:
        out[key] = value === undefined ? true : value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// repo resolution (small, self-contained — not the drive dependency rule)
// ---------------------------------------------------------------------------

/**
 * Extract `owner/repo` from a git remote URL (ssh or https). Returns null when
 * the URL is not a recognizable GitHub remote.
 * @param {string} url
 * @returns {string|null}
 */
export function parseRepoSlug(url) {
  const s = String(url).trim();
  const m = s.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function resolveRepo(gitRun, explicit) {
  if (typeof explicit === "string" && explicit.length > 0) {
    return { repo: explicit, error: null };
  }
  const r = gitRun(["remote", "get-url", "origin"]);
  if (r.error || r.status !== 0) return { repo: null, error: "no GitHub remote" };
  const slug = parseRepoSlug(r.stdout);
  return slug ? { repo: slug, error: null } : { repo: null, error: "no GitHub remote" };
}

function classifyGhError(r) {
  if (r.error) return r.error.code === "ENOENT" ? "gh not installed" : "gh error";
  const s = String(r.stderr).toLowerCase();
  if (/not logged|authentication|gh auth login|no oauth token/.test(s)) return "gh not authenticated";
  if (/rate limit|api rate/.test(s)) return "rate limit";
  if (/could not resolve host|network|timed out|dial tcp|connection refused/.test(s)) return "network";
  return "gh command failed";
}

// ---------------------------------------------------------------------------
// collection (gh issue list)
// ---------------------------------------------------------------------------

/**
 * Collect open issues via `gh issue list --state open --json …`. Returns the
 * raw issue array, or an { error } classification when gh fails.
 * @param {(args: string[]) => { status: number, stdout: string, stderr: string, error: Error|null }} ghRun
 * @param {{ repo?: string|null, label?: string, limit?: number }} opts
 * @returns {{ issues: any[]|null, error: string|null }}
 */
export function fetchIssues(ghRun, { repo, label, limit = DEFAULT_LIMIT } = {}) {
  const args = [
    "issue",
    "list",
    "--state",
    "open",
    "--json",
    "number,title,labels,updatedAt,milestone,body",
    "--limit",
    String(limit),
  ];
  if (repo) args.push("--repo", repo);
  if (label) args.push("--label", label);
  const r = ghRun(args);
  if (r.error || r.status !== 0) return { issues: null, error: classifyGhError(r) };
  try {
    const parsed = JSON.parse(r.stdout || "[]");
    return { issues: Array.isArray(parsed) ? parsed : [], error: null };
  } catch {
    return { issues: null, error: "unparseable gh output" };
  }
}

/**
 * Normalize one raw gh issue into the flat record the sorter consumes.
 * @param {any} raw
 * @returns {{ number: number, ref: string, title: string, labels: string[], updated_at: string|null, milestone: string|null, milestone_due_on: string|null, body: string }}
 */
export function normalizeIssue(raw) {
  const labels = Array.isArray(raw?.labels)
    ? raw.labels.map((l) => (typeof l === "string" ? l : (l?.name ?? ""))).filter(Boolean)
    : [];
  return {
    number: raw?.number,
    ref: `#${raw?.number}`,
    title: typeof raw?.title === "string" ? raw.title : "",
    labels,
    updated_at: typeof raw?.updatedAt === "string" ? raw.updatedAt : null,
    milestone: raw?.milestone?.title ?? null,
    milestone_due_on: raw?.milestone?.dueOn ?? null,
    body: typeof raw?.body === "string" ? raw.body : "",
  };
}

// ---------------------------------------------------------------------------
// dependency graph (REUSED from drive-plan.mjs — no rule re-encoded here)
// ---------------------------------------------------------------------------

/**
 * Build the dependency map across the collected issues by delegating to the
 * drive engine's `detectBodyDeps` (the single SSOT for "depends on #X"). Each
 * issue's deps are restricted to the collected set (drive's own semantics).
 * @param {Array<{ ref: string, body: string }>} issues
 * @returns {{ deps: Record<string, string[]>, blockers: Set<string> }}
 */
export function buildDeps(issues) {
  const refSet = new Set(issues.map((i) => i.ref));
  const deps = {};
  const blockers = new Set();
  for (const issue of issues) {
    const on = detectBodyDeps(issue.body, refSet);
    deps[issue.ref] = on;
    for (const b of on) blockers.add(b); // b is depended-upon → a blocker
  }
  return { deps, blockers };
}

// ---------------------------------------------------------------------------
// priority sort (fixed vocabulary — the core determinism)
// ---------------------------------------------------------------------------

function milestoneDueMs(issue) {
  if (!issue.milestone_due_on) return FAR_FUTURE;
  const t = Date.parse(issue.milestone_due_on);
  return Number.isFinite(t) ? t : FAR_FUTURE;
}

function updatedAtMs(issue) {
  if (!issue.updated_at) return FAR_FUTURE; // unknown update time sorts last
  const t = Date.parse(issue.updated_at);
  return Number.isFinite(t) ? t : FAR_FUTURE;
}

export function isHighPriority(issue) {
  return issue.labels.some((l) => HIGH_PRIORITY_LABELS.has(String(l).toLowerCase()));
}

export function hasAutoOk(issue) {
  return issue.labels.some((l) => String(l).toLowerCase() === AUTO_OK_LABEL);
}

/**
 * Sort issues by the fixed priority vocabulary, fully deterministic:
 *   (a) blocker (depended-upon by another collected issue) first
 *   (b) milestone due date ascending (missing/undated last)
 *   (c) `priority:high`-class label first
 *   (d) updatedAt oldest first (staleness)
 *   tie-break: issue number ascending
 * Returns a NEW array (does not mutate input) with per-issue decision flags.
 * @param {Array<object>} issues
 * @param {Set<string>} blockers
 * @returns {Array<object>}
 */
export function prioritize(issues, blockers) {
  const decorated = issues.map((issue) => ({
    ...issue,
    is_blocker: blockers.has(issue.ref),
    is_high_priority: isHighPriority(issue),
    auto_ok: hasAutoOk(issue),
  }));
  const key = (i) => [
    i.is_blocker ? 0 : 1,
    milestoneDueMs(i),
    i.is_high_priority ? 0 : 1,
    updatedAtMs(i),
    typeof i.number === "number" ? i.number : FAR_FUTURE,
  ];
  return decorated.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let n = 0; n < ka.length; n += 1) {
      if (ka[n] < kb[n]) return -1;
      if (ka[n] > kb[n]) return 1;
    }
    return 0;
  });
}

/**
 * A short deterministic rationale string for one prioritized issue.
 * @param {object} issue
 * @returns {string}
 */
export function rationale(issue) {
  const parts = [];
  if (issue.is_blocker) parts.push("blocker");
  if (issue.milestone_due_on) parts.push(`milestone due ${issue.milestone_due_on.slice(0, 10)}`);
  else if (issue.milestone) parts.push(`milestone ${issue.milestone}`);
  if (issue.is_high_priority) parts.push("priority:high");
  if (issue.updated_at) parts.push(`updated ${issue.updated_at.slice(0, 10)}`);
  return parts.length ? parts.join("; ") : "no priority signal";
}

// ---------------------------------------------------------------------------
// drive-arg emission (wave split REUSED from drive-plan.mjs)
// ---------------------------------------------------------------------------

/**
 * Transitive dependency set of a ref within a (acyclic) dep map.
 * @param {string} ref
 * @param {Record<string, string[]>} deps
 * @param {Map<string, Set<string>>} [memo]
 * @param {Set<string>} [seen]  cycle guard (defensive; callers pass acyclic)
 * @returns {Set<string>}
 */
function transitiveDeps(ref, deps, memo = new Map(), seen = new Set()) {
  if (memo.has(ref)) return memo.get(ref);
  if (seen.has(ref)) return new Set();
  seen.add(ref);
  const out = new Set();
  for (const d of deps[ref] ?? []) {
    out.add(d);
    for (const t of transitiveDeps(d, deps, memo, seen)) out.add(t);
  }
  memo.set(ref, out);
  return out;
}

/**
 * A wave rendering (`w1 -> w2 -> …`) is FAITHFUL only when every node in wave k
 * transitively depends on every node in all earlier waves — because drive reads
 * `A,B -> C` as "C depends on BOTH A and B". If an independent node were bundled
 * into an earlier wave, the rendering would fabricate a dependency edge, which
 * drive would honor (over-serializing and — worse — falsely skipping a
 * downstream target when an unrelated wave-mate fails). When not faithful we
 * fall back to a flat list instead.
 * @param {string[][]} waves
 * @param {Record<string, string[]>} deps
 * @returns {boolean}
 */
function isFaithfulWaves(waves, deps) {
  const memo = new Map();
  for (let k = 1; k < waves.length; k += 1) {
    const earlier = waves.slice(0, k).flat();
    for (const node of waves[k]) {
      const tdeps = transitiveDeps(node, deps, memo);
      if (earlier.some((e) => !tdeps.has(e))) return false;
    }
  }
  return true;
}

/**
 * Render an ordered ref list + dep map into a drive argument string. The
 * dependency-notation is drive's own: waves render as `w1 -> w2 -> …` (within a
 * wave the priority order is preserved, since topoWaves keeps input order), but
 * ONLY when that rendering is faithful (see isFaithfulWaves). Otherwise — mixed
 * independent + dependent nodes, or a cycle — it emits a flat priority-ordered
 * comma list; drive then re-derives the real DAG from the issue bodies with the
 * same `detectBodyDeps` (drive-plan.mjs buildDag), so no false edge is ever
 * fabricated. `faithful` records which form was emitted.
 * @param {string[]} orderedRefs  refs in priority order
 * @param {Record<string, string[]>} deps
 * @returns {{ drive_args: string, waves: string[][], cycle: string[]|null, faithful: boolean }}
 */
export function emitDriveArgs(orderedRefs, deps) {
  const set = new Set(orderedRefs);
  const subDeps = {};
  for (const ref of orderedRefs) {
    subDeps[ref] = (deps[ref] ?? []).filter((d) => set.has(d));
  }
  const { waves, cycle } = topoWaves(orderedRefs, subDeps);
  if (cycle) {
    return { drive_args: orderedRefs.join(","), waves: [], cycle, faithful: false };
  }
  if (waves.length > 1 && isFaithfulWaves(waves, subDeps)) {
    return { drive_args: waves.map((w) => w.join(",")).join(" -> "), waves, cycle: null, faithful: true };
  }
  return { drive_args: orderedRefs.join(","), waves, cycle: null, faithful: false };
}

// ---------------------------------------------------------------------------
// handoff selection (dependency closure + auto-ok gating)
// ---------------------------------------------------------------------------

/**
 * Expand a seed ref set to include the transitive dependency closure within the
 * collected set (a drive handoff must include everything the selection builds
 * on). Returns the closure as a Set.
 * @param {string[]} seed
 * @param {Record<string, string[]>} deps
 * @returns {Set<string>}
 */
export function depClosure(seed, deps) {
  const closure = new Set();
  const stack = [...seed];
  while (stack.length > 0) {
    const ref = stack.pop();
    if (closure.has(ref)) continue;
    closure.add(ref);
    for (const d of deps[ref] ?? []) if (!closure.has(d)) stack.push(d);
  }
  return closure;
}

/**
 * Select the `--auto` handoff set: ONLY `auto-ok`-labelled issues, and only
 * those whose full dependency closure is ALSO approved (an approved issue that
 * depends on an unapproved one is dropped — cascading — so drive never builds
 * an unapproved issue). This is the HATL gate: no auto-ok label ⇒ never driven.
 * @param {string[]} orderedRefs  priority-ordered refs
 * @param {Record<string, string[]>} deps
 * @param {Set<string>} autoOkSet
 * @returns {{ selected: string[], excluded_no_label: string[], excluded_unapproved_dep: string[] }}
 */
export function selectAutoOk(orderedRefs, deps, autoOkSet) {
  const excluded_no_label = orderedRefs.filter((r) => !autoOkSet.has(r));
  const approved = new Set(orderedRefs.filter((r) => autoOkSet.has(r)));
  const excludedDep = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of [...approved]) {
      if ((deps[r] ?? []).some((d) => !approved.has(d))) {
        approved.delete(r);
        excludedDep.add(r);
        changed = true;
      }
    }
  }
  return {
    selected: orderedRefs.filter((r) => approved.has(r)),
    excluded_no_label,
    excluded_unapproved_dep: [...excludedDep],
  };
}

// ---------------------------------------------------------------------------
// run: parse → resolve repo → collect → deps → prioritize → handoff
// ---------------------------------------------------------------------------

/**
 * Full run. Never throws; returns the structured result.
 * @param {string[]} argv
 * @param {object} [deps]  injectable { cwd, gitRun, ghRun }
 * @returns {object}
 */
export function run(argv = [], depsIn = {}) {
  const args = parseArgs(argv);
  const cwd = typeof args["repo-root"] === "string" ? args["repo-root"] : depsIn.cwd ?? process.cwd();
  const gitRun = depsIn.gitRun ?? makeRunner("git", cwd);
  const ghRun = depsIn.ghRun ?? makeRunner("gh", cwd);

  const mode = args.auto ? "auto" : args.drive ? "drive" : "present";
  const { repo, error: repoError } = resolveRepo(
    gitRun,
    typeof args.repo === "string" ? args.repo : undefined,
  );

  const result = {
    schema_version: SCHEMA_VERSION,
    mode,
    repo,
    repo_error: repoError,
    limit: args.limit,
    label_filter: typeof args.label === "string" ? args.label : null,
    warnings: [],
  };

  const { issues: rawIssues, error: fetchError } = fetchIssues(ghRun, {
    repo,
    label: typeof args.label === "string" ? args.label : undefined,
    limit: args.limit,
  });
  if (fetchError) {
    result.fetch_error = fetchError;
    result.issues = [];
    result.blockers = [];
    result.handoff = { selected: [], drive_args: "", cycle: null };
    return result;
  }

  const normalized = rawIssues.map(normalizeIssue).filter((i) => typeof i.number === "number");
  const { deps, blockers } = buildDeps(normalized);
  const prioritized = prioritize(normalized, blockers);

  result.issues = prioritized.map((i) => ({
    number: i.number,
    ref: i.ref,
    title: i.title,
    labels: i.labels,
    updated_at: i.updated_at,
    milestone: i.milestone,
    milestone_due_on: i.milestone_due_on,
    depends_on: deps[i.ref] ?? [],
    is_blocker: i.is_blocker,
    is_high_priority: i.is_high_priority,
    auto_ok: i.auto_ok,
    rationale: rationale(i),
  }));
  result.blockers = [...blockers];
  result.deps = deps;

  const orderedRefs = prioritized.map((i) => i.ref);

  if (mode === "auto") {
    const autoOkSet = new Set(prioritized.filter((i) => i.auto_ok).map((i) => i.ref));
    const sel = selectAutoOk(orderedRefs, deps, autoOkSet);
    const emitted = emitDriveArgs(sel.selected, deps);
    result.handoff = {
      auto_ok_only: true,
      selected: sel.selected,
      excluded_no_label: sel.excluded_no_label,
      excluded_unapproved_dep: sel.excluded_unapproved_dep,
      drive_args: emitted.drive_args,
      waves: emitted.waves,
      cycle: emitted.cycle,
      faithful: emitted.faithful,
    };
    if (sel.selected.length === 0) {
      result.warnings.push(`--auto: no \`${AUTO_OK_LABEL}\`-labelled issue to hand off (HATL gate)`);
    }
    if (sel.excluded_unapproved_dep.length > 0) {
      result.warnings.push(
        `--auto: excluded ${sel.excluded_unapproved_dep.join(", ")} (depends on an un-\`${AUTO_OK_LABEL}\` issue)`,
      );
    }
  } else if (mode === "drive") {
    const seed = args.driveN ? orderedRefs.slice(0, args.driveN) : orderedRefs;
    const closure = depClosure(seed, deps);
    const selected = orderedRefs.filter((r) => closure.has(r)); // priority order
    const emitted = emitDriveArgs(selected, deps);
    result.handoff = {
      auto_ok_only: false,
      drive_n: args.driveN,
      selected,
      drive_args: emitted.drive_args,
      waves: emitted.waves,
      cycle: emitted.cycle,
      faithful: emitted.faithful,
    };
  } else {
    const emitted = emitDriveArgs(orderedRefs, deps);
    result.handoff = {
      auto_ok_only: false,
      selected: orderedRefs,
      drive_args: emitted.drive_args,
      waves: emitted.waves,
      cycle: emitted.cycle,
      faithful: emitted.faithful,
    };
  }

  if (result.handoff.cycle) {
    result.warnings.push(`circular dependency among ${result.handoff.cycle.join(", ")} — emitted as a flat list`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// rendering (deterministic; owned by the engine, not the LLM)
// ---------------------------------------------------------------------------

/**
 * Render the structured result into the human report. Exported for tests + CLI.
 * @param {object} result
 * @returns {string}
 */
export function render(result) {
  const lines = [];
  lines.push(`Repo: ${result.repo ?? "(unresolved)"}`);
  if (result.repo_error) lines.push(`  ⚠️ ${result.repo_error} — pass --repo owner/repo`);
  if (result.fetch_error) {
    lines.push(`Error: gh issue list failed (${result.fetch_error})`);
    return lines.join("\n");
  }

  lines.push(`Open issues: ${result.issues.length} (limit ${result.limit}${result.label_filter ? `, label ${result.label_filter}` : ""})`);
  if (result.issues.length === 0) {
    lines.push("(no open issues)");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("Prioritized candidates:");
  const numW = result.issues.reduce((m, i) => Math.max(m, i.ref.length), 0);
  for (const i of result.issues) {
    const flags = [
      i.is_blocker ? "blocker" : null,
      i.is_high_priority ? "priority:high" : null,
      i.auto_ok ? "auto-ok" : null,
    ]
      .filter(Boolean)
      .join(",");
    const deps = i.depends_on.length ? ` deps:${i.depends_on.join(",")}` : "";
    const title = i.title.length > 60 ? `${i.title.slice(0, 57)}...` : i.title;
    lines.push(`  ${i.ref.padEnd(numW)}  ${title}${flags ? `  [${flags}]` : ""}${deps}`);
    lines.push(`  ${" ".repeat(numW)}  └ ${i.rationale}`);
  }

  lines.push("");
  lines.push(`Blockers (depended-upon): ${result.blockers.length ? result.blockers.join(", ") : "none"}`);

  lines.push("");
  const h = result.handoff;
  if (result.mode === "auto") {
    lines.push(`Mode: --auto (only \`${AUTO_OK_LABEL}\`-labelled, HATL gate)`);
    lines.push(`  eligible: ${h.selected.length ? h.selected.join(", ") : "(none)"}`);
    if (h.excluded_no_label?.length) lines.push(`  excluded (no ${AUTO_OK_LABEL}): ${h.excluded_no_label.join(", ")}`);
    if (h.excluded_unapproved_dep?.length) lines.push(`  excluded (unapproved dep): ${h.excluded_unapproved_dep.join(", ")}`);
  } else if (result.mode === "drive") {
    lines.push(`Mode: --drive${h.drive_n ? `=${h.drive_n}` : ""} (top selection + dependency closure)`);
    lines.push(`  selected: ${h.selected.length ? h.selected.join(", ") : "(none)"}`);
  } else {
    lines.push("Mode: present (candidate list only — no drive launched)");
  }

  lines.push("");
  lines.push(`drive args: ${h.drive_args || "(nothing to hand off)"}`);
  if (h.drive_args) lines.push(`  → /drive ${h.drive_args}`);

  for (const w of result.warnings) lines.push(`  ⚠️ ${w}`);
  return lines.join("\n");
}

// CLI entry: render the human report (or --json for the structured result).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const result = run(argv);
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${render(result)}\n`);
  process.exit(0);
}
