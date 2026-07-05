// Tests for the deps skill (issue #176) — engine-based per ADR-0028 R1.
//
// The determinism lives in `.agents/skills/deps/deps.mjs`, so these tests drive
// the ENGINE directly: fixture PR metadata + diffs + checks (pure data) ->
// deps.mjs output (enumeration / author gating / semver classification / CI /
// lockfile / peer-engines / the fixed judgment table / merge execution), with
// `gh` and `git` dependency-injected. A thin layer of doc-content assertions
// keeps SKILL.md / the companion honest about the engine call, the judgment
// table, the release-please exclusion, the --dry-run precedence, and the
// merge policy gate. A cross-file sync assertion enforces that the bot-author
// pattern stays IDENTICAL to health-check.mjs 領域 15 (drift prevention).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AUTO_MERGE,
  bumpFromManifestDiff,
  bumpFromPairs,
  ciStatus,
  classifyBump,
  classifyPr,
  compareSemver,
  decide,
  detectPeerEngines,
  fetchAutomationPrs,
  fetchCiStatus,
  isBotAuthor,
  isDepsAutomationAuthor,
  isReleasePlease,
  lockfileState,
  maxBump,
  mergePr,
  NEEDS_REVIEW,
  parseArgs,
  parseChangedFiles,
  parseRepoSlug,
  render,
  run,
} from "../.agents/skills/deps/deps.mjs";
import { parseSkillDocument } from "../scripts/lib/frontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEPS_DIR = join(ROOT, ".agents", "skills", "deps");
const SKILL_MD = join(DEPS_DIR, "SKILL.md");
const SKILL_CLAUDE_MD = join(DEPS_DIR, "SKILL.claude-code.md");
const ENGINE = join(DEPS_DIR, "deps.mjs");
const HEALTH_ENGINE = join(ROOT, ".agents", "skills", "health", "health-check.mjs");

// ---------------------------------------------------------------------------
// gh / git test doubles
// ---------------------------------------------------------------------------

/**
 * A gh runner that answers `pr list` / `pr diff <N>` / `pr checks <N>` /
 * `pr merge <N>` from fixture maps keyed by PR number.
 */
function mockGh({
  prs = [],
  diffs = {},
  checks = {},
  mergeFail = new Set(),
  listUnauth = false,
} = {}) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === "pr" && b === "list") {
      if (listUnauth)
        return { status: 1, stdout: "", stderr: "gh auth login: not logged in", error: null };
      return { status: 0, stdout: JSON.stringify(prs), stderr: "", error: null };
    }
    if (a === "pr" && b === "diff") {
      const n = Number(args[2]);
      return { status: 0, stdout: diffs[n] ?? "", stderr: "", error: null };
    }
    if (a === "pr" && b === "checks") {
      const n = Number(args[2]);
      const c = checks[n];
      if (c === undefined)
        return { status: 0, stdout: "[]", stderr: "no checks reported on the branch", error: null };
      return {
        status: c.some((x) => x.bucket === "fail") ? 8 : 0,
        stdout: JSON.stringify(c),
        stderr: "",
        error: null,
      };
    }
    if (a === "pr" && b === "merge") {
      const n = Number(args[2]);
      if (mergeFail.has(n)) {
        return {
          status: 1,
          stdout: "",
          stderr: "Pull request is not mergeable: protected branch",
          error: null,
        };
      }
      return { status: 0, stdout: "✓ Merged", stderr: "", error: null };
    }
    return { status: 0, stdout: "", stderr: "", error: null };
  };
  fn.calls = calls;
  return fn;
}

function mockGit(remoteUrl = "git@github.com:ozzy-labs/skills.git") {
  return (args) => {
    if (args[0] === "remote" && args[1] === "get-url") {
      return remoteUrl === null
        ? { status: 1, stdout: "", stderr: "fatal: No such remote 'origin'", error: null }
        : { status: 0, stdout: `${remoteUrl}\n`, stderr: "", error: null };
    }
    return { status: 0, stdout: "", stderr: "", error: null };
  };
}

const bot = (login) => ({ login });
const pr = (number, extra = {}) => ({
  number,
  title: `Bump dep from 1.0.0 to 1.0.1`,
  author: bot("renovate[bot]"),
  headRefName: `renovate/dep-1.x`,
  ...extra,
});

// A clean patch diff: manifest + lockfile changed together, no peer/engines.
const cleanPatchDiff = [
  "diff --git a/package.json b/package.json",
  "--- a/package.json",
  "+++ b/package.json",
  '-    "foo": "1.0.0"',
  '+    "foo": "1.0.1"',
  "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
  "--- a/pnpm-lock.yaml",
  "+++ b/pnpm-lock.yaml",
  "-  foo@1.0.0",
  "+  foo@1.0.1",
].join("\n");

const GREEN = [{ name: "test", state: "SUCCESS", bucket: "pass" }];
const RED = [{ name: "test", state: "FAILURE", bucket: "fail" }];
const PENDING = [{ name: "test", state: "PENDING", bucket: "pending" }];

// ---------------------------------------------------------------------------
// 1. SKILL.md / companion structural validation
// ---------------------------------------------------------------------------

test("deps skill directory ships SKILL.md, companion, and the engine", () => {
  assert.ok(existsSync(DEPS_DIR), `expected ${DEPS_DIR} to exist`);
  assert.ok(existsSync(SKILL_MD), "SKILL.md must exist");
  assert.ok(existsSync(SKILL_CLAUDE_MD), "SKILL.claude-code.md must exist");
  assert.ok(existsSync(ENGINE), "deps.mjs engine must exist");
});

test("deps SKILL.md has valid frontmatter (name + description), all-adapter (no gate)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  const { frontmatter } = parseSkillDocument(raw, ".agents/skills/deps/SKILL.md");
  assert.equal(frontmatter.name, "deps", "frontmatter name must equal directory name");
  assert.ok(frontmatter.description?.length > 0, "frontmatter description must be non-empty");
  assert.equal(frontmatter.adapters, undefined, "deps is all-adapter (no `adapters` gate)");
});

test("deps SKILL.claude-code.md is a Claude-only overlay (no duplicated description / name)", async () => {
  const raw = await readFile(SKILL_CLAUDE_MD, "utf8");
  const { frontmatter } = parseSkillDocument(raw, ".agents/skills/deps/SKILL.claude-code.md");
  assert.ok(!frontmatter.description, "companion must not duplicate description");
  assert.equal(frontmatter.name, undefined, "companion must not redeclare 'name'");
  assert.equal(
    frontmatter["disable-model-invocation"],
    "true",
    "deps companion must carry its Claude-only frontmatter",
  );
});

test("deps is user-invocable (no user-invocable:false in either doc)", async () => {
  for (const f of [SKILL_MD, SKILL_CLAUDE_MD]) {
    const { frontmatter } = parseSkillDocument(await readFile(f, "utf8"), f);
    assert.notEqual(
      frontmatter["user-invocable"],
      "false",
      "deps must remain user-invocable (surfaced as /deps)",
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Doc-content assertions: engine call, judgment table, release-please,
//    dry-run precedence, merge policy gate
// ---------------------------------------------------------------------------

test("SKILL.md points at the deps.mjs engine (ADR-0028 R1)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /deps\.mjs/, "must instruct running the deps.mjs engine");
  assert.match(raw, /node <[^>]*>\/deps\.mjs/, "must show the node deps.mjs invocation");
});

test("SKILL.md hardcodes the fixed judgment table (patch/minor->merge, major/red/pending/peer/engines->要確認)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /Judgment table/i, "must have a judgment-table section");
  assert.match(raw, /patch/, "table names patch");
  assert.match(raw, /minor/, "table names minor");
  assert.match(raw, /major/, "table names major");
  assert.match(raw, /auto-merge/, "auto-merge outcome documented");
  assert.match(raw, /要確認/, "要確認 outcome documented");
  assert.match(raw, /pending/, "pending -> 要確認 documented");
  assert.match(raw, /peer/, "peer dependency change documented");
  assert.match(raw, /engines/, "engines change documented");
  assert.match(raw, /lockfile/i, "lockfile integrity documented");
  assert.match(raw, /max(?:imum)? bump/i, "grouped = max bump documented");
});

test("SKILL.md documents the release-please exclusion (/release's responsibility)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /release-please/, "must name release-please");
  assert.match(raw, /excluded|exclusion/i, "must state it is excluded");
  assert.match(raw, /\/release/, "must attribute release PRs to /release");
});

test("SKILL.md documents the --dry-run precedence over --auto (misapplication prevention)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /--dry-run/, "must document --dry-run");
  assert.match(raw, /--auto/, "must document --auto");
  assert.match(
    raw,
    /--dry-run.*(?:takes priority|wins|priority)|priority.*--dry-run/i,
    "must state --dry-run wins",
  );
});

test("SKILL.md classes merge as irreversible and references the policy substrate (R3), --auto = override", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /irreversible/, "merge must be classed as irreversible");
  assert.match(raw, /policy-read\.mjs/, "must point at the policy read substrate");
  assert.match(raw, /--action=merge/, "must name the policy action for the merge");
  assert.match(
    raw,
    /--auto.*opt-out|opt-out.*--auto|--auto.*上書き|上書き.*--auto/,
    "--auto must be the policy override",
  );
});

test("SKILL.md documents author detection identical to health 領域 15 (with sync-assertion note)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /health/, "must reference the health skill");
  assert.match(raw, /領域 15|isBotAuthor/, "must name health 領域 15 / isBotAuthor");
  assert.match(raw, /\[bot\]/, "must document the *[bot] login pattern");
  assert.match(raw, /app\//, "must document the app/* pattern");
  assert.match(raw, /sync assertion|drift/i, "must reference the drift-preventing sync assertion");
});

test("companion wires AskUserQuestion merge confirm + skips it under --auto", async () => {
  const raw = await readFile(SKILL_CLAUDE_MD, "utf8");
  assert.match(raw, /deps\.mjs/, "companion must call the engine, not re-encode rules");
  assert.match(
    raw,
    /AskUserQuestion/,
    "companion must keep the AskUserQuestion merge-confirm flow",
  );
  assert.match(
    raw,
    /policy-read\.mjs/,
    "companion must resolve the merge gate via the policy substrate",
  );
  assert.match(raw, /--action=merge/, "companion must name the merge policy action");
  assert.match(
    raw,
    /--auto.*AskUserQuestion.*not inserted|AskUserQuestion is not inserted|--auto.*(?:skip|not inserted)/i,
    "companion must skip AskUserQuestion under --auto",
  );
});

// ---------------------------------------------------------------------------
// 3. Cross-file sync assertion: bot-author pattern == health 領域 15
// ---------------------------------------------------------------------------

test("author detection MIRRORS health-check.mjs 領域 15 (behavioral)", () => {
  // Bots the two skills must agree on.
  assert.equal(isBotAuthor(bot("renovate[bot]")), true);
  assert.equal(isBotAuthor(bot("dependabot[bot]")), true);
  assert.equal(isBotAuthor(bot("app/my-app")), true);
  assert.equal(isBotAuthor({ login: "someone", is_bot: true }), true);
  // Humans.
  assert.equal(isBotAuthor(bot("ozzy-3")), false);
  assert.equal(isBotAuthor(null), false);
});

test("bot-author pattern tokens are IDENTICAL in deps.mjs and health-check.mjs (drift guard)", () => {
  const healthSrc = readFileSync(HEALTH_ENGINE, "utf8");
  const depsSrc = readFileSync(ENGINE, "utf8");
  // If EITHER skill changes its bot-author pattern, one of these fails, forcing
  // a conscious re-sync (issue #176: author 判定が health と一致).
  for (const token of ["is_bot === true", String.raw`/\[bot\]$/`, 'startsWith("app/")']) {
    assert.ok(healthSrc.includes(token), `health-check.mjs 領域 15 must contain \`${token}\``);
    assert.ok(depsSrc.includes(token), `deps.mjs must contain the identical token \`${token}\``);
  }
});

test("release-please is a bot but is EXCLUDED from deps triage", () => {
  assert.equal(
    isBotAuthor(bot("release-please[bot]")),
    true,
    "release-please is a bot per the shared pattern",
  );
  assert.equal(isReleasePlease(bot("release-please[bot]")), true);
  assert.equal(
    isDepsAutomationAuthor(bot("release-please[bot]")),
    false,
    "but deps must exclude it",
  );
  assert.equal(isDepsAutomationAuthor(bot("renovate[bot]")), true, "renovate is still included");
});

// ---------------------------------------------------------------------------
// 4. Engine: arg parsing (dry-run precedence handled in run())
// ---------------------------------------------------------------------------

test("parseArgs: defaults, --limit, --repo, --dry-run, --auto, --json", () => {
  assert.deepEqual(parseArgs([]), { limit: 50, "dry-run": false, auto: false, json: false });
  const a = parseArgs(["--repo", "o/r", "--limit", "10", "--dry-run", "--json"]);
  assert.equal(a.repo, "o/r");
  assert.equal(a.limit, 10);
  assert.equal(a["dry-run"], true);
  assert.equal(a.json, true);
  const b = parseArgs(["--auto", "--limit=5"]);
  assert.equal(b.auto, true);
  assert.equal(b.limit, 5);
});

test("parseRepoSlug: ssh / https / trailing .git", () => {
  assert.equal(parseRepoSlug("git@github.com:ozzy-labs/skills.git"), "ozzy-labs/skills");
  assert.equal(parseRepoSlug("https://github.com/ozzy-labs/skills"), "ozzy-labs/skills");
  assert.equal(parseRepoSlug("https://example.com/x/y"), null);
});

// ---------------------------------------------------------------------------
// 5. Engine: semver classification (grouped = MAX bump — pure fixture data)
// ---------------------------------------------------------------------------

test("compareSemver: patch / minor / major from version pairs", () => {
  assert.equal(compareSemver("1.2.3", "1.2.4"), "patch");
  assert.equal(compareSemver("1.2.3", "1.3.0"), "minor");
  assert.equal(compareSemver("1.2.3", "2.0.0"), "major");
  assert.equal(compareSemver("v1", "v2"), "major");
  assert.equal(compareSemver("1.2", "1.3"), "minor");
  assert.equal(compareSemver("not-a-version", "1.0.0"), null);
});

test("maxBump: fixed vocabulary — a list of bumps reduces to its MAX", () => {
  // Pure data: the list of bumps included in a grouped PR -> expected class.
  const reduceBumps = (list) => list.reduce((acc, b) => maxBump(acc, b), null);
  assert.equal(reduceBumps(["patch", "patch"]), "patch");
  assert.equal(reduceBumps(["patch", "minor", "patch"]), "minor");
  assert.equal(reduceBumps(["patch", "minor", "major"]), "major", "one major dominates the group");
  assert.equal(reduceBumps([]), null);
  assert.equal(maxBump("patch", null), "patch", "a known bump beats null");
});

test("bumpFromPairs: extracts from/to pairs from a title (dependabot style)", () => {
  assert.equal(bumpFromPairs("Bump foo from 1.2.3 to 1.2.4"), "patch");
  assert.equal(bumpFromPairs("Bump foo from 1.2.3 to 2.0.0"), "major");
  assert.equal(
    bumpFromPairs("chore: update dependency foo to v3"),
    null,
    "no from-version -> no pair",
  );
});

test("bumpFromManifestDiff: grouped PR -> MAX bump across paired dep lines", () => {
  const diff = [
    "diff --git a/package.json b/package.json",
    '-    "a": "1.0.0"',
    '+    "a": "1.0.1"', // patch
    '-    "b": "2.1.0"',
    '+    "b": "2.3.0"', // minor
    '-    "c": "3.0.0"',
    '+    "c": "4.0.0"', // major -> dominates
  ].join("\n");
  assert.equal(bumpFromManifestDiff(diff), "major");
});

test("classifyBump: title pair, manifest diff, branch major hint, non-major, unknown", () => {
  assert.equal(classifyBump({ title: "Bump foo from 1.0.0 to 1.0.1" }), "patch");
  assert.equal(classifyBump({ branch: "renovate/major-foo", title: "update foo" }), "major");
  assert.equal(classifyBump({ title: "Update all non-major dependencies" }), "minor");
  assert.equal(
    classifyBump({ title: "chore(deps): update dependency foo to v3" }),
    "unknown",
    "no resolvable signal -> unknown (conservative)",
  );
  // Grouped: generic title but the diff carries a major.
  assert.equal(
    classifyBump({
      title: "chore(deps): update all dependencies",
      diff: '-    "x": "1.0.0"\n+    "x": "2.0.0"',
    }),
    "major",
  );
});

// ---------------------------------------------------------------------------
// 6. Engine: CI / lockfile / peer-engines signals
// ---------------------------------------------------------------------------

test("ciStatus: green / red / pending / no-checks", () => {
  assert.equal(ciStatus(GREEN), "green");
  assert.equal(ciStatus(RED), "red");
  assert.equal(ciStatus(PENDING), "pending");
  assert.equal(ciStatus([{ bucket: "pass" }, { bucket: "skipping" }]), "green");
  assert.equal(ciStatus([{ bucket: "pass" }, { bucket: "fail" }]), "red", "any fail -> red");
  assert.equal(ciStatus([{ bucket: "pass" }, { bucket: "pending" }]), "pending");
  assert.equal(ciStatus([]), "no-checks");
});

test("fetchCiStatus: empty set with 'no checks' note -> no-checks; auth failure -> error", () => {
  const noChecks = fetchCiStatus(mockGh({}), 1, null);
  assert.equal(noChecks.status, "no-checks");
  const ghAuth = (args) =>
    args[1] === "checks"
      ? { status: 1, stdout: "", stderr: "gh auth login: not logged in", error: null }
      : { status: 0, stdout: "", stderr: "", error: null };
  const err = fetchCiStatus(ghAuth, 1, null);
  assert.equal(err.status, "error");
  assert.equal(err.error, "gh not authenticated");
});

test("parseChangedFiles + lockfileState: manifest-without-lock is drift; lock-only is fine", () => {
  assert.deepEqual(parseChangedFiles(cleanPatchDiff), ["package.json", "pnpm-lock.yaml"]);
  assert.equal(lockfileState(["package.json", "pnpm-lock.yaml"]), "consistent");
  assert.equal(
    lockfileState(["package.json"]),
    "manifest-without-lock",
    "manifest bumped, lock not regenerated",
  );
  assert.equal(
    lockfileState(["pnpm-lock.yaml"]),
    "consistent",
    "lockfile-only (maintenance/transitive) is fine",
  );
  assert.equal(
    lockfileState([".github/workflows/ci.yaml"]),
    "consistent",
    "no manifest/lock touched -> N/A",
  );
});

test("detectPeerEngines: flags peerDependencies / engines changes in a diff", () => {
  const peerDiff =
    'diff --git a/package.json b/package.json\n-  "peerDependencies": {\n+  "peerDependencies": {';
  assert.deepEqual(detectPeerEngines(peerDiff), { peer: true, engines: false });
  const enginesDiff = '+    "engines": { "node": ">=22" }';
  assert.deepEqual(detectPeerEngines(enginesDiff), { peer: false, engines: true });
  assert.deepEqual(detectPeerEngines(cleanPatchDiff), { peer: false, engines: false });
});

// ---------------------------------------------------------------------------
// 7. Engine: the fixed judgment table (decide)
// ---------------------------------------------------------------------------

test("decide: patch/minor + green + consistent + no peer/engines -> auto-merge", () => {
  assert.equal(
    decide({ bump: "patch", ci: "green", lockfile: "consistent", peer: false, engines: false })
      .decision,
    AUTO_MERGE,
  );
  assert.equal(
    decide({ bump: "minor", ci: "green", lockfile: "consistent", peer: false, engines: false })
      .decision,
    AUTO_MERGE,
  );
});

test("decide: major / CI red / pending / no-checks / unknown / drift / peer / engines -> 要確認 with reasons", () => {
  const cases = [
    [
      { bump: "major", ci: "green", lockfile: "consistent", peer: false, engines: false },
      "major bump",
    ],
    [{ bump: "patch", ci: "red", lockfile: "consistent", peer: false, engines: false }, "CI red"],
    [
      { bump: "patch", ci: "pending", lockfile: "consistent", peer: false, engines: false },
      "CI pending",
    ],
    [
      { bump: "patch", ci: "no-checks", lockfile: "consistent", peer: false, engines: false },
      "no CI checks",
    ],
    [
      { bump: "unknown", ci: "green", lockfile: "consistent", peer: false, engines: false },
      "unknown bump",
    ],
    [
      {
        bump: "patch",
        ci: "green",
        lockfile: "manifest-without-lock",
        peer: false,
        engines: false,
      },
      "lockfile drift",
    ],
    [
      { bump: "patch", ci: "green", lockfile: "consistent", peer: true, engines: false },
      "peer dependency change",
    ],
    [
      { bump: "patch", ci: "green", lockfile: "consistent", peer: false, engines: true },
      "engines change",
    ],
  ];
  for (const [signals, needle] of cases) {
    const r = decide(signals);
    assert.equal(r.decision, NEEDS_REVIEW, `${JSON.stringify(signals)} -> 要確認`);
    assert.ok(
      r.reasons.some((x) => x.includes(needle)),
      `reasons should mention "${needle}": ${r.reasons.join("; ")}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 8. Engine: classifyPr + run() modes with injected gh + git
// ---------------------------------------------------------------------------

test("classifyPr: a clean patch PR (green, lockfile consistent) -> auto-merge", () => {
  const gh = mockGh({ diffs: { 1: cleanPatchDiff }, checks: { 1: GREEN } });
  const c = classifyPr(gh, pr(1), "o/r");
  assert.equal(c.bump, "patch");
  assert.equal(c.ci, "green");
  assert.equal(c.lockfile, "consistent");
  assert.equal(c.decision, AUTO_MERGE);
});

test("fetchAutomationPrs: keeps bots, drops release-please and humans", () => {
  const gh = mockGh({
    prs: [
      pr(1, { author: bot("renovate[bot]") }),
      pr(2, { author: bot("release-please[bot]") }),
      pr(3, { author: bot("alice") }),
    ],
  });
  const { prs, error } = fetchAutomationPrs(gh, { repo: "o/r" });
  assert.equal(error, null);
  assert.deepEqual(
    prs.map((p) => p.number),
    [1],
    "only renovate survives (release-please + human excluded)",
  );
});

test("run: plan mode classifies, returns a merge_plan, and merges NOTHING", () => {
  const gh = mockGh({
    prs: [
      pr(1, {
        author: bot("renovate[bot]"),
        title: "Bump a from 1.0.0 to 1.0.1",
        headRefName: "renovate/a",
      }),
      pr(2, {
        author: bot("dependabot[bot]"),
        title: "Bump b from 1.0.0 to 2.0.0",
        headRefName: "dependabot/b",
      }),
      pr(3, { author: bot("release-please[bot]"), title: "chore: release main" }),
    ],
    diffs: {
      1: cleanPatchDiff,
      2: 'diff --git a/package.json b/package.json\n-    "b": "1.0.0"\n+    "b": "2.0.0"',
    },
    checks: { 1: GREEN, 2: GREEN },
  });
  const r = run([], { ghRun: gh, gitRun: mockGit() });
  assert.equal(r.mode, "plan");
  assert.equal(r.repo, "ozzy-labs/skills");
  assert.deepEqual(
    r.candidates.map((c) => c.ref),
    ["#1", "#2"],
    "release-please excluded from candidates",
  );
  assert.deepEqual(r.auto_merge, ["#1"]);
  assert.deepEqual(r.needs_review, ["#2"]);
  assert.equal(r.merge_plan.length, 1);
  assert.match(r.merge_plan[0].command, /gh pr merge 1 --squash/);
  assert.equal(r.merge_results, undefined, "plan mode must not execute merges");
  assert.equal(
    gh.calls.some((a) => a[0] === "pr" && a[1] === "merge"),
    false,
    "no gh pr merge call",
  );
  assert.equal(r.policy.action, "merge");
  assert.equal(r.policy.class, "irreversible");
});

test("run: --dry-run classifies but never merges, and WINS over --auto", () => {
  const gh = mockGh({ prs: [pr(1)], diffs: { 1: cleanPatchDiff }, checks: { 1: GREEN } });
  const r = run(["--dry-run", "--auto"], { ghRun: gh, gitRun: mockGit() });
  assert.equal(r.mode, "dry-run", "--dry-run wins over --auto");
  assert.deepEqual(r.auto_merge, ["#1"]);
  assert.equal(
    gh.calls.some((a) => a[1] === "merge"),
    false,
    "dry-run must not merge",
  );
  assert.ok(
    r.warnings.some((w) => /--dry-run/.test(w) && /--auto/.test(w)),
    "must warn about the override",
  );
});

test("run: --auto merges every auto-merge candidate (policy override), serial", () => {
  const gh = mockGh({
    prs: [
      pr(1, { title: "Bump a from 1.0.0 to 1.0.1", headRefName: "renovate/a" }),
      pr(2, { title: "Bump b from 1.0.0 to 2.0.0", headRefName: "renovate/b" }), // major -> not merged
    ],
    diffs: {
      1: cleanPatchDiff,
      2: 'diff --git a/package.json b/package.json\n-    "b": "1.0.0"\n+    "b": "2.0.0"',
    },
    checks: { 1: GREEN, 2: GREEN },
  });
  const r = run(["--auto"], { ghRun: gh, gitRun: mockGit() });
  assert.equal(r.mode, "auto");
  assert.deepEqual(r.merge_results, [{ ref: "#1", ok: true, error: null }]);
  const mergeCalls = gh.calls.filter((a) => a[0] === "pr" && a[1] === "merge");
  assert.equal(mergeCalls.length, 1, "only the auto-merge candidate is merged");
  assert.deepEqual(mergeCalls[0].slice(0, 4), ["pr", "merge", "1", "--squash"]);
});

test("run: --auto merge failure downgrades that PR to 要確認 and continues", () => {
  const gh = mockGh({
    prs: [
      pr(1, { title: "Bump a from 1.0.0 to 1.0.1", headRefName: "renovate/a" }),
      pr(2, { title: "Bump b from 1.0.0 to 1.1.0", headRefName: "renovate/b" }),
    ],
    diffs: { 1: cleanPatchDiff, 2: cleanPatchDiff },
    checks: { 1: GREEN, 2: GREEN },
    mergeFail: new Set([1]), // branch protection on #1
  });
  const r = run(["--auto"], { ghRun: gh, gitRun: mockGit() });
  assert.equal(r.merge_results.find((m) => m.ref === "#1").ok, false);
  assert.ok(r.needs_review.includes("#1"), "#1 downgraded to 要確認 after merge failure");
  assert.ok(r.auto_merge.includes("#2"), "#2 still merged");
  const failed = r.candidates.find((c) => c.ref === "#1");
  assert.ok(
    failed.reasons.some((x) => /merge failed/.test(x)),
    "downgrade records the reason",
  );
});

test("run: gh pr list failure surfaces fetch_error, empty candidates", () => {
  const r = run([], { ghRun: mockGh({ listUnauth: true }), gitRun: mockGit() });
  assert.equal(r.fetch_error, "gh not authenticated");
  assert.deepEqual(r.candidates, []);
});

test("run: no GitHub remote and no --repo -> repo_error set", () => {
  const r = run([], { ghRun: mockGh({ prs: [] }), gitRun: mockGit(null) });
  assert.equal(r.repo, null);
  assert.equal(r.repo_error, "no GitHub remote");
});

test("mergePr: classifies branch-protection failure distinctly", () => {
  const ok = mergePr(mockGh({}), 1, "o/r");
  assert.deepEqual(ok, { ok: true, error: null });
  const blocked = mergePr(mockGh({ mergeFail: new Set([1]) }), 1, "o/r");
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /branch protection|not mergeable/);
});

// ---------------------------------------------------------------------------
// 9. Engine: render smoke
// ---------------------------------------------------------------------------

test("render: human report includes the triage, buckets, and merge plan", () => {
  const gh = mockGh({
    prs: [pr(1, { title: "Bump a from 1.0.0 to 1.0.1", headRefName: "renovate/a" })],
    diffs: { 1: cleanPatchDiff },
    checks: { 1: GREEN },
  });
  const text = render(run([], { ghRun: gh, gitRun: mockGit() }));
  assert.match(text, /Triage:/);
  assert.match(text, /auto-merge candidates:/);
  assert.match(text, /要確認:/);
  assert.match(text, /Merge plan/);
  assert.match(text, /gh pr merge 1 --squash/);
});

test("render: --dry-run report states classification-only", () => {
  const gh = mockGh({ prs: [pr(1)], diffs: { 1: cleanPatchDiff }, checks: { 1: GREEN } });
  const text = render(run(["--dry-run"], { ghRun: gh, gitRun: mockGit() }));
  assert.match(text, /--dry-run: classification only/);
});
