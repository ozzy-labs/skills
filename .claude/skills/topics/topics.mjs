#!/usr/bin/env node
// topics — deterministic engine for the `topics` skill (ADR-0028 R1).
//
// Turns a candidate topic list into a vetted GitHub-topics selection. It owns
// ALL the determinism that used to live as "prose the LLM re-interprets" in
// SKILL.md: GitHub official constraint validation (lowercase / hyphen / 50
// chars / max 20), popularity lookup (`gh api search/repositories`, session
// cache), broad+narrow 5x thresholding, singular/plural comparison, and the
// hardcoded ozzy-labs conventions (`claude-code` exception, `*-cli` suffix
// removal, `multi-agent` canonicalization). It returns a structured JSON
// result; SKILL.md keeps only the judgment layer: how to present it and where
// the policy `externally-visible` gate (batch-confirm) asks the human.
//
// Prior art (same reason, already scripted): usage-check.mjs / skill-metrics.mjs
// / policy-read.mjs / health-check.mjs. This is a plain .mjs (real spawnSync
// git/gh); the pure/injectable functions are exported so tests drive it without
// a network or a real gh.
//
// Output modes (CLI):
//   node topics.mjs <cands>              analysis + apply PLAN (no execution),
//                                        rendered human report (stdout)
//   node topics.mjs <cands> --dry-run    analysis only, never applies
//   node topics.mjs <cands> --apply      analysis + EXECUTE `gh repo edit
//                                        --add-topic` (explicit batch-confirm
//                                        opt-out), then verify
//   node topics.mjs <cands> --json       the structured JSON result instead of
//                                        text (any mode)
//
// The apply gate itself (policy `externally-visible` = batch-confirm) lives in
// SKILL.md / the Claude Code companion: the default (neither flag) returns a
// plan for the host to confirm, then re-invokes with --apply.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = 1;

// GitHub official topic constraints (mirrors the repo Settings validation).
export const MAX_TOPIC_LENGTH = 50;
export const MAX_TOPIC_COUNT = 20;

// broad ≥ narrow × THRESHOLD → the narrow term is redundant (broad-only).
export const BROAD_NARROW_RATIO = 5;

// Flags that consume the following argv token as their value.
const VALUE_FLAGS = new Set(["repo", "repo-root"]);

/**
 * Build a spawnSync-backed command runner bound to a cwd. Mirrors
 * health-check.mjs so tests inject a fake in the same shape.
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
 * Parse argv into candidates + flags. Positional tokens (and comma lists) are
 * candidates; `--repo` / `--repo-root` consume the next token; other `--flags`
 * are booleans; `--key=value` is also supported.
 * @param {string[]} argv
 * @returns {{ candidates: string[], repo?: string, "repo-root"?: string, apply: boolean, dryRun: boolean, json: boolean }}
 */
export function parseArgs(argv) {
  const out = { candidates: [], apply: false, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        out[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (VALUE_FLAGS.has(body)) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          out[body] = next;
          i += 1;
        } else {
          out[body] = true;
        }
        continue;
      }
      if (body === "dry-run") out.dryRun = true;
      else if (body === "apply") out.apply = true;
      else if (body === "json") out.json = true;
      else out[body] = true;
      continue;
    }
    for (const part of arg.split(",")) {
      const t = part.trim();
      if (t) out.candidates.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 1: GitHub official constraint validation
// ---------------------------------------------------------------------------

/**
 * Validate one topic against GitHub's official constraints.
 * @param {string} topic
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateConstraint(topic) {
  if (typeof topic !== "string" || topic.length === 0) {
    return { valid: false, reason: "empty" };
  }
  if (topic.length > MAX_TOPIC_LENGTH) return { valid: false, reason: "length>50" };
  if (!/^[a-z0-9-]+$/.test(topic)) return { valid: false, reason: "charset" };
  if (topic.startsWith("-") || topic.endsWith("-")) {
    return { valid: false, reason: "leading/trailing hyphen" };
  }
  return { valid: true };
}

/**
 * Filter a candidate list by the GitHub constraints, preserving order and
 * deduplicating. Returns the valid list and the rejected list with reasons.
 * @param {string[]} candidates
 * @returns {{ valid: string[], rejected: Array<{ topic: string, reason: string }> }}
 */
export function filterConstraints(candidates) {
  const valid = [];
  const rejected = [];
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    const v = validateConstraint(c);
    if (v.valid) valid.push(c);
    else rejected.push({ topic: c, reason: v.reason });
  }
  return { valid, rejected };
}

/**
 * Cap a list to GitHub's max topic count (deduped, order preserved).
 * @param {string[]} topics
 * @param {number} [max]
 * @returns {{ accepted: string[], overflow: string[] }}
 */
export function applyCountCap(topics, max = MAX_TOPIC_COUNT) {
  const unique = [...new Set(topics)];
  return { accepted: unique.slice(0, max), overflow: unique.slice(max) };
}

// ---------------------------------------------------------------------------
// Step 5: ozzy-labs hardcoded conventions (priority over machine judgment)
// ---------------------------------------------------------------------------

const CLI_SUFFIX = "-cli";
// `*-cli` suffix removal applies to these tools; claude-code is the explicit
// exception (a product name, not "<tool>-cli").
const CLI_STRIP = new Set(["codex-cli", "gemini-cli", "copilot-cli"]);
const MULTI_AGENT_REJECTS = new Set(["multi-agents", "multiagent"]);

/**
 * Apply the hardcoded ozzy-labs conventions to a candidate list:
 *   - `multi-agents` / `multiagent` → drop in favor of `multi-agent`
 *   - `codex-cli` / `gemini-cli` / `copilot-cli` → strip `-cli`
 *     (claude-code is preserved verbatim)
 * Deduplicates after rewrite (e.g. ["codex-cli", "codex"] → ["codex"]).
 * @param {string[]} candidates
 * @returns {{ out: string[], dropped: Array<{ from: string, reason: string }>, renamed: Array<{ from: string, to: string, reason: string }> }}
 */
export function applyOzzyConventions(candidates) {
  const out = [];
  const dropped = [];
  const renamed = [];
  for (const c of candidates) {
    if (MULTI_AGENT_REJECTS.has(c)) {
      dropped.push({ from: c, reason: "multi-agent canonical form" });
      continue;
    }
    if (CLI_STRIP.has(c)) {
      const stripped = c.slice(0, -CLI_SUFFIX.length);
      renamed.push({ from: c, to: stripped, reason: "*-cli suffix removed" });
      out.push(stripped);
      continue;
    }
    out.push(c);
  }
  return { out: [...new Set(out)], dropped, renamed };
}

/**
 * Surface the ozzy-labs hardcoded retentions that override machine pruning.
 * Today: `claude` + `claude-code` are both kept when both are present (the
 * classic narrow>broad case), overriding any broad-only pruning.
 * @param {string[]} topics
 * @returns {Array<{ topics: string[], reason: string }>}
 */
export function ozzyHardcodedRetentions(topics) {
  const set = new Set(topics);
  const out = [];
  if (set.has("claude") && set.has("claude-code")) {
    out.push({
      topics: ["claude", "claude-code"],
      reason: "claude-code retained alongside claude (ozzy-labs convention)",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 3: broad+narrow pair detection + threshold decision
// ---------------------------------------------------------------------------

function hyphenTokens(s) {
  return s.split("-");
}

/**
 * `broad` is the broad term of `narrow` when narrow is a hyphen-joined
 * derivative that contains broad's token(s) (e.g. `ai` ⊃ `ai-agents`,
 * `agent` ⊃ `multi-agent`). Simple co-occurrence (`news` vs `release-notes`)
 * is NOT a pair.
 * @param {string} broad
 * @param {string} narrow
 * @returns {boolean}
 */
export function isBroadOf(broad, narrow) {
  if (broad === narrow) return false;
  const bt = hyphenTokens(broad);
  const nt = hyphenTokens(narrow);
  if (bt.length >= nt.length) return false;
  return bt.every((t) => nt.includes(t));
}

/**
 * Detect broad+narrow pairs within a candidate list.
 * @param {string[]} topics
 * @returns {Array<{ broad: string, narrow: string }>}
 */
export function detectBroadNarrowPairs(topics) {
  const pairs = [];
  for (const a of topics) {
    for (const b of topics) {
      if (isBroadOf(a, b)) pairs.push({ broad: a, narrow: b });
    }
  }
  return pairs;
}

/**
 * Decide a broad+narrow pair from popularity counts.
 *   broad ≥ narrow × 5  → "broad-only" (narrow redundant)
 *   narrow > broad      → "ozzy-hardcode" (defer to Step 5)
 *   otherwise           → "both"
 * A null count (popularity unknown/unavailable) yields "indeterminate": the
 * pair is not pruned (SKILL.md: unknown popularity is excluded from comparison,
 * never treated as 0).
 * @param {number|null} broad
 * @param {number|null} narrow
 * @returns {"broad-only"|"both"|"ozzy-hardcode"|"indeterminate"}
 */
export function broadNarrowDecision(broad, narrow) {
  if (typeof broad !== "number" || typeof narrow !== "number") return "indeterminate";
  if (broad >= narrow * BROAD_NARROW_RATIO) return "broad-only";
  if (narrow > broad) return "ozzy-hardcode";
  return "both";
}

// ---------------------------------------------------------------------------
// Step 4: singular / plural standard-form comparison
// ---------------------------------------------------------------------------

/**
 * Detect singular/plural pairs (`agent`/`agents`, `topic`/`topics`) where the
 * plural is the singular + trailing `s`.
 * @param {string[]} topics
 * @returns {Array<{ singular: string, plural: string }>}
 */
export function detectSingularPluralPairs(topics) {
  const set = new Set(topics);
  const pairs = [];
  for (const s of topics) {
    const plural = `${s}s`;
    if (set.has(plural)) pairs.push({ singular: s, plural });
  }
  return pairs;
}

/**
 * Pick the more popular of a singular/plural pair. A null count means unknown;
 * if either side is unknown the pair is left undecided (both kept).
 * @param {string} singular
 * @param {number|null} singularCount
 * @param {string} plural
 * @param {number|null} pluralCount
 * @returns {{ chosen: string|null, dropped: string|null }}
 */
export function singularPluralDecision(singular, singularCount, plural, pluralCount) {
  if (typeof singularCount !== "number" || typeof pluralCount !== "number") {
    return { chosen: null, dropped: null };
  }
  if (pluralCount > singularCount) return { chosen: plural, dropped: singular };
  return { chosen: singular, dropped: plural };
}

// ---------------------------------------------------------------------------
// Step 2: popularity lookup (gh api search/repositories, session-scoped cache)
// ---------------------------------------------------------------------------

function classifyGhError(r) {
  if (r.error) {
    if (r.error.code === "ENOENT") return "gh not installed";
    return "gh error";
  }
  const s = String(r.stderr).toLowerCase();
  if (/not logged|authentication|gh auth login|no oauth token/.test(s)) {
    return "gh not authenticated";
  }
  if (/rate limit|api rate/.test(s)) return "rate limit";
  if (/could not resolve host|network|timed out|dial tcp|connection refused/.test(s)) {
    return "network";
  }
  return "gh command failed";
}

/**
 * Fetch popularity (repository count) for each topic via
 * `gh api search/repositories?q=topic:<name> --jq .total_count`. Dedupes so
 * each topic is queried once (the session cache). A failed query yields a null
 * count with a classified reason (that topic is then excluded from the 5x /
 * singular-plural comparisons — never treated as 0).
 * @param {(args: string[]) => { status: number, stdout: string, stderr: string, error: Error|null }} ghRun
 * @param {string[]} topics
 * @returns {{ counts: Record<string, number|null>, errors: Record<string, string> }}
 */
export function fetchPopularity(ghRun, topics) {
  const counts = {};
  const errors = {};
  for (const t of [...new Set(topics)]) {
    const r = ghRun(["api", `search/repositories?q=topic:${t}`, "--jq", ".total_count"]);
    if (r.error || r.status !== 0) {
      counts[t] = null;
      errors[t] = classifyGhError(r);
      continue;
    }
    const n = Number.parseInt(String(r.stdout).trim(), 10);
    if (Number.isFinite(n)) {
      counts[t] = n;
    } else {
      counts[t] = null;
      errors[t] = "unparseable count";
    }
  }
  return { counts, errors };
}

// ---------------------------------------------------------------------------
// repo resolution
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

// ---------------------------------------------------------------------------
// selection (pure over an injected popularity map) — the core determinism
// ---------------------------------------------------------------------------

/**
 * Run the full selection pipeline over a valid (constraint-filtered) candidate
 * list plus a popularity map. Pure and synchronous, so it is unit-testable
 * without any gh. Produces the final topics and every intermediate decision.
 * @param {string[]} valid
 * @param {Record<string, number|null>} counts
 * @returns {object}
 */
export function selectTopics(valid, counts) {
  // Step 5 (transforms): normalize via ozzy conventions.
  const { out: normalized, dropped, renamed } = applyOzzyConventions(valid);

  const pop = (t) => (t in counts ? counts[t] : null);
  const dropSet = new Set();

  // Step 5 (retentions): protect hardcoded pairs from broad-only pruning.
  const hardcoded = ozzyHardcodedRetentions(normalized);
  const protectedTopics = new Set(hardcoded.flatMap((h) => h.topics));

  // Step 3: broad+narrow.
  const broadNarrow = detectBroadNarrowPairs(normalized).map(({ broad, narrow }) => {
    const decision = broadNarrowDecision(pop(broad), pop(narrow));
    const entry = {
      broad,
      narrow,
      broad_count: pop(broad),
      narrow_count: pop(narrow),
      decision,
    };
    if (decision === "broad-only" && !protectedTopics.has(narrow)) dropSet.add(narrow);
    return entry;
  });

  // Step 4: singular/plural (skip pairs already handled as broad/narrow).
  const bnKeys = new Set(broadNarrow.map((p) => `${p.broad}|${p.narrow}`));
  const singularPlural = detectSingularPluralPairs(normalized)
    .filter((p) => !bnKeys.has(`${p.singular}|${p.plural}`))
    .map(({ singular, plural }) => {
      const { chosen, dropped: loser } = singularPluralDecision(
        singular,
        pop(singular),
        plural,
        pop(plural),
      );
      if (loser && !protectedTopics.has(loser)) dropSet.add(loser);
      return {
        singular,
        plural,
        singular_count: pop(singular),
        plural_count: pop(plural),
        chosen,
        dropped: loser,
      };
    });

  const selected = normalized.filter((t) => !dropSet.has(t));
  const { accepted, overflow } = applyCountCap(selected);

  return {
    normalized,
    conventions: { dropped, renamed, hardcoded },
    broad_narrow: broadNarrow,
    singular_plural: singularPlural,
    dropped_by_decision: [...dropSet],
    final_topics: accepted,
    overflow,
  };
}

// ---------------------------------------------------------------------------
// apply (gh repo edit) — executed only under an explicit --apply opt-out
// ---------------------------------------------------------------------------

function applyTopics(ghRun, repo, topics) {
  const edit = ghRun(["repo", "edit", repo, "--add-topic", topics.join(",")]);
  const applied = !edit.error && edit.status === 0;
  const result = {
    applied,
    command: `gh repo edit ${repo} --add-topic ${topics.join(",")}`,
    error: applied ? null : classifyGhError(edit) || String(edit.stderr).trim() || "apply failed",
  };
  if (applied) {
    const view = ghRun(["repo", "view", repo, "--json", "repositoryTopics"]);
    if (!view.error && view.status === 0) {
      try {
        const data = JSON.parse(view.stdout || "{}");
        const nodes = data?.repositoryTopics ?? [];
        result.verified_topics = Array.isArray(nodes)
          ? nodes.map((n) => n?.name ?? n?.topic?.name).filter(Boolean)
          : [];
      } catch {
        result.verified_topics = null;
      }
    } else {
      result.verified_topics = null;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// run: parse → resolve repo → validate → popularity → select → apply plan
// ---------------------------------------------------------------------------

/**
 * Full run. Never throws; returns the structured result.
 * @param {string[]} argv
 * @param {object} [deps]  injectable { cwd, gitRun, ghRun }
 * @returns {object}
 */
export function run(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const cwd = typeof args["repo-root"] === "string" ? args["repo-root"] : deps.cwd ?? process.cwd();
  const gitRun = deps.gitRun ?? makeRunner("git", cwd);
  const ghRun = deps.ghRun ?? makeRunner("gh", cwd);

  // --apply + --dry-run → --dry-run wins (誤適用防止).
  const dryRun = args.dryRun;
  const apply = args.apply && !dryRun;

  const { repo, error: repoError } = resolveRepo(
    gitRun,
    typeof args.repo === "string" ? args.repo : undefined,
  );

  const { valid, rejected } = filterConstraints(args.candidates);

  const result = {
    schema_version: SCHEMA_VERSION,
    repo,
    repo_error: repoError,
    mode: dryRun ? "dry-run" : apply ? "apply" : "plan",
    candidates_in: args.candidates,
    constraints: { valid, rejected },
  };

  if (args.candidates.length === 0) {
    result.error = "no candidates provided";
    return result;
  }
  if (valid.length === 0) {
    // 制約違反候補 100% → API は呼ばない。
    result.error = "no applicable candidates (all rejected by constraints)";
    return result;
  }

  // Popularity is looked up on the post-convention (normalized) set so the
  // *-cli-stripped / canonicalized names are the ones measured.
  const { out: normalizedForPop } = applyOzzyConventions(valid);
  const { counts, errors } = fetchPopularity(ghRun, normalizedForPop);
  result.popularity = counts;
  result.popularity_errors = errors;
  result.gh_available = !Object.values(errors).some((e) => e === "gh not authenticated");

  Object.assign(result, selectTopics(valid, counts));

  result.apply_command =
    result.final_topics.length > 0 && repo
      ? `gh repo edit ${repo} --add-topic ${result.final_topics.join(",")}`
      : null;

  if (dryRun) {
    result.applied = false;
  } else if (apply) {
    if (!repo) {
      result.applied = false;
      result.apply = { applied: false, error: repoError || "no repo" };
    } else if (result.final_topics.length === 0) {
      result.applied = false;
      result.apply = { applied: false, error: "no topics to apply" };
    } else {
      result.apply = applyTopics(ghRun, repo, result.final_topics);
      result.applied = result.apply.applied;
    }
  } else {
    // Default: return a plan. SKILL.md handles the batch-confirm gate and
    // re-invokes with --apply on approval.
    result.applied = false;
    result.apply_pending = true;
  }

  return result;
}

// ---------------------------------------------------------------------------
// rendering (deterministic; owned by the engine, not the LLM)
// ---------------------------------------------------------------------------

function fmtCount(n) {
  return typeof n === "number" ? n.toLocaleString("en-US") : "?";
}

/**
 * Render the structured result into the human report. Exported for tests + CLI.
 * @param {object} result
 * @returns {string}
 */
export function render(result) {
  const lines = [];
  if (result.error) {
    lines.push(`Error: ${result.error}`);
    if (result.constraints?.rejected?.length) {
      lines.push("Rejected (constraints):");
      for (const r of result.constraints.rejected) lines.push(`  ${r.topic} → 除外（${r.reason}）`);
    }
    return lines.join("\n");
  }

  const inCount = result.candidates_in.length;
  const validCount = result.constraints.valid.length;
  lines.push(`Candidates: ${inCount}`);
  lines.push(`Filtered (constraints): ${validCount}/${inCount} valid`);
  for (const r of result.constraints.rejected) {
    lines.push(`  ${r.topic} → 除外（${r.reason}）`);
  }

  if (result.popularity) {
    lines.push("Popularity:");
    const rows = Object.keys(result.popularity).sort((a, b) => {
      const pa = result.popularity[a];
      const pb = result.popularity[b];
      if (typeof pa !== "number") return 1;
      if (typeof pb !== "number") return -1;
      return pb - pa;
    });
    const width = rows.reduce((m, t) => Math.max(m, t.length), 0);
    for (const t of rows) {
      const note = result.popularity_errors?.[t] ? `  (人気度不明: ${result.popularity_errors[t]})` : "";
      lines.push(`  ${t.padEnd(width)}  ${fmtCount(result.popularity[t])}${note}`);
    }
  }

  for (const c of result.conventions?.renamed ?? []) {
    lines.push(`convention: ${c.from} → ${c.to}（${c.reason}）`);
  }
  for (const c of result.conventions?.dropped ?? []) {
    lines.push(`convention: ${c.from} → 除外（${c.reason}）`);
  }
  for (const h of result.conventions?.hardcoded ?? []) {
    lines.push(`convention: ${h.topics.join(" + ")} 併記（${h.reason}）`);
  }
  for (const p of result.broad_narrow ?? []) {
    lines.push(
      `broad/narrow: ${p.broad}(${fmtCount(p.broad_count)}) vs ${p.narrow}(${fmtCount(p.narrow_count)}) → ${p.decision}`,
    );
  }
  for (const p of result.singular_plural ?? []) {
    lines.push(
      `singular/plural: ${p.singular}(${fmtCount(p.singular_count)}) vs ${p.plural}(${fmtCount(p.plural_count)}) → ${p.chosen ?? "undecided"}`,
    );
  }

  if (result.final_topics) {
    lines.push(`Final ${result.final_topics.length} topics: ${result.final_topics.join(", ")}`);
    if (result.overflow?.length) {
      lines.push(`Overflow (>20, dropped): ${result.overflow.join(", ")}`);
    }
  }

  if (result.mode === "dry-run") {
    lines.push("", `(dry-run) would apply: ${result.apply_command ?? "(nothing)"}`);
  } else if (result.mode === "apply") {
    if (result.apply?.applied) {
      lines.push("", `✔ applied: ${result.apply.command}`);
      if (Array.isArray(result.apply.verified_topics)) {
        lines.push(`  verified: ${result.apply.verified_topics.join(", ")}`);
      }
    } else {
      lines.push("", `✖ apply failed: ${result.apply?.error ?? "unknown"}`);
    }
  } else {
    lines.push("", `Apply plan: ${result.apply_command ?? "(nothing)"}`);
    lines.push("(confirm via the policy externally-visible gate, then re-run with --apply)");
  }

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
