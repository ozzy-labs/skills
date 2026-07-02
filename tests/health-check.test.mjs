// Tests for health-check.mjs — the deterministic `health` engine (ADR-0028 R1).
//
// Two layers:
//   1. Pure functions (parseArgs, parseWorktrees, frontmatter/perspective
//      validation, CI-error keying, the safe-vocabulary fix filter).
//   2. Real tmp git-repo fixtures that exercise the domain judgment end-to-end
//      (merged branch -> delete, stale stash -> 要確認, gone tracking -> prune,
//      orphan synthetic branch -> prune) plus the --fix safe executor and the
//      read-only invariant when --fix is absent. `gh` is dependency-injected.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  collectFixPlan,
  extractCiErrorKey,
  extractFrontmatterMap,
  makeRunner,
  parseArgs,
  parseWorktrees,
  render,
  run,
  validatePerspective,
} from "../.agents/skills/health/health-check.mjs";

const NOW = "2026-07-02T00:00:00Z";
const nowFn = () => new Date(NOW);

const BASE_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const tmpDirs = [];

function mkRepo() {
  const dir = mkdtempSync(join(tmpdir(), "health-fixture-"));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/** Run a git command in the fixture (throws on failure), with optional dates. */
function git(dir, args, extraEnv = {}) {
  const res = spawnSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...BASE_ENV, ...extraEnv },
    },
  );
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

function commit(dir, file, content, date) {
  spawnSync("bash", ["-c", `printf %s ${JSON.stringify(content)} > ${JSON.stringify(file)}`], {
    cwd: dir,
  });
  git(dir, ["add", "."]);
  git(
    dir,
    ["commit", "-m", `add ${file}`],
    date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {},
  );
}

function initRepo(dir) {
  git(dir, ["init", "-q"]);
  commit(dir, "README.md", "hello\n", "2026-06-01T00:00:00Z");
}

/** A gh runner that answers the buildCtx PR-map query and returns [] elsewhere. */
function fakeGh(prList = []) {
  return (args) => {
    const isPrListAll = args[0] === "pr" && args[1] === "list" && args.includes("all");
    const stdout = isPrListAll ? JSON.stringify(prList) : "[]";
    return { status: 0, stdout, stderr: "", error: null };
  };
}

/** A gh runner that simulates an unauthenticated CLI. */
const unauthGh = () => ({
  status: 1,
  stdout: "",
  stderr:
    "To get started with GitHub CLI, please run: gh auth login\nnot logged into any GitHub hosts",
  error: null,
});

function findSection(result, id) {
  return result.sections.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// pure functions
// ---------------------------------------------------------------------------

test("parseArgs: flags and key=value", () => {
  assert.deepEqual(parseArgs(["--deep", "--fix", "--repo-root=/x"]), {
    deep: true,
    fix: true,
    "repo-root": "/x",
  });
});

test("parseWorktrees: parses porcelain + branch/locked", () => {
  const out = [
    "worktree /repo",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree /repo/.claude/worktrees/agent-deadbeef",
    "HEAD def",
    "branch refs/heads/worktree-agent-deadbeef",
    "locked",
    "",
  ].join("\n");
  const list = parseWorktrees(out);
  assert.equal(list.length, 2);
  assert.equal(list[0].branch, "main");
  assert.equal(list[1].path, "/repo/.claude/worktrees/agent-deadbeef");
  assert.equal(list[1].locked, true);
});

test("extractFrontmatterMap + validatePerspective: valid passes, invalid flagged", () => {
  const valid = [
    "---",
    "name: correctness",
    "category: required",
    "description: x",
    'applies_when: ["**/*"]',
    "default_enabled: true",
    'severity_rules: { critical: "a", warning: "b", info: "c" }',
    "exit_criteria: { drive_loop: { critical: 0, warning: 0 } }",
    "---",
    "",
    "# body",
  ].join("\n");
  const fm = extractFrontmatterMap(valid);
  assert.deepEqual(validatePerspective("correctness", fm), []);

  // name mismatch + missing severity level + bad category.
  const bad = [
    "---",
    "name: wrong",
    "category: bogus",
    "description: x",
    'applies_when: ["/abs"]',
    "default_enabled: true",
    'severity_rules: { critical: "a", info: "c" }',
    "exit_criteria: { drive_loop: { critical: 0 } }",
    "---",
  ].join("\n");
  const problems = validatePerspective("correctness", extractFrontmatterMap(bad));
  assert.ok(problems.some((p) => p.includes("name=")));
  assert.ok(problems.some((p) => p.includes("category=")));
  assert.ok(problems.some((p) => p.includes("warning")));
  assert.ok(problems.some((p) => p.includes("applies_when")));

  assert.equal(extractFrontmatterMap("no frontmatter here"), null);
});

test("extractCiErrorKey: takes the last error-ish line, ANSI stripped", () => {
  const log = ["[36mstep[0m", "Error: first failure", "info: noise", "error: rsync exit 23"].join(
    "\n",
  );
  assert.equal(extractCiErrorKey(log), "error: rsync exit 23");
  assert.equal(extractCiErrorKey("all good\nnothing here"), null);
});

test("collectFixPlan: only safe-vocabulary eligible items, never push/要確認", () => {
  const sections = [
    {
      id: 5,
      items: [
        { label: "delete", text: "b1", fix: { args: ["branch", "-d", "b1"], eligible: true } },
        { label: "push", text: "b2", fix: { args: ["push"], eligible: true } }, // must be dropped
        { label: "要確認", text: "b3", fix: null },
      ],
    },
    {
      id: 4,
      items: [
        {
          label: "drop",
          text: "s0",
          fix: { args: ["stash", "drop", "stash@{0}"], eligible: true },
        },
      ],
    },
    {
      id: 6,
      items: [
        { label: "prune", text: "r", fix: { args: ["remote", "prune", "origin"], eligible: true } },
      ],
    },
  ];
  const plan = collectFixPlan(sections);
  assert.deepEqual(
    plan.map((p) => p.label),
    ["delete", "drop", "prune"],
  );
  assert.ok(!plan.some((p) => p.label === "push"));
});

// ---------------------------------------------------------------------------
// fixtures: domain judgment
// ---------------------------------------------------------------------------

test("merged branch -> delete", () => {
  const dir = mkRepo();
  initRepo(dir);
  git(dir, ["checkout", "-q", "-b", "merged-feat"]);
  commit(dir, "f.txt", "x\n", "2026-06-20T00:00:00Z");
  git(dir, ["checkout", "-q", "main"]);
  git(dir, ["merge", "-q", "--no-ff", "merged-feat", "-m", "merge"], {
    GIT_AUTHOR_DATE: "2026-06-25T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-06-25T00:00:00Z",
  });

  const gh = fakeGh([
    { number: 42, state: "MERGED", mergedAt: "2026-06-25T00:00:00Z", headRefName: "merged-feat" },
  ]);
  const result = run([], { cwd: dir, ghRun: gh, now: nowFn });
  const s5 = findSection(result, 5);
  const merged = s5.items.find((it) => it.text.includes("merged-feat"));
  assert.ok(merged, "merged-feat item present");
  assert.equal(merged.label, "delete");
  assert.equal(merged.fix.eligible, true);
  assert.deepEqual(merged.fix.args, ["branch", "-d", "merged-feat"]);
});

test("stale (14d+) stash on an existing branch -> 要確認", () => {
  const dir = mkRepo();
  initRepo(dir);
  spawnSync("bash", ["-c", "printf 'change\\n' >> README.md"], { cwd: dir });
  git(dir, ["stash", "push", "-m", "old work"], {
    GIT_AUTHOR_DATE: "2026-06-12T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-06-12T00:00:00Z",
  });

  const result = run([], { cwd: dir, ghRun: fakeGh(), now: nowFn });
  const s4 = findSection(result, 4);
  assert.equal(s4.status, "non-clean");
  assert.equal(s4.items.length, 1);
  assert.equal(s4.items[0].label, "要確認"); // stash on `main`, which still exists
  assert.match(s4.detail, /1 件（要確認）/);
});

test("gone remote tracking ref -> prune", () => {
  const dir = mkRepo();
  const bare = mkRepo();
  git(bare, ["init", "-q", "--bare"]);
  initRepo(dir);
  git(dir, ["remote", "add", "origin", bare]);
  git(dir, ["push", "-q", "origin", "main"]);
  git(dir, ["checkout", "-q", "-b", "feature"]);
  commit(dir, "g.txt", "y\n", "2026-06-20T00:00:00Z");
  git(dir, ["push", "-q", "origin", "feature"]);
  git(dir, ["checkout", "-q", "main"]);
  // Remote deletes the branch out from under us -> origin/feature is now stale.
  git(bare, ["update-ref", "-d", "refs/heads/feature"]);

  const result = run([], { cwd: dir, ghRun: fakeGh(), now: nowFn });
  const s6 = findSection(result, 6);
  assert.equal(s6.status, "non-clean", `expected prune, got ${s6.detail}`);
  assert.ok(s6.items.some((it) => it.label === "prune" && /origin\/feature/.test(it.text)));
  // Exactly one fix action prunes them all.
  const eligible = s6.items.filter((it) => it.fix?.eligible);
  assert.equal(eligible.length, 1);
  assert.deepEqual(eligible[0].fix.args, ["remote", "prune", "origin"]);
});

test("orphan synthetic branch (no worktree) -> prune (git branch -D)", () => {
  const dir = mkRepo();
  initRepo(dir);
  git(dir, ["branch", "worktree-agent-deadbeef"]);

  const result = run([], { cwd: dir, ghRun: fakeGh(), now: nowFn });
  const s5 = findSection(result, 5);
  const syn = s5.items.find((it) => it.text.includes("worktree-agent-deadbeef"));
  assert.ok(syn);
  assert.equal(syn.label, "prune");
  assert.deepEqual(syn.fix.args, ["branch", "-D", "worktree-agent-deadbeef"]);
  assert.ok(syn.tags.includes("drive synthetic"));
});

test("triage sections carry a per-check error when gh is unauthenticated; git checks continue", () => {
  const dir = mkRepo();
  initRepo(dir);
  const result = run([], { cwd: dir, ghRun: unauthGh, now: nowFn });
  for (const id of [10, 11, 12, 14, 15]) {
    const s = findSection(result, id);
    assert.equal(s.status, "error");
    assert.equal(s.error, "gh not authenticated");
  }
  assert.equal(findSection(result, 3).status, "clean"); // working tree (git) unaffected
  assert.equal(result.gh_available, false);
});

// ---------------------------------------------------------------------------
// --deep Phase 2
// ---------------------------------------------------------------------------

test("--deep upgrades a conflicting stale stash 要確認 -> drop and makes it fix-eligible", () => {
  const dir = mkRepo();
  initRepo(dir);
  // Stash a change to README, then move HEAD so the stash no longer applies cleanly.
  spawnSync("bash", ["-c", "printf 'stashed line\\n' > README.md"], { cwd: dir });
  git(dir, ["stash", "push", "-m", "conflicting"], {
    GIT_AUTHOR_DATE: "2026-06-12T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-06-12T00:00:00Z",
  });
  commit(dir, "README.md", "totally different content\n", "2026-06-15T00:00:00Z");

  const result = run(["--deep"], { cwd: dir, ghRun: fakeGh(), now: nowFn });
  const s4 = findSection(result, 4);
  assert.equal(s4.items.length, 1);
  assert.equal(s4.items[0].label, "drop");
  assert.equal(s4.items[0].fix.eligible, true);
  assert.match(s4.items[0].rationale, /apply --check failed/);
});

// ---------------------------------------------------------------------------
// --fix executor + read-only invariant
// ---------------------------------------------------------------------------

const MUTATORS = [
  (a) => a[0] === "branch" && (a[1] === "-d" || a[1] === "-D"),
  (a) => a[0] === "worktree" && a[1] === "remove",
  (a) => a[0] === "stash" && a[1] === "drop",
  (a) => a[0] === "remote" && a[1] === "prune" && !a.includes("--dry-run"),
  (a) => a[0] === "fetch",
  (a) => a[0] === "push",
];
const isMutator = (args) => MUTATORS.some((fn) => fn(args));

function fixFixture() {
  const dir = mkRepo();
  initRepo(dir);
  // merged branch (delete, safe) — actually merged so `git branch -d` succeeds.
  git(dir, ["checkout", "-q", "-b", "merged-feat"]);
  commit(dir, "m.txt", "x\n", "2026-06-20T00:00:00Z");
  git(dir, ["checkout", "-q", "main"]);
  git(dir, ["merge", "-q", "merged-feat", "-m", "merge"], {
    GIT_AUTHOR_DATE: "2026-06-25T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-06-25T00:00:00Z",
  });
  // orphan synthetic branch (prune, safe).
  git(dir, ["branch", "worktree-agent-deadbeef"]);
  // fresh no-upstream branch (push, NOT safe — must never be touched).
  git(dir, ["branch", "wip-new"]);
  return dir;
}

const FIX_PR = [
  { number: 42, state: "MERGED", mergedAt: "2026-06-25T00:00:00Z", headRefName: "merged-feat" },
];

test("--fix without --yes lists the plan but executes nothing (read-only)", () => {
  const dir = fixFixture();
  const calls = [];
  const realGit = makeRunner("git", dir);
  const spyGit = (args, opts) => {
    calls.push(args);
    return realGit(args, opts);
  };

  const result = run(["--fix"], { cwd: dir, gitRun: spyGit, ghRun: fakeGh(FIX_PR), now: nowFn });
  assert.equal(result.fix_pending, true);
  assert.equal(result.fix_results, undefined);
  const labels = result.fix_plan.map((p) => p.label).sort();
  assert.deepEqual(labels, ["delete", "prune"]);
  assert.ok(!calls.some(isMutator), "no mutating git command ran in plan-only mode");
  // branches all still present
  assert.equal(existsSync(join(dir, ".git")), true);
  assert.match(git(dir, ["branch", "--list", "merged-feat"]), /merged-feat/);
  assert.match(
    git(dir, ["branch", "--list", "worktree-agent-deadbeef"]),
    /worktree-agent-deadbeef/,
  );
  assert.match(git(dir, ["branch", "--list", "wip-new"]), /wip-new/);
});

test("--fix --yes executes only the safe vocabulary; push branch is preserved", () => {
  const dir = fixFixture();
  const calls = [];
  const realGit = makeRunner("git", dir);
  const spyGit = (args, opts) => {
    calls.push(args);
    return realGit(args, opts);
  };

  const result = run(["--fix", "--yes"], {
    cwd: dir,
    gitRun: spyGit,
    ghRun: fakeGh(FIX_PR),
    now: nowFn,
  });
  assert.ok(Array.isArray(result.fix_results));
  const executed = result.fix_results.map((r) => r.label).sort();
  assert.deepEqual(executed, ["delete", "prune"]);
  assert.ok(
    result.fix_results.every((r) => r.ok),
    JSON.stringify(result.fix_results),
  );

  // Only safe mutations happened: branch -d (delete) and branch -D (prune synthetic).
  const mutations = calls.filter(isMutator);
  assert.ok(mutations.length >= 2);
  assert.ok(!mutations.some((a) => a[0] === "push"));
  assert.ok(!mutations.some((a) => a[0] === "fetch"));

  // safe branches removed, unsafe (push) branch preserved.
  assert.equal(git(dir, ["branch", "--list", "merged-feat"]).trim(), "");
  assert.equal(git(dir, ["branch", "--list", "worktree-agent-deadbeef"]).trim(), "");
  assert.match(git(dir, ["branch", "--list", "wip-new"]), /wip-new/);
  // after-state snapshot is included
  assert.ok(Array.isArray(result.after));
});

test("no --fix: default run mutates nothing on a repo full of actionable items", () => {
  const dir = fixFixture();
  const calls = [];
  const realGit = makeRunner("git", dir);
  const spyGit = (args, opts) => {
    calls.push(args);
    return realGit(args, opts);
  };

  run(["--deep"], { cwd: dir, gitRun: spyGit, ghRun: fakeGh(FIX_PR), now: nowFn });
  assert.ok(
    !calls.some(isMutator),
    `read-only invariant violated: ${JSON.stringify(calls.filter(isMutator))}`,
  );
  assert.match(git(dir, ["branch", "--list", "merged-feat"]), /merged-feat/);
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

test("render: status table has all 16 rows with an icon column", () => {
  const dir = mkRepo();
  initRepo(dir);
  const result = run([], { cwd: dir, ghRun: fakeGh(), now: nowFn });
  const text = render(result);
  const rows = text.split("\n").filter((l) => /^\| \d+ \| /.test(l));
  assert.equal(rows.length, 16);
  assert.ok(text.includes("| # | 領域 | 状態 | 詳細 |"));
});
