#!/usr/bin/env node
// deps — deterministic automation-PR triage engine for the `deps` skill
// (ADR-0028 R1).
//
// Owns ALL the determinism for "which dependency-update PRs are safe to auto-
// merge": enumerate open automation PRs (`gh pr list --state open --json
// number,title,author,headRefName`), classify each by semver bump (title /
// branch / manifest diff — grouped PRs judged by their MAX bump), CI status
// (`gh pr checks`), lockfile integrity, and peer/engines changes, then apply
// the FIXED judgment table:
//
//   patch|minor + CI green + lockfile consistent + no peer/engines  -> auto-merge
//   major | CI red | CI pending | no checks | unknown bump |
//     lockfile drift | peer dep change | engines change             -> 要確認
//
// SKILL.md keeps only the judgment layer: when to run this, how to present the
// triage, and where the merge (an irreversible action) is gated by the central
// autonomy policy. `--auto` is the explicit policy override (confirmation-free
// serial `gh pr merge --squash`); `--dry-run` classifies only and wins over
// `--auto` when both are given (misapplication prevention, same rule as topics).
//
// Author detection MIRRORS health-check.mjs 領域 15 (`isBotAuthor`): a `*[bot]`
// login, an `app/*` GitHub-App login, or `is_bot === true`. release-please is a
// bot but is EXCLUDED here — release PRs are `/release`'s responsibility. The
// drift between this pattern and health's is guarded by tests/deps.test.mjs.
//
// Prior art (same reason, already scripted): health-check.mjs / backlog.mjs /
// topics.mjs / policy-read.mjs. Node stdlib only; the pure/injectable functions
// are exported so tests drive it without a network or a real gh.
//
// Output modes (CLI):
//   node deps.mjs                    classify + present a triage PLAN (merge
//                                    deferred to the policy gate), rendered text
//   node deps.mjs --dry-run          classification ONLY (never merges/confirms)
//   node deps.mjs --auto             policy override: merge every auto-merge
//                                    candidate confirmation-free (serial)
//   node deps.mjs --json             the structured JSON result (any mode)
//   node deps.mjs --repo owner/repo  target repo (default: cwd's origin)
//   node deps.mjs --limit N          enumeration cap (default 50)

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = 1;

// Default enumeration cap for `gh pr list`.
export const DEFAULT_LIMIT = 50;

// Fixed decision vocabulary. No other labels are ever emitted (a human-readable
// contract mirrored in SKILL.md's judgment table).
export const AUTO_MERGE = "auto-merge";
export const NEEDS_REVIEW = "要確認";

// release-please is a bot, but its PRs are `/release`'s domain — excluded from
// deps triage. Matched by the canonical login and a defensive substring.
export const RELEASE_PLEASE_LOGIN = "release-please[bot]";

// Flags that consume the following argv token as their value.
const VALUE_FLAGS = new Set(["repo", "repo-root", "limit"]);

// npm / python / go / rust / ruby ecosystem manifest⇄lockfile pairs. Used only
// to detect the "manifest bumped but lockfile not regenerated" drift (the
// reverse — lockfile-only, e.g. lockfile-maintenance / transitive — is fine).
const ECOSYSTEMS = [
  { manifest: "package.json", locks: ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "npm-shrinkwrap.json"] },
  { manifest: "pyproject.toml", locks: ["uv.lock", "poetry.lock", "pdm.lock"] },
  { manifest: "requirements.in", locks: ["requirements.txt"] },
  { manifest: "go.mod", locks: ["go.sum"] },
  { manifest: "Cargo.toml", locks: ["Cargo.lock"] },
  { manifest: "Gemfile", locks: ["Gemfile.lock"] },
  { manifest: "composer.json", locks: ["composer.lock"] },
];

/**
 * Build a spawnSync-backed command runner bound to a cwd. Mirrors
 * backlog.mjs / health-check.mjs so tests inject a fake in the same shape.
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
 * Parse argv into flags. `--repo` / `--repo-root` / `--limit` consume the next
 * token (or use `--key=value`); other `--flags` are booleans. `deps` takes no
 * positional args.
 * @param {string[]} argv
 * @returns {{ repo?: string, "repo-root"?: string, limit: number, "dry-run": boolean, auto: boolean, json: boolean }}
 */
export function parseArgs(argv) {
  const out = { limit: DEFAULT_LIMIT, "dry-run": false, auto: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
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
      case "dry-run":
        out["dry-run"] = true;
        break;
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
// author detection (MIRRORS health-check.mjs 領域 15 isBotAuthor; drift is
// enforced by tests/deps.test.mjs — keep these two predicates identical)
// ---------------------------------------------------------------------------

/**
 * Is this PR author an automation bot? A `*[bot]` login, an `app/*` GitHub-App
 * login, or an explicit `is_bot` flag. IDENTICAL to health-check.mjs 領域 15.
 * @param {{ login?: string, is_bot?: boolean }|null|undefined} author
 * @returns {boolean}
 */
export function isBotAuthor(author) {
  if (!author) return false;
  if (author.is_bot === true) return true;
  const login = String(author.login ?? "");
  return /\[bot\]$/.test(login) || login.startsWith("app/");
}

/**
 * release-please PRs are `/release`'s responsibility, not deps'. Matched by the
 * canonical login and a defensive substring (custom app slugs / forks).
 * @param {{ login?: string }|null|undefined} author
 * @returns {boolean}
 */
export function isReleasePlease(author) {
  const login = String(author?.login ?? "").toLowerCase();
  return login === RELEASE_PLEASE_LOGIN || /release-please/.test(login);
}

/**
 * An automation PR that `/deps` should triage: a bot author, minus
 * release-please.
 * @param {{ login?: string, is_bot?: boolean }|null|undefined} author
 * @returns {boolean}
 */
export function isDepsAutomationAuthor(author) {
  return isBotAuthor(author) && !isReleasePlease(author);
}

// ---------------------------------------------------------------------------
// repo resolution (small, self-contained)
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
// enumeration (gh pr list)
// ---------------------------------------------------------------------------

/**
 * Enumerate open automation PRs via `gh pr list --state open --json …`, keeping
 * only bot authors and dropping release-please. Returns the filtered PR array,
 * or an { error } classification when gh fails.
 * @param {(args: string[]) => { status: number, stdout: string, stderr: string, error: Error|null }} ghRun
 * @param {{ repo?: string|null, limit?: number }} opts
 * @returns {{ prs: any[]|null, error: string|null }}
 */
export function fetchAutomationPrs(ghRun, { repo, limit = DEFAULT_LIMIT } = {}) {
  const args = [
    "pr",
    "list",
    "--state",
    "open",
    "--json",
    "number,title,author,headRefName",
    "--limit",
    String(limit),
  ];
  if (repo) args.push("--repo", repo);
  const r = ghRun(args);
  if (r.error || r.status !== 0) return { prs: null, error: classifyGhError(r) };
  let parsed;
  try {
    parsed = JSON.parse(r.stdout || "[]");
  } catch {
    return { prs: null, error: "unparseable gh output" };
  }
  const all = Array.isArray(parsed) ? parsed : [];
  return { prs: all.filter((pr) => isDepsAutomationAuthor(pr?.author)), error: null };
}

// ---------------------------------------------------------------------------
// semver bump classification (title / branch / manifest diff; grouped = MAX)
// ---------------------------------------------------------------------------

const BUMP_RANK = { patch: 1, minor: 2, major: 3 };

/**
 * Take the higher-severity bump of two (major > minor > patch; a known bump
 * always wins over null/undefined).
 * @param {string|null} a
 * @param {string|null} b
 * @returns {string|null}
 */
export function maxBump(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return (BUMP_RANK[a] ?? 0) >= (BUMP_RANK[b] ?? 0) ? a : b;
}

/**
 * Parse a semver-ish version string ("v1.2.3", "1.2", "2") into components.
 * @param {string} v
 * @returns {{ major: number, minor: number, patch: number }|null}
 */
export function parseSemver(v) {
  const m = String(v).trim().replace(/^v/i, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0) };
}

/**
 * Classify the bump between two versions. A change in the highest differing
 * component wins (a major-version change is `major` even if minor/patch also
 * move). Returns null when either version is unparseable.
 * @param {string} from
 * @param {string} to
 * @returns {string|null} "major" | "minor" | "patch" | null
 */
export function compareSemver(from, to) {
  const a = parseSemver(from);
  const b = parseSemver(to);
  if (!a || !b) return null;
  if (a.major !== b.major) return "major";
  if (a.minor !== b.minor) return "minor";
  if (a.patch !== b.patch) return "patch";
  return "patch"; // identical numeric core (e.g. prerelease/build-only) — low risk
}

// "from 1.2.3 to 1.4.0", "1.2.3 -> 2.0.0", "v1 → v2", "bump X from A to B".
const PAIR_RE = /\bv?(\d+(?:\.\d+){0,2})\s*(?:to|->|→|=>)\s*v?(\d+(?:\.\d+){0,2})\b/gi;

/**
 * Collect every old→new version pair mentioned in a text (title or diff) and
 * return the MAX bump across them (grouped PRs list several). Returns null when
 * no pair is found.
 * @param {string} text
 * @returns {string|null}
 */
export function bumpFromPairs(text) {
  let bump = null;
  for (const m of String(text).matchAll(PAIR_RE)) {
    bump = maxBump(bump, compareSemver(m[1], m[2]));
  }
  return bump;
}

/**
 * Extract dependency version bumps from a unified manifest diff by pairing
 * removed (`-`) and added (`+`) `"dep": "spec"` lines by key, then taking the
 * MAX bump. Handles grouped PRs whose title is generic but whose diff lists
 * every dependency. Returns null when no paired bump is found.
 * @param {string} diffText
 * @returns {string|null}
 */
export function bumpFromManifestDiff(diffText) {
  const removed = new Map();
  const added = new Map();
  const line = /^([+-])\s*"([^"]+)"\s*:\s*"[\^~>=<v \t]*(\d+(?:\.\d+){0,2}[^"]*)"/;
  for (const raw of String(diffText).split("\n")) {
    if (raw.startsWith("+++") || raw.startsWith("---")) continue; // diff headers
    const m = raw.match(line);
    if (!m) continue;
    const [, sign, key, version] = m;
    (sign === "-" ? removed : added).set(key, version);
  }
  let bump = null;
  for (const [key, from] of removed) {
    if (added.has(key)) bump = maxBump(bump, compareSemver(from, added.get(key)));
  }
  return bump;
}

/**
 * Classify a PR's semver bump from every available signal (title version pairs,
 * manifest-diff pairs, and branch/title major hints), taking the MAX. Returns
 * "unknown" when no signal resolves — a conservative label the decision table
 * routes to 要確認 (never auto-merged).
 * @param {{ title?: string, branch?: string, diff?: string }} pr
 * @returns {"major"|"minor"|"patch"|"unknown"}
 */
export function classifyBump({ title = "", branch = "", diff = "" } = {}) {
  let bump = maxBump(bumpFromPairs(title), bumpFromManifestDiff(diff));

  // Branch / title major hints (renovate `renovate/major-*`, "update major …").
  // The `(?<!non-)` guard keeps "non-major" (a minor+patch group) from matching.
  if (/(^|[/-])major([/-]|$)/i.test(branch) || /(?<!non-)\bmajor\b/i.test(title)) {
    bump = maxBump(bump, "major");
  }
  // Renovate grouped "non-major" PRs are minor+patch — max is minor.
  if (!bump && /non-major/i.test(title)) bump = "minor";
  // Lockfile maintenance touches only the lockfile — treat as patch-level risk.
  if (!bump && /lock ?file[- ]maintenance/i.test(`${title} ${branch}`)) bump = "patch";

  return bump ?? "unknown";
}

// ---------------------------------------------------------------------------
// CI status (gh pr checks)
// ---------------------------------------------------------------------------

/**
 * Reduce a `gh pr checks --json state,bucket,name` array to a single status.
 *   green      all checks pass/skip
 *   red        any check failed or was cancelled
 *   pending    any check still running/queued (and none failed)
 *   no-checks  the PR reports no checks at all
 * @param {Array<{ bucket?: string, state?: string }>} checks
 * @returns {"green"|"red"|"pending"|"no-checks"}
 */
export function ciStatus(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return "no-checks";
  const buckets = checks.map((c) => String(c?.bucket ?? "").toLowerCase());
  const states = checks.map((c) => String(c?.state ?? "").toLowerCase());
  const isFail = (b, s) => b === "fail" || b === "cancel" || s === "failure" || s === "cancelled" || s === "timed_out";
  const isPending = (b, s) => b === "pending" || s === "pending" || s === "queued" || s === "in_progress";
  if (checks.some((_, i) => isFail(buckets[i], states[i]))) return "red";
  if (checks.some((_, i) => isPending(buckets[i], states[i]))) return "pending";
  return "green";
}

/**
 * Fetch + classify a PR's CI status. `gh pr checks` exits non-zero for
 * pending/failing runs, so status code is not trusted — stdout JSON is parsed
 * regardless, and an empty/absent set is `no-checks`. Genuine gh errors (auth,
 * network) surface as { status: "error", error }.
 * @param {(args: string[]) => { status: number, stdout: string, stderr: string, error: Error|null }} ghRun
 * @param {number} prNumber
 * @param {string|null} repo
 * @returns {{ status: string, error: string|null }}
 */
export function fetchCiStatus(ghRun, prNumber, repo) {
  const args = ["pr", "checks", String(prNumber), "--json", "name,state,bucket"];
  if (repo) args.push("--repo", repo);
  const r = ghRun(args);
  if (r.error && r.error.code === "ENOENT") return { status: "error", error: "gh not installed" };
  const text = String(r.stdout || "").trim();
  if (text === "" || text === "[]") {
    if (/no check|no required check/i.test(String(r.stderr))) return { status: "no-checks", error: null };
    // A genuine auth/network failure (non-zero, no JSON, not a "no checks" note).
    if (r.status !== 0 && /not logged|authentication|resolve host|network|rate limit/i.test(String(r.stderr))) {
      return { status: "error", error: classifyGhError(r) };
    }
    return { status: "no-checks", error: null };
  }
  try {
    return { status: ciStatus(JSON.parse(text)), error: null };
  } catch {
    return { status: "error", error: "unparseable gh pr checks output" };
  }
}

// ---------------------------------------------------------------------------
// diff-derived signals: changed files, lockfile integrity, peer/engines
// ---------------------------------------------------------------------------

/**
 * Extract the changed file paths from a unified diff (the `b/` side of each
 * `diff --git a/… b/…` header).
 * @param {string} diffText
 * @returns {string[]}
 */
export function parseChangedFiles(diffText) {
  const files = [];
  for (const raw of String(diffText).split("\n")) {
    const m = raw.match(/^diff --git a\/(?:.+) b\/(.+)$/);
    if (m) files.push(m[1].trim());
  }
  return files;
}

function basename(p) {
  const s = String(p);
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}

/**
 * Assess lockfile integrity from the changed-file set. The only drift deps
 * treats as unsafe is a manifest bumped WITHOUT its lockfile regenerated (the
 * lockfile would still pin the old version). The reverse (lockfile-only —
 * lockfile-maintenance / transitive updates) is fine, as is a PR that touches
 * neither (e.g. a GitHub-Actions version bump has no lockfile).
 * @param {string[]} files
 * @returns {"consistent"|"manifest-without-lock"}
 */
export function lockfileState(files) {
  const names = new Set(files.map(basename));
  for (const eco of ECOSYSTEMS) {
    const manifestTouched = names.has(eco.manifest);
    const lockTouched = eco.locks.some((l) => names.has(l));
    if (manifestTouched && !lockTouched) return "manifest-without-lock";
  }
  return "consistent";
}

/**
 * Detect peer-dependency or engines changes in a manifest diff: an added or
 * removed line inside (or naming) a `peerDependencies` / `engines` block. A
 * conservative heuristic — false positives only ever route a PR to 要確認.
 * @param {string} diffText
 * @returns {{ peer: boolean, engines: boolean }}
 */
export function detectPeerEngines(diffText) {
  let peer = false;
  let engines = false;
  for (const raw of String(diffText).split("\n")) {
    if (!(raw.startsWith("+") || raw.startsWith("-")) || raw.startsWith("+++") || raw.startsWith("---")) {
      continue;
    }
    if (/peerDependencies/.test(raw)) peer = true;
    if (/"engines"/.test(raw)) engines = true;
  }
  return { peer, engines };
}

// ---------------------------------------------------------------------------
// decision (fixed judgment table)
// ---------------------------------------------------------------------------

/**
 * Apply the fixed judgment table to one PR's classified signals. auto-merge
 * requires ALL of: bump ∈ {patch, minor}, CI green, lockfile consistent, no
 * peer change, no engines change. Anything else is 要確認 with reasons.
 * @param {{ bump: string, ci: string, lockfile: string, peer: boolean, engines: boolean, ciError?: string|null }} signals
 * @returns {{ decision: string, reasons: string[] }}
 */
export function decide({ bump, ci, lockfile, peer, engines, ciError = null } = {}) {
  const reasons = [];
  if (bump === "major") reasons.push("major bump");
  else if (bump === "unknown") reasons.push("unknown bump (could not classify)");
  if (ci === "red") reasons.push("CI red");
  else if (ci === "pending") reasons.push("CI pending");
  else if (ci === "no-checks") reasons.push("no CI checks");
  else if (ci === "error") reasons.push(`CI status unavailable${ciError ? ` (${ciError})` : ""}`);
  if (lockfile === "manifest-without-lock") reasons.push("lockfile drift (manifest changed without lockfile)");
  if (peer) reasons.push("peer dependency change");
  if (engines) reasons.push("engines change");

  const bumpOk = bump === "patch" || bump === "minor";
  const decision = bumpOk && ci === "green" && lockfile === "consistent" && !peer && !engines
    ? AUTO_MERGE
    : NEEDS_REVIEW;
  return { decision, reasons };
}

/**
 * Classify a single automation PR end-to-end: fetch its CI status + diff, derive
 * every signal, and apply the decision table. Never throws.
 * @param {(args: string[]) => { status: number, stdout: string, stderr: string, error: Error|null }} ghRun
 * @param {{ number: number, title?: string, headRefName?: string, author?: object }} pr
 * @param {string|null} repo
 * @returns {object}
 */
export function classifyPr(ghRun, pr, repo) {
  const number = pr?.number;
  const title = typeof pr?.title === "string" ? pr.title : "";
  const branch = typeof pr?.headRefName === "string" ? pr.headRefName : "";

  const diffArgs = ["pr", "diff", String(number)];
  if (repo) diffArgs.push("--repo", repo);
  const diffRes = ghRun(diffArgs);
  const diff = diffRes.error || diffRes.status !== 0 ? "" : String(diffRes.stdout || "");
  const diffError = diffRes.error || diffRes.status !== 0 ? classifyGhError(diffRes) : null;

  const changedFiles = parseChangedFiles(diff);
  const bump = classifyBump({ title, branch, diff });
  const { status: ci, error: ciError } = fetchCiStatus(ghRun, number, repo);
  const lockfile = lockfileState(changedFiles);
  const { peer, engines } = detectPeerEngines(diff);
  const { decision, reasons } = decide({ bump, ci, lockfile, peer, engines, ciError });

  return {
    number,
    ref: `#${number}`,
    title,
    author: pr?.author?.login ?? null,
    branch,
    bump,
    ci,
    ci_error: ciError,
    lockfile,
    peer,
    engines,
    changed_files: changedFiles.length,
    diff_error: diffError,
    decision,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// merge execution (only under --auto; policy override)
// ---------------------------------------------------------------------------

/**
 * Merge one PR (`gh pr merge <N> --squash`). Never `--delete-branch` (a worktree
 * may hold the branch) and never `--auto` (immediate squash, deterministic
 * result). Returns { ok, error }.
 * @param {(args: string[]) => { status: number, stdout: string, stderr: string, error: Error|null }} ghRun
 * @param {number} prNumber
 * @param {string|null} repo
 * @returns {{ ok: boolean, error: string|null }}
 */
export function mergePr(ghRun, prNumber, repo) {
  const args = ["pr", "merge", String(prNumber), "--squash"];
  if (repo) args.push("--repo", repo);
  const r = ghRun(args);
  if (r.error || r.status !== 0) {
    const s = String(r.stderr).toLowerCase();
    if (/protected branch|branch protection|not mergeable|required status|review required/.test(s)) {
      return { ok: false, error: "merge blocked (branch protection / not mergeable)" };
    }
    return { ok: false, error: classifyGhError(r) };
  }
  return { ok: true, error: null };
}

// ---------------------------------------------------------------------------
// run: parse → resolve repo → enumerate → classify → (auto) merge
// ---------------------------------------------------------------------------

/**
 * Full run. Never throws; returns the structured result.
 * @param {string[]} argv
 * @param {object} [depsIn]  injectable { cwd, gitRun, ghRun }
 * @returns {object}
 */
export function run(argv = [], depsIn = {}) {
  const args = parseArgs(argv);
  const cwd = typeof args["repo-root"] === "string" ? args["repo-root"] : depsIn.cwd ?? process.cwd();
  const gitRun = depsIn.gitRun ?? makeRunner("git", cwd);
  const ghRun = depsIn.ghRun ?? makeRunner("gh", cwd);

  // --dry-run wins over --auto (misapplication prevention — same rule as topics).
  const dryRun = args["dry-run"] === true;
  const auto = dryRun ? false : args.auto === true;
  const mode = dryRun ? "dry-run" : auto ? "auto" : "plan";

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
    warnings: [],
    candidates: [],
    auto_merge: [],
    needs_review: [],
    merge_plan: [],
    // Central-policy classification for the merge action (ADR-0028 R3). The gate
    // itself is resolved by the SKILL layer via policy-read.mjs; `--auto` is the
    // explicit override that merges confirmation-free.
    policy: { action: "merge", class: "irreversible" },
  };
  if (dryRun && args.auto) {
    result.warnings.push("--dry-run and --auto both given → --dry-run wins (no merge performed)");
  }

  const { prs, error: fetchError } = fetchAutomationPrs(ghRun, { repo, limit: args.limit });
  if (fetchError) {
    result.fetch_error = fetchError;
    return result;
  }

  const classified = (prs ?? [])
    .filter((pr) => typeof pr?.number === "number")
    .map((pr) => classifyPr(ghRun, pr, repo));
  result.candidates = classified;
  result.auto_merge = classified.filter((c) => c.decision === AUTO_MERGE).map((c) => c.ref);
  result.needs_review = classified.filter((c) => c.decision === NEEDS_REVIEW).map((c) => c.ref);
  result.merge_plan = classified
    .filter((c) => c.decision === AUTO_MERGE)
    .map((c) => ({
      number: c.number,
      ref: c.ref,
      title: c.title,
      command: `gh pr merge ${c.number} --squash${repo ? ` --repo ${repo}` : ""}`,
    }));

  if (mode === "auto") {
    // Policy override: merge every auto-merge candidate confirmation-free, serial
    // (git/remote state changes — never parallel). A failed merge (branch
    // protection etc.) downgrades that PR to 要確認 and continues (issue #176 §5).
    result.merge_results = [];
    for (const c of classified.filter((x) => x.decision === AUTO_MERGE)) {
      const res = mergePr(ghRun, c.number, repo);
      result.merge_results.push({ ref: c.ref, ok: res.ok, error: res.error });
      if (!res.ok) {
        c.decision = NEEDS_REVIEW;
        c.reasons.push(`merge failed: ${res.error}`);
      }
    }
    // Recompute the summary buckets after any downgrades.
    result.auto_merge = classified.filter((c) => c.decision === AUTO_MERGE).map((c) => c.ref);
    result.needs_review = classified.filter((c) => c.decision === NEEDS_REVIEW).map((c) => c.ref);
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
    lines.push(`Error: gh pr list failed (${result.fetch_error})`);
    return lines.join("\n");
  }

  lines.push(`Automation PRs: ${result.candidates.length} (mode: ${result.mode}, limit ${result.limit})`);
  if (result.candidates.length === 0) {
    lines.push("(no open automation PRs — release-please excluded)");
    return lines.join("\n");
  }

  const merged = new Set((result.merge_results ?? []).filter((m) => m.ok).map((m) => m.ref));
  const failed = new Map((result.merge_results ?? []).filter((m) => !m.ok).map((m) => [m.ref, m.error]));

  lines.push("");
  lines.push("Triage:");
  const w = result.candidates.reduce((m, c) => Math.max(m, c.ref.length), 0);
  for (const c of result.candidates) {
    const title = c.title.length > 56 ? `${c.title.slice(0, 53)}...` : c.title;
    const facts = `[${c.bump}/${c.ci}/${c.lockfile}${c.peer ? "/peer" : ""}${c.engines ? "/engines" : ""}]`;
    let tail = c.decision;
    if (merged.has(c.ref)) tail = "auto-merge ✔ merged";
    else if (failed.has(c.ref)) tail = `要確認 (merge failed: ${failed.get(c.ref)})`;
    lines.push(`  ${c.ref.padEnd(w)}  ${title}  ${facts}  → ${tail}`);
    if (c.decision === NEEDS_REVIEW && c.reasons.length && !merged.has(c.ref)) {
      lines.push(`  ${" ".repeat(w)}  └ ${c.reasons.join("; ")}`);
    }
  }

  lines.push("");
  lines.push(`auto-merge candidates: ${result.auto_merge.length ? result.auto_merge.join(", ") : "none"}`);
  lines.push(`要確認: ${result.needs_review.length ? result.needs_review.join(", ") : "none"}`);

  if (result.mode === "dry-run") {
    lines.push("");
    lines.push("(--dry-run: classification only — no merge performed)");
  } else if (result.mode === "auto") {
    lines.push("");
    lines.push(`Merged (--auto policy override): ${merged.size}`);
    for (const m of result.merge_results ?? []) {
      lines.push(`  ${m.ref}  ${m.ok ? "✔ merged" : `✖ ${m.error}`}`);
    }
  } else if (result.merge_plan.length) {
    lines.push("");
    lines.push("Merge plan (irreversible — gated by the central autonomy policy):");
    for (const p of result.merge_plan) lines.push(`  ${p.command}`);
  }

  for (const wmsg of result.warnings) lines.push(`  ⚠️ ${wmsg}`);
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
