#!/usr/bin/env node
// health-check — deterministic engine for the `health` skill (ADR-0028 R1).
//
// Runs the 16 repo-hygiene / catalog-consistency checks that used to live as
// "prose the LLM re-interprets" in SKILL.md, and returns a structured JSON
// result. It owns ALL the determinism: fixed-vocabulary recommendation
// judgment, section ordering + in-section sort, the status table + non-clean
// section RENDERING, the `--deep` (Phase 2) label upgrades, and the `--fix`
// safe-vocabulary executor. SKILL.md keeps only the judgment layer: when to run
// this, how to present it, and where to ask the human.
//
// Prior art (same reason, already scripted): usage-check.mjs / skill-metrics.mjs
// / policy-read.mjs. This is a plain .mjs (real spawnSync git/gh, real fs); the
// pure/injectable functions are exported so tests drive it against a tmp git
// fixture without a network or a real gh.
//
// Output modes (CLI):
//   node health-check.mjs            Phase 1, rendered human report (stdout)
//   node health-check.mjs --deep     Phase 1 + Phase 2 investigation, rendered
//   node health-check.mjs --json     the structured JSON result instead of text
//   node health-check.mjs --fix      list the SAFE actions that WOULD run (no
//                                     execution — this is the confirmation step)
//   node health-check.mjs --fix --yes   execute the safe actions, annotate each
//                                        with ✔/✖ (audit trail), re-check after
//
// --fix safe vocabulary (superseding #173's executor; the confirmation gate is
// a provisional single confirm here — the policy-driven gate lands in #181-PR3):
//   prune / delete (git branch -d, safe) / fetch  → always eligible
//   drop                                           → ONLY a `--deep` Phase-2
//                                                    upgraded stash (clean apply
//                                                    to HEAD failed)
//   push / 要確認 / 要対応 / abort or continue      → NEVER executed
//
// gh-dependent checks (Triage) run gh inline; when gh is missing/unauthenticated
// each such section carries a per-check `error` in the JSON (fail-open) — the
// git checks always continue.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = 1;

// The fixed recommendation vocabulary. No other labels are ever emitted (a
// human-readable contract that also lives in SKILL.md).
export const DELETE = "delete";
export const DROP = "drop";
export const PRUNE = "prune";
export const PUSH = "push";
export const FETCH = "fetch";
export const CONFIRM = "要確認";
export const ACTION = "要対応";
export const ABORT = "abort or continue";

// Deterministic label sort for the "mixed: a+b+..." detail cell.
export const VOCAB_ORDER = [ABORT, DELETE, DROP, FETCH, PRUNE, PUSH, ACTION, CONFIRM];

// Labels whose recommended action is safe to auto-execute under --fix. `drop` is
// deliberately NOT here: only a Phase-2-upgraded stash (marked eligible at
// upgrade time) is fixable; a Phase-1 threshold `drop` is not.
const SAFE_FIX_LABELS = new Set([PRUNE, DELETE, FETCH]);

const STALE_DAYS = 14;

const ICON = { clean: "✅", "non-clean": "⚠️", error: "❌", skipped: "⏭️" };

const BOT_LOGINS = new Set(["renovate[bot]", "dependabot[bot]", "release-please[bot]"]);

/**
 * Parse `--key=value` / `--flag` argv into a flat object. Bare flags are `true`.
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
 * Build a spawnSync-backed command runner bound to a cwd.
 * @param {string} cmd
 * @param {string} cwd
 * @returns {(args: string[], opts?: { input?: string }) => { status: number, stdout: string, stderr: string, error: Error|null }}
 */
export function makeRunner(cmd, cwd) {
  return (args, opts = {}) => {
    const res = spawnSync(cmd, args, {
      cwd,
      encoding: "utf8",
      input: opts.input,
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

function firstLine(s) {
  if (!s) return "";
  const line = String(s).split("\n").find((l) => l.trim());
  return line ? line.trim() : "";
}

function stripAnsi(s) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI CSI.
  return String(s).replace(/\[[0-9;]*m/g, "");
}

function realpathOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function ageDaysFrom(nowMs, iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 86400000));
}

function ageTag(nowMs, iso) {
  const d = ageDaysFrom(nowMs, iso);
  return d === null ? "?" : `${d}d`;
}

// ---------------------------------------------------------------------------
// section / item helpers
// ---------------------------------------------------------------------------

function mkSection(id, name, group) {
  return { id, name, group, status: "clean", detail: "clean", error: null, skipped: null, items: [] };
}

/**
 * Build an item. `label` is the fixed-vocabulary recommendation (or null for
 * info-only / aggregated `same as` rows). `fix.eligible` marks it as a safe
 * auto-executable action.
 */
function item(text, opts = {}) {
  return {
    text,
    label: opts.label ?? null,
    note: opts.note ?? null,
    tags: opts.tags ?? [],
    rationale: opts.rationale ?? null,
    labelSuffix: opts.labelSuffix ?? null,
    fix: opts.fix ?? null,
    _phase2: opts._phase2 ?? null,
  };
}

function finalizeSection(s) {
  if (s.error) {
    s.status = "error";
    s.detail = `error: ${s.error}`;
    return s;
  }
  if (s.skipped) {
    s.status = "skipped";
    s.detail = `skipped: ${s.skipped}`;
    return s;
  }
  const labeled = s.items.filter((it) => it.label);
  if (labeled.length === 0) {
    s.status = "clean";
    s.detail = "clean";
    return s;
  }
  s.status = "non-clean";
  const labels = [...new Set(labeled.map((it) => it.label))];
  if (labels.length === 1) {
    s.detail = `${labeled.length} 件（${labels[0]}）`;
  } else {
    const sorted = labels.sort((a, b) => VOCAB_ORDER.indexOf(a) - VOCAB_ORDER.indexOf(b));
    s.detail = `${labeled.length} 件（mixed: ${sorted.join("+")}）`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// gh helpers
// ---------------------------------------------------------------------------

function classifyGhError(r) {
  if (r.error) {
    if (r.error.code === "ENOENT") return "gh not installed";
    return firstLine(r.error.message) || "gh error";
  }
  const s = String(r.stderr).toLowerCase();
  if (/not logged|authentication|gh auth login|no oauth token/.test(s)) return "gh not authenticated";
  if (/could not resolve host|network|timed out|dial tcp|connection refused/.test(s)) return "network";
  if (/no git remotes|not a git repository|none of the git remotes|no github/.test(s)) {
    return "no GitHub remote";
  }
  return firstLine(r.stderr) || "gh command failed";
}

/**
 * Run a `gh ... --json ...` command and parse it. Never throws: on any failure
 * returns { ok: false, error } with a classified reason for the section detail.
 */
export function ghJson(ghRun, args) {
  const r = ghRun(args);
  if (r.error || r.status !== 0) return { ok: false, error: classifyGhError(r) };
  try {
    return { ok: true, data: JSON.parse(r.stdout || "[]") };
  } catch {
    return { ok: false, error: "gh output unparseable" };
  }
}

function classifyGitRemoteError(r) {
  const s = String(r.stderr).toLowerCase();
  if (/could not read from remote|unable to access|resolve host|connection/.test(s)) return "network";
  if (/no such remote|does not appear to be a git repository|no configured/.test(s)) {
    return "no remote";
  }
  return firstLine(r.stderr) || "git remote failed";
}

// ---------------------------------------------------------------------------
// shared collectors (worktrees + PR map)
// ---------------------------------------------------------------------------

/**
 * Parse `git worktree list --porcelain` into structured entries (index 0 is the
 * main worktree). Exported for unit tests.
 * @param {string} stdout
 */
export function parseWorktrees(stdout) {
  const list = [];
  let cur = null;
  for (const line of String(stdout).split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) list.push(cur);
      cur = { path: line.slice(9).trim(), branch: null, locked: false, bare: false, detached: false };
    } else if (cur) {
      if (line.startsWith("branch ")) {
        cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
      } else if (line === "locked" || line.startsWith("locked ")) {
        cur.locked = true;
      } else if (line === "bare") {
        cur.bare = true;
      } else if (line === "detached") {
        cur.detached = true;
      }
    }
  }
  if (cur) list.push(cur);
  return list;
}

function agentIdOf(path) {
  const m = String(path).match(/\.claude\/worktrees\/agent-([^/]+)\/?$/);
  return m ? m[1] : null;
}

function branchExists(gitRun, name) {
  return gitRun(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).status === 0;
}

// ---------------------------------------------------------------------------
// checks 1-16
// ---------------------------------------------------------------------------

function checkInterrupted(ctx) {
  const s = mkSection(1, "Interrupted git ops", "broken");
  for (const name of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "BISECT_LOG"]) {
    const r = ctx.gitRun(["rev-parse", "--git-path", name]);
    if (r.status !== 0) continue;
    const p = r.stdout.trim();
    if (!p) continue;
    const abs = isAbsolute(p) ? p : join(ctx.cwd, p);
    if (ctx.existsImpl(abs)) s.items.push(item(name, { label: ABORT }));
  }
  return finalizeSection(s);
}

function checkConflict(ctx) {
  const s = mkSection(2, "Conflict markers", "broken");
  const r = ctx.gitRun(["diff", "--check"]);
  // `git diff --check` exits non-zero WHEN it finds problems, so status is not a
  // failure signal here; only truly-absent stdout means clean.
  for (const line of r.stdout.split("\n")) {
    if (line.trim()) s.items.push(item(line.trim(), { label: CONFIRM }));
  }
  return finalizeSection(s);
}

function checkWorkingTree(ctx) {
  const s = mkSection(3, "Working tree", "local");
  const r = ctx.gitRun(["status", "-s"]);
  if (r.status !== 0) {
    s.error = firstLine(r.stderr) || "git status failed";
    return finalizeSection(s);
  }
  for (const line of r.stdout.split("\n")) {
    if (line.trim()) s.items.push(item(line)); // info only, no label
  }
  return finalizeSection(s);
}

function checkStash(ctx) {
  const s = mkSection(4, "Stash", "local");
  const r = ctx.gitRun(["stash", "list", "--format=%gd %ci %gs"]);
  if (r.status !== 0) {
    s.error = firstLine(r.stderr) || "git stash list failed";
    return finalizeSection(s);
  }
  const nowMs = ctx.now().getTime();
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^(stash@\{\d+\})\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4})\s+(.*)$/);
    if (!m) continue;
    const [, ref, dateStr, subject] = m;
    const iso = dateStr.replace(" ", "T").replace(" ", "");
    const age = ageDaysFrom(nowMs, iso) ?? 0;
    const bm = subject.match(/(?:WIP on|On) ([^:]+):/);
    const branch = bm ? bm[1].trim() : null;
    const gone = branch ? !branchExists(ctx.gitRun, branch) : false;
    const label = `${ref}  ${age}d  ${branch ?? "?"}  ${subject}`;
    if (gone) {
      // Phase-1 threshold drop (origin branch gone): NOT --fix eligible.
      s.items.push(item(label, { label: DROP }));
    } else if (age >= STALE_DAYS) {
      s.items.push(item(label, { label: CONFIRM, _phase2: { kind: "stash-apply", ref } }));
    }
  }
  return finalizeSection(s);
}

function checkLocalBranch(ctx) {
  const s = mkSection(5, "Local branches", "local");
  const r = ctx.gitRun([
    "for-each-ref",
    "--sort=committerdate",
    "--format=%(refname:short)\t%(upstream:short)\t%(upstream:track)\t%(committerdate:unix)",
    "refs/heads/",
  ]);
  if (r.status !== 0) {
    s.error = firstLine(r.stderr) || "git for-each-ref failed";
    return finalizeSection(s);
  }
  const nowSec = Math.floor(ctx.now().getTime() / 1000);
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [name, upstream, track, cdRaw] = line.split("\t");
    const cd = Number(cdRaw) || 0;
    const age = Math.max(0, Math.floor((nowSec - cd) / 86400));

    const syn = name.match(/^worktree-agent-(.+)$/);
    if (syn) {
      if (ctx.worktreeIds.has(syn[1])) continue; // worktree present → in use
      s.items.push(
        item(`${name}    drive synthetic, parent worktree missing`, {
          label: PRUNE,
          labelSuffix: "(git branch -D)",
          tags: ["drive synthetic"],
          fix: { args: ["branch", "-D", name], eligible: true },
        }),
      );
      continue;
    }

    const pr = ctx.prMap.get(name);
    if (pr && (pr.state === "MERGED" || pr.mergedAt)) {
      const mergedSec = pr.mergedAt ? Math.floor(Date.parse(pr.mergedAt) / 1000) : 0;
      if (mergedSec && cd > mergedSec) {
        s.items.push(
          item(`${name}    merged (PR #${pr.number}), 追加 commit あり`, {
            label: CONFIRM,
            _phase2: { kind: "branch-cherry", name },
          }),
        );
      } else {
        s.items.push(
          item(`${name}    merged (PR #${pr.number})`, {
            label: DELETE,
            fix: { args: ["branch", "-d", name], eligible: true },
          }),
        );
      }
      continue;
    }

    if (!upstream) {
      if (age >= STALE_DAYS) {
        s.items.push(
          item(`${name}    no upstream, ${age}d`, {
            label: CONFIRM,
            _phase2: { kind: "branch-cherry", name },
          }),
        );
      } else {
        s.items.push(item(`${name}    no upstream, unpushed`, { label: PUSH }));
      }
      continue;
    }

    if (/gone/.test(track)) continue; // gone tracking is remote-prune territory (#6)
    if (/ahead/.test(track)) {
      s.items.push(item(`${name}    ${track.trim()}, unpushed`, { label: PUSH }));
    }
  }
  return finalizeSection(s);
}

function checkRemoteTracking(ctx) {
  const s = mkSection(6, "Remote tracking", "local");
  const r = ctx.gitRun(["remote", "prune", "origin", "--dry-run"]);
  if (r.status !== 0) {
    s.error = classifyGitRemoteError(r);
    return finalizeSection(s);
  }
  const refs = [];
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/\[would prune\]\s+(\S+)/);
    if (m) refs.push(m[1]);
  }
  refs.forEach((ref, i) => {
    s.items.push(
      item(ref, {
        label: PRUNE,
        // One `git remote prune origin` prunes all refs, so only the first item
        // carries the (single) fix action.
        fix: i === 0 ? { args: ["remote", "prune", "origin"], eligible: true } : null,
      }),
    );
  });
  return finalizeSection(s);
}

function worktreeRemoveArgs(wt) {
  return wt.locked ? ["worktree", "remove", "-f", "-f", wt.path] : ["worktree", "remove", wt.path];
}

function worktreeSuffix(wt) {
  return wt.locked ? "(git worktree remove -f -f)" : "(git worktree remove)";
}

function checkWorktree(ctx) {
  const s = mkSection(7, "Worktrees", "local");
  if (!ctx.worktrees.ok) {
    s.error = "git worktree list failed";
    return finalizeSection(s);
  }
  const cwdReal = realpathOrSelf(ctx.cwd);
  ctx.worktrees.list.forEach((wt, idx) => {
    if (idx === 0 || wt.bare) return; // main worktree
    if (realpathOrSelf(wt.path) === cwdReal) return; // never recommend pruning ourselves
    const brDisp = wt.branch ? `[${wt.branch}]` : wt.detached ? "[detached]" : "";
    if (agentIdOf(wt.path)) {
      const tags = ["drive orphan"];
      if (wt.locked) tags.push("locked");
      s.items.push(
        item(`${wt.path}  ${brDisp}  ${tags.join(", ")}`.trimEnd(), {
          label: PRUNE,
          labelSuffix: worktreeSuffix(wt),
          tags,
          fix: { args: worktreeRemoveArgs(wt), eligible: true },
        }),
      );
      return;
    }
    const pr = wt.branch ? ctx.prMap.get(wt.branch) : null;
    const merged = pr && (pr.state === "MERGED" || pr.mergedAt);
    const gone = wt.branch ? !branchExists(ctx.gitRun, wt.branch) : false;
    if (merged || gone) {
      s.items.push(
        item(`${wt.path}  ${brDisp}`.trimEnd(), {
          label: PRUNE,
          labelSuffix: worktreeSuffix(wt),
          fix: { args: worktreeRemoveArgs(wt), eligible: true },
        }),
      );
    }
  });
  return finalizeSection(s);
}

function checkSubmodule(ctx) {
  const s = mkSection(8, "Submodules", "local");
  const r = ctx.gitRun(["submodule", "status"]);
  if (r.status !== 0) {
    s.error = firstLine(r.stderr) || "git submodule failed";
    return finalizeSection(s);
  }
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const prefix = line[0];
    if (prefix === "+" || prefix === "-" || prefix === "U") {
      s.items.push(item(line.trim(), { label: CONFIRM }));
    }
  }
  return finalizeSection(s);
}

function checkTag(ctx) {
  const s = mkSection(9, "Tags", "local");
  const localR = ctx.gitRun(["tag", "-l"]);
  if (localR.status !== 0) {
    s.error = firstLine(localR.stderr) || "git tag failed";
    return finalizeSection(s);
  }
  const local = new Set(localR.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  const remoteR = ctx.gitRun(["ls-remote", "--tags", "origin"]);
  if (remoteR.status !== 0) {
    s.error = classifyGitRemoteError(remoteR);
    return finalizeSection(s);
  }
  const remote = new Set();
  for (const line of remoteR.stdout.split("\n")) {
    const m = line.match(/refs\/tags\/(\S+?)(?:\^\{\})?$/);
    if (m) remote.add(m[1]);
  }
  const localOnly = [...local].filter((t) => !remote.has(t)).sort();
  const remoteOnly = [...remote].filter((t) => !local.has(t)).sort();
  for (const t of localOnly) s.items.push(item(`${t}  local only`, { label: PUSH }));
  remoteOnly.forEach((t, i) => {
    s.items.push(
      item(`${t}  remote only`, {
        label: FETCH,
        fix: i === 0 ? { args: ["fetch", "--tags"], eligible: true } : null,
      }),
    );
  });
  return finalizeSection(s);
}

function sortByField(rows, field) {
  return [...rows].sort((a, b) => String(a?.[field]).localeCompare(String(b?.[field])));
}

function checkOpenPrMine(ctx) {
  const s = mkSection(10, "My open PRs", "triage-mine");
  const res = ghJson(ctx.ghRun, [
    "pr", "list", "--author", "@me", "--state", "open", "--json", "number,title,isDraft,updatedAt",
  ]);
  if (!res.ok) {
    s.error = res.error;
    return finalizeSection(s);
  }
  const nowMs = ctx.now().getTime();
  for (const pr of sortByField(res.data, "updatedAt")) {
    s.items.push(
      item(`#${pr.number}  ${ageTag(nowMs, pr.updatedAt)}  ${pr.title}`, {
        label: pr.isDraft ? CONFIRM : ACTION,
      }),
    );
  }
  return finalizeSection(s);
}

function checkOpenIssueMine(ctx) {
  const s = mkSection(11, "Issues assigned to me", "triage-mine");
  const res = ghJson(ctx.ghRun, [
    "issue", "list", "--assignee", "@me", "--state", "open", "--json", "number,title,updatedAt",
  ]);
  if (!res.ok) {
    s.error = res.error;
    return finalizeSection(s);
  }
  const nowMs = ctx.now().getTime();
  for (const iss of sortByField(res.data, "updatedAt")) {
    s.items.push(item(`#${iss.number}  ${ageTag(nowMs, iss.updatedAt)}  ${iss.title}`, { label: ACTION }));
  }
  return finalizeSection(s);
}

function checkReviewRequests(ctx) {
  const s = mkSection(12, "Review requests on me", "triage-mine");
  const res = ghJson(ctx.ghRun, [
    "pr", "list", "--search", "is:open review-requested:@me", "--json", "number,title,author,updatedAt",
  ]);
  if (!res.ok) {
    s.error = res.error;
    return finalizeSection(s);
  }
  const nowMs = ctx.now().getTime();
  for (const pr of sortByField(res.data, "updatedAt")) {
    const who = pr.author?.login ?? "?";
    s.items.push(
      item(`#${pr.number}  ${ageTag(nowMs, pr.updatedAt)}  ${who}  ${pr.title}`, { label: ACTION }),
    );
  }
  return finalizeSection(s);
}

function checkFailedActions(ctx) {
  const s = mkSection(13, "Recent failed actions", "triage-mine");
  const branch = ctx.gitRun(["branch", "--show-current"]).stdout.trim();
  if (!branch) {
    s.skipped = "detached HEAD";
    return finalizeSection(s);
  }
  const res = ghJson(ctx.ghRun, [
    "run", "list", "--branch", branch, "--status", "failure", "--limit", "5",
    "--json", "databaseId,name,conclusion,createdAt,url",
  ]);
  if (!res.ok) {
    s.error = res.error;
    return finalizeSection(s);
  }
  const nowMs = ctx.now().getTime();
  for (const run of sortByField(res.data, "createdAt")) {
    s.items.push(
      item(`${run.databaseId}  ${ageTag(nowMs, run.createdAt)}  ${run.name}`, {
        label: CONFIRM,
        _phase2: { kind: "ci-run", id: run.databaseId, name: run.name },
      }),
    );
  }
  return finalizeSection(s);
}

function checkDraftReleases(ctx) {
  const s = mkSection(14, "Draft releases", "triage-mine");
  const res = ghJson(ctx.ghRun, [
    "release", "list", "--limit", "20", "--json", "name,tagName,isDraft,createdAt",
  ]);
  if (!res.ok) {
    s.error = res.error;
    return finalizeSection(s);
  }
  const nowMs = ctx.now().getTime();
  const drafts = sortByField(res.data.filter((r) => r.isDraft), "createdAt");
  for (const rel of drafts) {
    s.items.push(
      item(`${rel.tagName ?? rel.name}  ${ageTag(nowMs, rel.createdAt)}  ${rel.name ?? ""}`.trimEnd(), {
        label: ACTION,
      }),
    );
  }
  return finalizeSection(s);
}

function isBotAuthor(author) {
  if (!author) return false;
  if (author.is_bot === true) return true;
  const login = String(author.login ?? "");
  return /\[bot\]$/.test(login) || login.startsWith("app/") || BOT_LOGINS.has(login);
}

function checkAutomationPrs(ctx) {
  const s = mkSection(15, "Automation PRs", "triage-automation");
  const res = ghJson(ctx.ghRun, [
    "pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,author,updatedAt",
  ]);
  if (!res.ok) {
    s.error = res.error;
    return finalizeSection(s);
  }
  const nowMs = ctx.now().getTime();
  const bots = sortByField(res.data.filter((pr) => isBotAuthor(pr.author)), "updatedAt");
  for (const pr of bots) {
    const who = pr.author?.login ?? "?";
    s.items.push(
      item(`#${pr.number}  ${who}  ${ageTag(nowMs, pr.updatedAt)}  ${pr.title}`, { label: ACTION }),
    );
  }
  return finalizeSection(s);
}

const PERSPECTIVE_REQUIRED = [
  "name", "category", "description", "applies_when", "default_enabled", "severity_rules", "exit_criteria",
];
const PERSPECTIVE_CATEGORIES = new Set(["required", "design", "quality", "ux"]);

/**
 * Extract the top-level `key: value` lines of a markdown frontmatter block into
 * a flat map (values are the raw right-hand strings, incl. inline flow arrays /
 * objects). Returns null when there is no frontmatter. Exported for tests.
 */
export function extractFrontmatterMap(raw) {
  const m = String(raw).match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const map = {};
  for (const line of m[1].split("\n")) {
    const fm = line.match(/^([A-Za-z_][\w-]*):(.*)$/);
    if (fm) map[fm[1]] = fm[2].trim();
  }
  return map;
}

function unquote(v) {
  const s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Validate one perspective frontmatter map; returns a list of problem strings
 * (empty = valid). Exported for tests.
 */
export function validatePerspective(axis, fm) {
  const problems = [];
  for (const key of PERSPECTIVE_REQUIRED) {
    if (!(key in fm)) problems.push(`必須キー欠落: ${key}`);
  }
  if ("name" in fm && unquote(fm.name) !== axis) {
    problems.push(`name='${unquote(fm.name)}' がファイル名と不一致`);
  }
  if ("category" in fm && !PERSPECTIVE_CATEGORIES.has(unquote(fm.category))) {
    problems.push(`category='${unquote(fm.category)}' が不正`);
  }
  if ("severity_rules" in fm) {
    for (const level of ["critical", "warning", "info"]) {
      if (!new RegExp(`\\b${level}\\b`).test(fm.severity_rules)) {
        problems.push(`severity_rules に ${level} なし`);
      }
    }
  }
  if ("exit_criteria" in fm && !/drive_loop/.test(fm.exit_criteria)) {
    problems.push("exit_criteria.drive_loop なし");
  } else if ("exit_criteria" in fm && !/critical/.test(fm.exit_criteria)) {
    problems.push("exit_criteria.drive_loop.critical なし");
  }
  if ("applies_when" in fm) {
    const globs = [...fm.applies_when.matchAll(/"([^"]*)"|'([^']*)'/g)].map((g) => g[1] ?? g[2]);
    for (const glob of globs) {
      if (glob === "" || glob.startsWith("/") || /\n/.test(glob)) {
        problems.push(`applies_when glob 不正: '${glob}'`);
      }
    }
  }
  return problems;
}

function listPerspectiveFiles(readdirImpl, dir) {
  return readdirImpl(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort();
}

function checkPerspectives(ctx) {
  const s = mkSection(16, "Perspective MD frontmatter", "catalog");
  const ssotDir = join(ctx.cwd, ".agents", "skills", "review", "perspectives");
  const claudeDir = join(ctx.cwd, ".claude", "skills", "review", "perspectives");
  if (!ctx.existsImpl(ssotDir)) {
    s.skipped = "no perspectives dir";
    return finalizeSection(s);
  }
  let files;
  try {
    files = listPerspectiveFiles(ctx.readdirImpl, ssotDir);
  } catch (e) {
    s.error = firstLine(e?.message) || "readdir failed";
    return finalizeSection(s);
  }
  for (const f of files) {
    const axis = f.replace(/\.md$/, "");
    let raw;
    try {
      raw = ctx.readImpl(join(ssotDir, f));
    } catch {
      s.items.push(item(`${axis}: read failed`, { label: CONFIRM }));
      continue;
    }
    const fm = extractFrontmatterMap(raw);
    if (!fm) {
      s.items.push(item(`${axis}: frontmatter 欠落`, { label: CONFIRM }));
      continue;
    }
    const problems = validatePerspective(axis, fm);
    if (problems.length) s.items.push(item(`${axis}: ${problems.join("; ")}`, { label: CONFIRM }));
  }
  if (ctx.existsImpl(claudeDir)) {
    try {
      const claudeFiles = listPerspectiveFiles(ctx.readdirImpl, claudeDir);
      if (JSON.stringify(claudeFiles) !== JSON.stringify(files)) {
        s.items.push(item("SSOT と .claude 配信先で drift（pnpm build 未実行?）", { label: CONFIRM }));
      }
    } catch {
      // delivery dir unreadable → not fatal; SSOT validation already ran.
    }
  }
  return finalizeSection(s);
}

// ---------------------------------------------------------------------------
// Phase 2 (--deep): investigate `要確認` items, upgrade labels where machine-
// decidable. read-only.
// ---------------------------------------------------------------------------

function resolveTrunk(gitRun) {
  if (gitRun(["rev-parse", "--verify", "--quiet", "refs/heads/main"]).status === 0) return "main";
  if (gitRun(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"]).status === 0) {
    return "origin/main";
  }
  return null;
}

function stashApplyPhase2(ctx, it, p) {
  const patch = ctx.gitRun(["stash", "show", "-p", p.ref]);
  if (patch.status !== 0) {
    it.rationale = "patch unreadable";
    return;
  }
  const chk = ctx.gitRun(["apply", "--check"], { input: patch.stdout });
  if (chk.status !== 0) {
    it.label = DROP;
    it.rationale = "apply --check failed (conflicts with HEAD)";
    it.fix = { args: ["stash", "drop", p.ref], eligible: true }; // Phase-2 drop IS fixable
  }
}

function branchCherryPhase2(ctx, it, p) {
  const trunk = resolveTrunk(ctx.gitRun);
  if (!trunk) {
    it.rationale = "cherry check failed";
    return;
  }
  const r = ctx.gitRun(["cherry", trunk, p.name]);
  if (r.status !== 0) {
    it.rationale = "cherry check failed";
    return;
  }
  const lines = r.stdout.split("\n").filter((l) => l.trim());
  const allMerged = lines.length === 0 || lines.every((l) => l.startsWith("-"));
  if (allMerged) {
    it.label = DELETE;
    it.rationale = "trunk に取り込み済み";
    it.fix = { args: ["branch", "-d", p.name], eligible: true };
  } else {
    it.rationale = "trunk に未取り込み commit あり";
  }
}

/**
 * Extract a same-error grouping key from a failed-run log: the matched portion
 * of the LAST line containing an error/failed keyword (ANSI stripped). Exported
 * for tests.
 */
export function extractCiErrorKey(logText) {
  let key = null;
  for (const raw of stripAnsi(logText).split("\n")) {
    const m = raw.match(/(error|Error|failed)[\s:].*$/);
    if (m) key = m[0].trim();
  }
  return key;
}

function ciPhase2(ctx, sections) {
  const s = sections.find((x) => x.id === 13);
  if (!s || s.status === "error" || s.status === "skipped") return;
  const runs = s.items.filter((it) => it._phase2?.kind === "ci-run");
  if (runs.length === 0) return;

  const keys = [];
  const errLine = [];
  runs.forEach((it, idx) => {
    if (idx < 3) {
      const r = ctx.ghRun(["run", "view", String(it._phase2.id), "--log-failed"]);
      if (r.error || r.status !== 0) {
        it.rationale = "log fetch failed";
        keys.push(null);
        errLine.push(null);
        return;
      }
      const key = extractCiErrorKey(r.stdout);
      keys.push(key ?? `__solo_${idx}`);
      errLine.push(key);
    } else {
      // 4th+: not fetched — attributed to the representative (oldest) group.
      keys.push(keys[0] ?? `__solo_${idx}`);
      errLine.push(errLine[0] ?? null);
    }
  });

  const groups = new Map();
  runs.forEach((it, idx) => {
    if (keys[idx] == null) return; // log fetch failed → left as 要確認 + rationale
    if (!groups.has(keys[idx])) groups.set(keys[idx], []);
    groups.get(keys[idx]).push(idx);
  });

  for (const idxs of groups.values()) {
    const repIdx = idxs[0];
    const rep = runs[repIdx];
    if (idxs.length >= 2) {
      rep.label = ACTION;
      rep.rationale = `${errLine[repIdx] ?? "same error"} (${idxs.length} 件同一エラー)`;
      for (const j of idxs.slice(1)) {
        runs[j].label = null;
        runs[j].note = `same as ${rep._phase2.id}`;
        runs[j].rationale = null;
      }
    } else if (errLine[repIdx]) {
      rep.rationale = `root cause: ${errLine[repIdx]}`;
    }
  }
}

function runPhase2(ctx, sections) {
  for (const s of sections) {
    for (const it of s.items) {
      if (it._phase2?.kind === "stash-apply") stashApplyPhase2(ctx, it, it._phase2);
      else if (it._phase2?.kind === "branch-cherry") branchCherryPhase2(ctx, it, it._phase2);
    }
  }
  ciPhase2(ctx, sections);
  for (const s of sections) finalizeSection(s); // labels may have changed
}

// ---------------------------------------------------------------------------
// --fix: plan + execute (safe vocabulary only)
// ---------------------------------------------------------------------------

/**
 * Collect the safe, auto-executable actions across all sections. Exported for
 * tests. Only items whose `fix.eligible` is true are ever included — that gate
 * is set exclusively for the safe vocabulary (prune / delete / fetch / Phase-2
 * drop). A defensive second guard drops anything whose label is not safe.
 */
export function collectFixPlan(sections) {
  const plan = [];
  for (const s of sections) {
    for (const it of s.items) {
      if (!it.fix?.eligible) continue;
      if (!SAFE_FIX_LABELS.has(it.label) && it.label !== DROP) continue; // never a non-safe label
      plan.push({ section: s.id, label: it.label, text: it.text, args: it.fix.args });
    }
  }
  return plan;
}

function executeFix(ctx, plan) {
  const results = [];
  for (const p of plan) {
    const r = ctx.gitRun(p.args);
    const ok = r.status === 0;
    results.push({
      section: p.section,
      label: p.label,
      text: p.text,
      command: `git ${p.args.join(" ")}`,
      ok,
      result: ok ? "done" : `failed: ${firstLine(r.stderr) || firstLine(r.error?.message) || "unknown"}`,
    });
  }
  return results;
}

function cleanItems(sections) {
  for (const s of sections) {
    for (const it of s.items) {
      it._phase2 = undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

function buildCtx(cwd, deep, deps) {
  const now = deps.now ?? (() => new Date());
  const gitRun = deps.gitRun ?? makeRunner("git", cwd);
  const ghRun = deps.ghRun ?? makeRunner("gh", cwd);
  const existsImpl = deps.existsImpl ?? existsSync;
  const readdirImpl = deps.readdirImpl ?? ((d) => readdirSync(d));
  const readImpl = deps.readImpl ?? ((p) => readFileSync(p, "utf8"));

  const wtRes = gitRun(["worktree", "list", "--porcelain"]);
  const worktrees = {
    ok: wtRes.status === 0,
    list: wtRes.status === 0 ? parseWorktrees(wtRes.stdout) : [],
  };
  const worktreeIds = new Set();
  for (const wt of worktrees.list) {
    const id = agentIdOf(wt.path);
    if (id) worktreeIds.add(id);
  }

  const prRes = ghJson(ghRun, [
    "pr", "list", "--state", "all", "--json", "number,state,mergedAt,headRefName", "--limit", "100",
  ]);
  const prMap = new Map();
  if (prRes.ok) {
    for (const pr of prRes.data) if (pr.headRefName) prMap.set(pr.headRefName, pr);
  }

  return {
    cwd,
    deep,
    now,
    gitRun,
    ghRun,
    existsImpl,
    readdirImpl,
    readImpl,
    worktrees,
    worktreeIds,
    prMap,
    prError: prRes.ok ? null : prRes.error,
  };
}

export function collect(ctx) {
  return [
    checkInterrupted(ctx),
    checkConflict(ctx),
    checkWorkingTree(ctx),
    checkStash(ctx),
    checkLocalBranch(ctx),
    checkRemoteTracking(ctx),
    checkWorktree(ctx),
    checkSubmodule(ctx),
    checkTag(ctx),
    checkOpenPrMine(ctx),
    checkOpenIssueMine(ctx),
    checkReviewRequests(ctx),
    checkFailedActions(ctx),
    checkDraftReleases(ctx),
    checkAutomationPrs(ctx),
    checkPerspectives(ctx),
  ];
}

/**
 * Full run: build ctx → collect the 16 sections → optional Phase 2 → optional
 * --fix plan/execute. Never throws; returns the structured result.
 * @param {string[]} argv
 * @param {object} [deps]  injectable { cwd, now, gitRun, ghRun, existsImpl, readdirImpl, readImpl }
 */
export function run(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const cwd = typeof args["repo-root"] === "string" ? args["repo-root"] : deps.cwd ?? process.cwd();
  const deep = Boolean(args.deep);
  const fix = Boolean(args.fix);
  const yes = Boolean(args.yes);

  const ctx = buildCtx(cwd, deep, deps);
  const sections = collect(ctx);
  if (deep) runPhase2(ctx, sections);

  const result = {
    schema_version: SCHEMA_VERSION,
    generated_at: ctx.now().toISOString(),
    phase: deep ? 2 : 1,
    deep,
    fix,
    gh_available: ctx.prError === null,
    sections,
  };

  if (fix) {
    const plan = collectFixPlan(sections);
    result.fix_plan = plan.map((p) => ({
      section: p.section,
      label: p.label,
      text: p.text,
      command: `git ${p.args.join(" ")}`,
    }));
    if (yes) {
      result.fix_results = executeFix(ctx, plan);
      // Re-check (Phase 1 only) so the report can show the after-state.
      const afterCtx = buildCtx(cwd, false, deps);
      const after = collect(afterCtx);
      cleanItems(after);
      result.after = after;
    } else {
      result.fix_pending = true;
    }
  }

  cleanItems(sections);
  return result;
}

// ---------------------------------------------------------------------------
// rendering (deterministic; owned by the engine, not the LLM)
// ---------------------------------------------------------------------------

function renderItem(it) {
  let right = "";
  if (it.label) right = `  → ${it.label}${it.labelSuffix ? ` ${it.labelSuffix}` : ""}`;
  else if (it.note) right = `  → ${it.note}`;
  const rat = it.rationale ? `  │ ${it.rationale}` : "";
  return `${it.text}${right}${rat}`;
}

function renderStatusTable(sections) {
  const lines = ["| # | 領域 | 状態 | 詳細 |", "|---|---|---|---|"];
  for (const s of sections) {
    lines.push(`| ${s.id} | ${s.name} | ${ICON[s.status]} | ${s.detail} |`);
  }
  return lines;
}

function renderNonCleanSections(sections) {
  const lines = [];
  for (const s of sections) {
    if (s.status === "clean") continue;
    lines.push("");
    if (s.status === "error") {
      lines.push(`## ${s.name}`, `(error: ${s.error})`);
    } else if (s.status === "skipped") {
      lines.push(`## ${s.name}`, `(skipped: ${s.skipped})`);
    } else {
      lines.push(`## ${s.name} (${s.items.length})`);
      for (const it of s.items) lines.push(renderItem(it));
    }
  }
  return lines;
}

/**
 * Render the structured result into the human report (status table + non-clean
 * sections + optional --fix plan/results). Exported for tests + CLI.
 */
export function render(result) {
  const lines = renderStatusTable(result.sections);
  lines.push(...renderNonCleanSections(result.sections));

  if (result.fix_pending) {
    lines.push("", `## 実行予定の安全アクション (${result.fix_plan.length})`);
    if (result.fix_plan.length === 0) {
      lines.push("(none: 安全に自動実行できるアクションはありません)");
    } else {
      for (const p of result.fix_plan) lines.push(`- [${p.label}] ${p.text}  → ${p.command}`);
      lines.push("", "確認後、--yes を付けて再実行すると上記を直列実行します。");
    }
  }

  if (result.fix_results) {
    lines.push("", `## 実行結果 (${result.fix_results.length})`);
    for (const r of result.fix_results) {
      const mark = r.ok ? "✔ done" : `✖ ${r.result}`;
      lines.push(`- [${r.label}] ${r.text}  → ${r.command}  … ${mark}`);
    }
    if (result.after) {
      lines.push("", "### 実行後のステータス", ...renderStatusTable(result.after));
    }
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
