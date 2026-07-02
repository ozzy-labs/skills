// Tests for the backlog skill (issue #175) — engine-based per ADR-0028 R1.
//
// The determinism lives in `.agents/skills/backlog/backlog.mjs`, so these tests
// drive the ENGINE directly: fixture issue metadata (pure data) -> backlog.mjs
// output (collection / dependency reuse / fixed-vocabulary priority sort /
// auto-ok gating / drive-arg emission), with `gh` and `git` dependency-injected.
// A thin layer of doc-content assertions keeps SKILL.md / the companion honest
// about the engine call, the drive dependency-notation REUSE (no re-encoding),
// and the policy gate.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildDeps,
  depClosure,
  emitDriveArgs,
  fetchIssues,
  hasAutoOk,
  isHighPriority,
  normalizeIssue,
  parseArgs,
  parseRepoSlug,
  prioritize,
  render,
  run,
  selectAutoOk,
} from "../.agents/skills/backlog/backlog.mjs";
import { parseSkillDocument } from "../scripts/lib/frontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BACKLOG_DIR = join(ROOT, ".agents", "skills", "backlog");
const SKILL_MD = join(BACKLOG_DIR, "SKILL.md");
const SKILL_CLAUDE_MD = join(BACKLOG_DIR, "SKILL.claude-code.md");
const ENGINE = join(BACKLOG_DIR, "backlog.mjs");

// ---------------------------------------------------------------------------
// gh / git test doubles
// ---------------------------------------------------------------------------

/** A gh runner that answers `gh issue list` from a fixture array. */
function mockGh({ issues = [], unauth = false } = {}) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      if (unauth) {
        return { status: 1, stdout: "", stderr: "gh auth login: not logged in", error: null };
      }
      return { status: 0, stdout: JSON.stringify(issues), stderr: "", error: null };
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

const iss = (number, extra = {}) => ({
  number,
  title: `issue ${number}`,
  labels: [],
  updatedAt: "2026-06-01T00:00:00Z",
  milestone: null,
  body: "",
  ...extra,
});

// ---------------------------------------------------------------------------
// 1. SKILL.md / companion structural validation
// ---------------------------------------------------------------------------

test("backlog skill directory ships SKILL.md, companion, and the engine", () => {
  assert.ok(existsSync(BACKLOG_DIR), `expected ${BACKLOG_DIR} to exist`);
  assert.ok(existsSync(SKILL_MD), "SKILL.md must exist");
  assert.ok(existsSync(SKILL_CLAUDE_MD), "SKILL.claude-code.md must exist");
  assert.ok(existsSync(ENGINE), "backlog.mjs engine must exist");
});

test("backlog SKILL.md has valid frontmatter (name + description), all-adapter (no gate)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  const { frontmatter } = parseSkillDocument(raw, ".agents/skills/backlog/SKILL.md");
  assert.equal(frontmatter.name, "backlog", "frontmatter name must equal directory name");
  assert.ok(frontmatter.description?.length > 0, "frontmatter description must be non-empty");
  assert.equal(frontmatter.adapters, undefined, "backlog is all-adapter (no `adapters` gate)");
});

test("backlog SKILL.claude-code.md is a Claude-only overlay (no duplicated description / name)", async () => {
  const raw = await readFile(SKILL_CLAUDE_MD, "utf8");
  const { frontmatter } = parseSkillDocument(raw, ".agents/skills/backlog/SKILL.claude-code.md");
  assert.ok(!frontmatter.description, "companion must not duplicate description");
  assert.equal(frontmatter.name, undefined, "companion must not redeclare 'name'");
  assert.equal(
    frontmatter["disable-model-invocation"],
    "true",
    "backlog companion must carry its Claude-only frontmatter",
  );
});

test("backlog is user-invocable (no user-invocable:false in either doc)", async () => {
  for (const f of [SKILL_MD, SKILL_CLAUDE_MD]) {
    const { frontmatter } = parseSkillDocument(await readFile(f, "utf8"), f);
    assert.notEqual(
      frontmatter["user-invocable"],
      "false",
      "backlog must remain user-invocable (surfaced as /backlog)",
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Doc-content assertions: engine call, drive-notation reuse, policy gate
// ---------------------------------------------------------------------------

test("SKILL.md points at the backlog.mjs engine (ADR-0028 R1)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /backlog\.mjs/, "must instruct running the backlog.mjs engine");
  assert.match(raw, /node <[^>]*>\/backlog\.mjs/, "must show the node backlog.mjs invocation");
});

test("SKILL.md references drive as the dependency-notation SSOT and does NOT re-document the grammar", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  // Positive: names the drive engine SSOT + reuse.
  assert.match(raw, /drive-plan\.mjs/, "must reference drive-plan.mjs as the dependency SSOT");
  assert.match(raw, /detectBodyDeps/, "must name the reused detectBodyDeps function");
  assert.match(
    raw,
    /再掲しない|再掲せず|重複記述しない/,
    "must state the rule is not re-documented (drift prevention)",
  );
  // Negative: does NOT re-encode the drive regex alternation as its own rule.
  assert.doesNotMatch(
    raw,
    /depends on\|blocked by/,
    "SKILL.md must NOT re-encode the drive dependency regex alternation",
  );
});

test("engine REUSES the drive dependency rule + wave split (imports, does not re-encode)", () => {
  const src = readFileSync(ENGINE, "utf8");
  assert.match(
    src,
    /import\s*\{[^}]*detectBodyDeps[^}]*\}\s*from\s*["']\.\.\/drive\/drive-plan\.mjs["']/,
    "backlog.mjs must import detectBodyDeps from ../drive/drive-plan.mjs",
  );
  assert.match(src, /topoWaves/, "backlog.mjs must reuse drive's topoWaves for wave split");
  assert.doesNotMatch(
    src,
    /depends on\|blocked by/,
    "backlog.mjs must NOT re-encode the drive dependency regex (drift risk)",
  );
});

test("SKILL.md documents --auto with auto-ok label gating (no ungated --auto)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /--auto/, "must document the --auto flag");
  assert.match(raw, /auto-ok/, "must document the auto-ok label gate");
  assert.match(raw, /HATL/, "must frame the gate as HATL (human sets the boundary via labels)");
  assert.match(
    raw,
    /ゲーティングなしの `--auto` は存在しない|ゲーティングなし.*--auto/,
    "must explicitly forbid an ungated --auto",
  );
});

test("SKILL.md classes drive launch as externally-visible and references the policy substrate (R3)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /externally-visible/, "drive launch must be classed as externally-visible");
  assert.match(raw, /batch-confirm/, "zero-config gate must be batch-confirm");
  assert.match(raw, /policy-read\.mjs/, "must point at the policy read substrate");
  assert.match(raw, /drive-launch/, "must name the policy action for the drive launch");
});

test("SKILL.md hardcodes the fixed priority vocabulary table", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /優先度規則/, "must have a priority-rule section");
  assert.match(raw, /blocker/, "rule (a): blocker");
  assert.match(raw, /milestone/, "rule (b): milestone due");
  assert.match(raw, /priority:high/, "rule (c): priority:high label");
  assert.match(raw, /updatedAt/, "rule (d): updatedAt oldest");
  assert.match(raw, /tie-break|番号 昇順|番号昇順/, "must define a deterministic tie-break");
});

test("SKILL.md declares single-repo scope (cross-repo out of scope)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /単一リポ/, "must declare single-repo scope");
  assert.match(raw, /cross-repo/i, "must enumerate cross-repo as out of scope");
});

test("companion wires AskUserQuestion selection + /drive launch + routine examples", async () => {
  const raw = await readFile(SKILL_CLAUDE_MD, "utf8");
  assert.match(raw, /backlog\.mjs/, "companion must call the engine, not re-encode rules");
  assert.match(raw, /AskUserQuestion/, "companion must keep the AskUserQuestion selection flow");
  assert.match(raw, /\/drive/, "companion must wire the /drive launch");
  assert.match(raw, /auto-ok/, "companion must keep the auto-ok gate");
  assert.match(raw, /--auto --limit/, "companion must show the schedule / loop routine example");
});

// ---------------------------------------------------------------------------
// 3. Engine: arg parsing
// ---------------------------------------------------------------------------

test("parseArgs: defaults, --limit, --label, --repo, --drive=N, --auto, --json", () => {
  assert.deepEqual(parseArgs([]), {
    limit: 20,
    drive: false,
    driveN: null,
    auto: false,
    json: false,
  });
  const a = parseArgs(["--repo", "o/r", "--label", "bug", "--limit", "5", "--drive=3", "--json"]);
  assert.equal(a.repo, "o/r");
  assert.equal(a.label, "bug");
  assert.equal(a.limit, 5);
  assert.equal(a.drive, true);
  assert.equal(a.driveN, 3);
  assert.equal(a.json, true);
});

test("parseArgs: bare --drive (no N) and --auto", () => {
  const a = parseArgs(["--drive"]);
  assert.equal(a.drive, true);
  assert.equal(a.driveN, null);
  const b = parseArgs(["--auto", "--limit=3"]);
  assert.equal(b.auto, true);
  assert.equal(b.limit, 3);
});

// ---------------------------------------------------------------------------
// 3. Engine: repo resolution + collection
// ---------------------------------------------------------------------------

test("parseRepoSlug: ssh / https / trailing .git", () => {
  assert.equal(parseRepoSlug("git@github.com:ozzy-labs/skills.git"), "ozzy-labs/skills");
  assert.equal(parseRepoSlug("https://github.com/ozzy-labs/skills"), "ozzy-labs/skills");
  assert.equal(parseRepoSlug("https://example.com/x/y"), null);
});

test("fetchIssues: parses gh JSON; classifies auth failure", () => {
  const gh = mockGh({ issues: [iss(1), iss(2)] });
  const ok = fetchIssues(gh, { repo: "o/r", limit: 20 });
  assert.equal(ok.error, null);
  assert.equal(ok.issues.length, 2);
  const call = gh.calls.find((a) => a[0] === "issue" && a[1] === "list");
  assert.ok(call.includes("--state") && call.includes("open"), "must filter open issues");
  assert.ok(call.includes("--repo") && call.includes("o/r"), "must pass --repo");

  const unauth = fetchIssues(mockGh({ unauth: true }), {});
  assert.equal(unauth.issues, null);
  assert.equal(unauth.error, "gh not authenticated");
});

test("normalizeIssue: labels -> names, milestone -> title/dueOn", () => {
  const n = normalizeIssue({
    number: 7,
    title: "t",
    labels: [{ name: "bug" }, { name: "priority:high" }],
    updatedAt: "2026-06-01T00:00:00Z",
    milestone: { title: "M1", dueOn: "2026-08-01T00:00:00Z" },
    body: "hello",
  });
  assert.equal(n.ref, "#7");
  assert.deepEqual(n.labels, ["bug", "priority:high"]);
  assert.equal(n.milestone, "M1");
  assert.equal(n.milestone_due_on, "2026-08-01T00:00:00Z");
});

// ---------------------------------------------------------------------------
// 3. Engine: dependency reuse (drive rule) + blockers
// ---------------------------------------------------------------------------

test("buildDeps reuses the drive rule: detects deps within the collected set and marks blockers", () => {
  const issues = [
    normalizeIssue(iss(10, { body: "" })),
    normalizeIssue(iss(20, { body: "This depends on #10 and blocked by #99 (uncollected)" })),
  ];
  const { deps, blockers } = buildDeps(issues);
  assert.deepEqual(deps["#20"], ["#10"], "#99 is uncollected → dropped (drive semantics)");
  assert.deepEqual(deps["#10"], []);
  assert.ok(blockers.has("#10"), "#10 is depended-upon → blocker");
  assert.ok(!blockers.has("#20"));
});

test("isHighPriority / hasAutoOk match the fixed label vocabulary (case-insensitive)", () => {
  assert.equal(
    isHighPriority(normalizeIssue(iss(1, { labels: [{ name: "Priority:High" }] }))),
    true,
  );
  assert.equal(isHighPriority(normalizeIssue(iss(1, { labels: [{ name: "P1" }] }))), true);
  assert.equal(isHighPriority(normalizeIssue(iss(1, { labels: [{ name: "bug" }] }))), false);
  assert.equal(hasAutoOk(normalizeIssue(iss(1, { labels: [{ name: "auto-ok" }] }))), true);
  assert.equal(hasAutoOk(normalizeIssue(iss(1, { labels: [{ name: "AUTO-OK" }] }))), true);
  assert.equal(hasAutoOk(normalizeIssue(iss(1, { labels: [] }))), false);
});

// ---------------------------------------------------------------------------
// 3. Engine: FIXED priority sort — pure fixture data -> expected order
// ---------------------------------------------------------------------------

test("prioritize: fixed vocabulary (a)blocker (b)milestone (c)priority:high (d)updatedAt -> deterministic order", () => {
  // Two blockers (#10, #11) and four non-blockers (#20,#21,#22,#23).
  const raw = [
    iss(10, { milestone: { title: "M", dueOn: "2026-09-01T00:00:00Z" } }), // blocker, due Sep
    iss(11, { milestone: { title: "M", dueOn: "2026-08-01T00:00:00Z" } }), // blocker, due Aug (earlier)
    iss(20, { milestone: { title: "M", dueOn: "2026-07-01T00:00:00Z" }, body: "depends on #10" }),
    iss(21, { labels: [{ name: "priority:high" }], body: "blocked by #11" }),
    iss(22, { updatedAt: "2026-01-01T00:00:00Z" }), // oldest
    iss(23, { updatedAt: "2026-06-01T00:00:00Z" }),
  ];
  const issues = raw.map(normalizeIssue);
  const { blockers } = buildDeps(issues);
  const order = prioritize(issues, blockers).map((i) => i.ref);
  // (a) blockers first: #11 (Aug) before #10 (Sep) by (b).
  // then non-blockers: #20 (has milestone Jul) < #21 (high, no milestone)
  // < #22 (oldest updatedAt) < #23.
  assert.deepEqual(order, ["#11", "#10", "#20", "#21", "#22", "#23"]);
});

test("prioritize is a pure sort (does not mutate input order)", () => {
  const issues = [iss(3), iss(1), iss(2)].map(normalizeIssue);
  const before = issues.map((i) => i.ref);
  prioritize(issues, new Set());
  assert.deepEqual(
    issues.map((i) => i.ref),
    before,
    "input array order must be preserved",
  );
});

// ---------------------------------------------------------------------------
// 3. Engine: drive-arg emission (wave split reused from drive)
// ---------------------------------------------------------------------------

test("emitDriveArgs: no deps -> flat comma list", () => {
  const { drive_args, cycle } = emitDriveArgs(["#1", "#2", "#3"], { "#1": [], "#2": [], "#3": [] });
  assert.equal(drive_args, "#1,#2,#3");
  assert.equal(cycle, null);
});

test("emitDriveArgs: deps -> wave `->` notation (drive-ready)", () => {
  const { drive_args, waves } = emitDriveArgs(["#11", "#10", "#20", "#21"], {
    "#20": ["#10"],
    "#21": ["#11"],
    "#10": [],
    "#11": [],
  });
  assert.equal(waves.length, 2);
  assert.equal(drive_args, "#11,#10 -> #20,#21");
});

test("emitDriveArgs: cycle falls back to a flat list + reports the cycle", () => {
  const { drive_args, cycle } = emitDriveArgs(["#1", "#2"], { "#1": ["#2"], "#2": ["#1"] });
  assert.equal(drive_args, "#1,#2");
  assert.deepEqual(cycle.sort(), ["#1", "#2"]);
});

test("depClosure: expands a seed to its transitive dependency closure", () => {
  const deps = { "#1": ["#2"], "#2": ["#3"], "#3": [], "#4": [] };
  assert.deepEqual([...depClosure(["#1"], deps)].sort(), ["#1", "#2", "#3"]);
});

// ---------------------------------------------------------------------------
// 3. Engine: auto-ok gating (HATL) — the security-critical path
// ---------------------------------------------------------------------------

test("selectAutoOk: only auto-ok issues, cascading exclusion of unapproved deps", () => {
  const ordered = ["#1", "#2", "#3", "#4"];
  const deps = { "#1": [], "#2": ["#3"], "#3": [], "#4": [] };
  const autoOk = new Set(["#1", "#2"]); // #3/#4 not approved
  const r = selectAutoOk(ordered, deps, autoOk);
  assert.deepEqual(r.selected, ["#1"], "#2 dropped: depends on un-approved #3");
  assert.deepEqual(r.excluded_no_label, ["#3", "#4"]);
  assert.deepEqual(r.excluded_unapproved_dep, ["#2"]);
});

test("selectAutoOk: no auto-ok labels -> empty selection (ungated --auto impossible)", () => {
  const r = selectAutoOk(["#1", "#2"], { "#1": [], "#2": [] }, new Set());
  assert.deepEqual(r.selected, []);
  assert.deepEqual(r.excluded_no_label, ["#1", "#2"]);
});

// ---------------------------------------------------------------------------
// 3. Engine: run() modes (present / drive / auto) with injected gh + git
// ---------------------------------------------------------------------------

const PIPE_FIXTURE = [
  iss(10, { milestone: { title: "M", dueOn: "2026-09-01T00:00:00Z" } }),
  iss(11, { milestone: { title: "M", dueOn: "2026-08-01T00:00:00Z" } }),
  iss(20, { milestone: { title: "M", dueOn: "2026-07-01T00:00:00Z" }, body: "depends on #10" }),
  iss(21, { labels: [{ name: "priority:high" }], body: "blocked by #11" }),
  iss(22, { updatedAt: "2026-01-01T00:00:00Z" }),
  iss(23, { updatedAt: "2026-06-01T00:00:00Z" }),
];

test("run: present mode (default) prioritizes all, emits drive_args, launches nothing", () => {
  const gh = mockGh({ issues: PIPE_FIXTURE });
  const r = run([], { ghRun: gh, gitRun: mockGit() });
  assert.equal(r.mode, "present");
  assert.equal(r.repo, "ozzy-labs/skills");
  assert.deepEqual(
    r.issues.map((i) => i.ref),
    ["#11", "#10", "#20", "#21", "#22", "#23"],
  );
  assert.deepEqual(r.blockers.sort(), ["#10", "#11"]);
  assert.equal(r.handoff.drive_args, "#11,#10,#22,#23 -> #20,#21");
});

test("run: --drive=3 selects top-3 + dependency closure", () => {
  const gh = mockGh({ issues: PIPE_FIXTURE });
  const r = run(["--drive=3"], { ghRun: gh, gitRun: mockGit() });
  assert.equal(r.mode, "drive");
  // top-3 by priority = #11,#10,#20; #20's dep #10 already in the set.
  assert.deepEqual(r.handoff.selected, ["#11", "#10", "#20"]);
  assert.equal(r.handoff.drive_args, "#11,#10 -> #20");
});

test("run: --auto restricts the handoff to auto-ok issues (gating enforced by the engine)", () => {
  const fixture = [
    iss(1, { labels: [{ name: "auto-ok" }] }),
    iss(2, { labels: [{ name: "auto-ok" }], body: "depends on #3" }),
    iss(3, {}), // not auto-ok
    iss(4, {}), // not auto-ok
  ];
  const gh = mockGh({ issues: fixture });
  const r = run(["--auto"], { ghRun: gh, gitRun: mockGit() });
  assert.equal(r.mode, "auto");
  assert.equal(r.handoff.auto_ok_only, true);
  assert.deepEqual(
    r.handoff.selected,
    ["#1"],
    "only auto-ok, and #2 dropped (dep on un-approved #3)",
  );
  assert.ok(!r.handoff.selected.includes("#3"), "a non-auto-ok issue is never handed to drive");
  assert.deepEqual(r.handoff.excluded_no_label.sort(), ["#3", "#4"]);
  assert.deepEqual(r.handoff.excluded_unapproved_dep, ["#2"]);
});

test("run: --auto with no auto-ok issues hands off nothing + warns", () => {
  const gh = mockGh({ issues: [iss(1), iss(2)] });
  const r = run(["--auto"], { ghRun: gh, gitRun: mockGit() });
  assert.deepEqual(r.handoff.selected, []);
  assert.equal(r.handoff.drive_args, "");
  assert.ok(r.warnings.some((w) => /auto-ok/.test(w) && /HATL/.test(w)));
});

test("run: gh failure surfaces fetch_error, empty handoff", () => {
  const r = run([], { ghRun: mockGh({ unauth: true }), gitRun: mockGit() });
  assert.equal(r.fetch_error, "gh not authenticated");
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.handoff.selected, []);
});

test("run: no GitHub remote and no --repo -> repo_error set", () => {
  const r = run([], { ghRun: mockGh({ issues: [] }), gitRun: mockGit(null) });
  assert.equal(r.repo, null);
  assert.equal(r.repo_error, "no GitHub remote");
});

// ---------------------------------------------------------------------------
// 3. Engine: render smoke
// ---------------------------------------------------------------------------

test("render: human report includes the candidate list, blockers, and drive args", () => {
  const gh = mockGh({ issues: PIPE_FIXTURE });
  const text = render(run([], { ghRun: gh, gitRun: mockGit() }));
  assert.match(text, /Prioritized candidates:/);
  assert.match(text, /Blockers/);
  assert.match(text, /drive args: /);
  assert.match(text, /→ \/drive /);
});
