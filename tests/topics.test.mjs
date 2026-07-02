// Tests for the topics skill (issue #63) — engine-based after ADR-0028 R1.
//
// The determinism now lives in `.agents/skills/topics/topics.mjs`, so these
// tests drive the ENGINE directly: fixture inputs -> topics.mjs JSON output
// (constraint filter / popularity 5x / singular-plural / ozzy conventions /
// apply plan), with `gh` and `git` dependency-injected. A thin layer of
// doc-content assertions keeps SKILL.md / the companion honest about the
// engine call + the policy gate (they no longer re-encode the rules).

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyCountCap,
  applyOzzyConventions,
  broadNarrowDecision,
  detectBroadNarrowPairs,
  detectSingularPluralPairs,
  fetchPopularity,
  filterConstraints,
  isBroadOf,
  ozzyHardcodedRetentions,
  parseArgs,
  parseRepoSlug,
  render,
  run,
  selectTopics,
  singularPluralDecision,
  validateConstraint,
} from "../.agents/skills/topics/topics.mjs";
import { parseSkillDocument } from "../scripts/lib/frontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOPICS_DIR = join(ROOT, ".agents", "skills", "topics");
const SKILL_MD = join(TOPICS_DIR, "SKILL.md");
const SKILL_CLAUDE_MD = join(TOPICS_DIR, "SKILL.claude-code.md");
const ENGINE = join(TOPICS_DIR, "topics.mjs");

// ---------------------------------------------------------------------------
// gh / git test doubles
// ---------------------------------------------------------------------------

/**
 * A gh runner that answers `gh api search/repositories?q=topic:<name>` from a
 * popularity map, and `gh repo edit` / `gh repo view` for the apply path.
 * `unauth` simulates an unauthenticated CLI; `unknown` names return a failing
 * search (so the engine records popularity=null, never 0).
 */
function mockGh({ popularity = {}, unauth = false, applyFail = false, viewTopics = null } = {}) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    if (args[0] === "api") {
      if (unauth) {
        return {
          status: 1,
          stdout: "",
          stderr: "gh auth login: not logged into any host",
          error: null,
        };
      }
      const m = String(args[1]).match(/topic:(.+)$/);
      const name = m ? m[1] : "";
      if (name in popularity) {
        return { status: 0, stdout: `${popularity[name]}\n`, stderr: "", error: null };
      }
      // unknown topic -> simulate an API failure (popularity unknown)
      return { status: 1, stdout: "", stderr: "API rate limit exceeded", error: null };
    }
    if (args[0] === "repo" && args[1] === "edit") {
      return applyFail
        ? { status: 1, stdout: "", stderr: "HTTP 403: forbidden", error: null }
        : { status: 0, stdout: "", stderr: "", error: null };
    }
    if (args[0] === "repo" && args[1] === "view") {
      const nodes = (viewTopics ?? []).map((n) => ({ name: n }));
      return {
        status: 0,
        stdout: JSON.stringify({ repositoryTopics: nodes }),
        stderr: "",
        error: null,
      };
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

// ---------------------------------------------------------------------------
// 1. SKILL.md / companion structural validation
// ---------------------------------------------------------------------------

test("topics skill directory ships SKILL.md, companion, and the engine", () => {
  assert.ok(existsSync(TOPICS_DIR), `expected ${TOPICS_DIR} to exist`);
  assert.ok(existsSync(SKILL_MD), "SKILL.md must exist");
  assert.ok(existsSync(SKILL_CLAUDE_MD), "SKILL.claude-code.md must exist");
  assert.ok(existsSync(ENGINE), "topics.mjs engine must exist");
});

test("topics SKILL.md has valid frontmatter (name + description)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  const { frontmatter } = parseSkillDocument(raw, ".agents/skills/topics/SKILL.md");
  assert.equal(frontmatter.name, "topics", "frontmatter name must equal directory name");
  assert.ok(
    frontmatter.description && frontmatter.description.length > 0,
    "frontmatter description must be non-empty",
  );
});

test("topics SKILL.claude-code.md is a Claude-only overlay (no duplicated description)", async () => {
  const raw = await readFile(SKILL_CLAUDE_MD, "utf8");
  const { frontmatter } = parseSkillDocument(raw, ".agents/skills/topics/SKILL.claude-code.md");
  assert.ok(
    !frontmatter.description,
    "Claude Code companion must not duplicate description (canonical is the single source)",
  );
  assert.equal(
    frontmatter["disable-model-invocation"],
    "true",
    "topics companion must carry its Claude-only frontmatter",
  );
  assert.equal(
    frontmatter.name,
    undefined,
    "Claude Code companion must not redeclare 'name' (avoid drift with SKILL.md)",
  );
});

// ---------------------------------------------------------------------------
// 2. Thin doc-content assertions: engine call + policy gate are documented
// ---------------------------------------------------------------------------

test("SKILL.md points at the topics.mjs engine (ADR-0028 R1)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /topics\.mjs/, "must instruct running the topics.mjs engine");
  assert.match(raw, /node <[^>]*>\/topics\.mjs/, "must show the node topics.mjs invocation");
});

test("SKILL.md classes topics apply as externally-visible and references policy (#181 PR2)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /externally-visible/, "topics apply must be classed as externally-visible");
  assert.match(raw, /batch-confirm/, "zero-config gate for topics apply must be batch-confirm");
  assert.match(raw, /policy-read\.mjs/, "must point at the policy read substrate");
  assert.match(raw, /topics-apply/, "must name the policy action for `gh repo edit --add-topic`");
  assert.match(
    raw,
    /--apply[^\n]*opt-out|opt-out[^\n]*--apply|明示 opt-out/,
    "--apply must be documented as the explicit batch-confirm opt-out",
  );
});

test("SKILL.md documents --dry-run / --apply and the ozzy-labs scope", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /--dry-run/, "must document --dry-run flag");
  assert.match(raw, /--apply/, "must document --apply flag");
  assert.match(raw, /ozzy-labs/i, "must declare ozzy-labs scope");
  assert.match(raw, /スコープ外|out of scope/i, "must enumerate explicit scope-out items");
});

test("SKILL.claude-code.md keeps the batch-confirm + AskUserQuestion apply UI (#181 PR2)", async () => {
  const raw = await readFile(SKILL_CLAUDE_MD, "utf8");
  assert.match(raw, /batch-confirm/, "companion must reference the batch-confirm gate");
  assert.match(raw, /AskUserQuestion/, "companion must keep the AskUserQuestion confirmation flow");
  assert.match(raw, /topics\.mjs/, "companion must call the engine, not re-encode the rules");
});

// ---------------------------------------------------------------------------
// 3. Engine: arg parsing
// ---------------------------------------------------------------------------

test("parseArgs: comma list + multiple positional args + flags", () => {
  const a = parseArgs(["ai,claude-code", "rss", "--repo", "ozzy-labs/skills", "--dry-run"]);
  assert.deepEqual(a.candidates, ["ai", "claude-code", "rss"]);
  assert.equal(a.repo, "ozzy-labs/skills");
  assert.equal(a.dryRun, true);
  assert.equal(a.apply, false);
});

test("parseArgs: --apply flag and --repo=value form", () => {
  const a = parseArgs(["ai", "--apply", "--repo=owner/name", "--json"]);
  assert.deepEqual(a.candidates, ["ai"]);
  assert.equal(a.apply, true);
  assert.equal(a.repo, "owner/name");
  assert.equal(a.json, true);
});

// ---------------------------------------------------------------------------
// 3. Engine: Step 1 constraints
// ---------------------------------------------------------------------------

test("validateConstraint accepts well-formed topics", () => {
  for (const t of ["ai", "ai-agents", "claude-code", "multi-agent", "rss", "web-scraping", "a1"]) {
    assert.deepEqual(validateConstraint(t), { valid: true }, `expected ${t} valid`);
  }
});

test("validateConstraint rejects malformed topics with a reason", () => {
  const cases = [
    { topic: "AI", reason: "charset" },
    { topic: "Foo-Bar", reason: "charset" },
    { topic: "ai_agents", reason: "charset" },
    { topic: "ai agents", reason: "charset" },
    { topic: "-ai", reason: "leading/trailing hyphen" },
    { topic: "ai-", reason: "leading/trailing hyphen" },
    { topic: "", reason: "empty" },
    { topic: "a".repeat(51), reason: "length>50" },
  ];
  for (const { topic, reason } of cases) {
    const r = validateConstraint(topic);
    assert.equal(r.valid, false, `expected ${JSON.stringify(topic)} invalid`);
    assert.equal(r.reason, reason);
  }
});

test("filterConstraints dedupes and separates valid / rejected", () => {
  const { valid, rejected } = filterConstraints(["ai", "ai", "Foo", "rss", "bad_x"]);
  assert.deepEqual(valid, ["ai", "rss"]);
  assert.deepEqual(rejected.map((r) => r.topic).sort(), ["Foo", "bad_x"]);
});

test("applyCountCap returns first 20 (deduped) and reports overflow", () => {
  const { accepted, overflow } = applyCountCap(Array.from({ length: 25 }, (_, i) => `t${i}`));
  assert.equal(accepted.length, 20);
  assert.equal(overflow.length, 5);
  assert.equal(overflow[0], "t20");
  assert.deepEqual(applyCountCap(["a", "b", "a"]).accepted, ["a", "b"]);
});

// ---------------------------------------------------------------------------
// 3. Engine: Step 5 ozzy conventions
// ---------------------------------------------------------------------------

test("applyOzzyConventions: multi-agents / multiagent dropped for multi-agent", () => {
  const { out, dropped } = applyOzzyConventions([
    "multi-agent",
    "multi-agents",
    "multiagent",
    "ai",
  ]);
  assert.deepEqual(out, ["multi-agent", "ai"]);
  assert.deepEqual(dropped.map((d) => d.from).sort(), ["multi-agents", "multiagent"]);
});

test("applyOzzyConventions: *-cli stripped for codex/gemini/copilot, claude-code exempt", () => {
  const { out, renamed } = applyOzzyConventions([
    "codex-cli",
    "gemini-cli",
    "copilot-cli",
    "claude-code",
  ]);
  assert.deepEqual(out.sort(), ["claude-code", "codex", "copilot", "gemini"]);
  assert.equal(renamed.length, 3);
  assert.ok(renamed.every((r) => r.reason.includes("*-cli")));
});

test("applyOzzyConventions dedupes after rewrite (codex-cli + codex -> codex)", () => {
  assert.deepEqual(applyOzzyConventions(["codex-cli", "codex"]).out, ["codex"]);
});

test("ozzyHardcodedRetentions: claude + claude-code retained together", () => {
  assert.deepEqual(ozzyHardcodedRetentions(["ai", "claude", "claude-code"])[0].topics, [
    "claude",
    "claude-code",
  ]);
  assert.deepEqual(ozzyHardcodedRetentions(["ai", "claude"]), []);
});

// ---------------------------------------------------------------------------
// 3. Engine: Step 3 broad+narrow
// ---------------------------------------------------------------------------

test("isBroadOf: hyphen-derivative pairs only", () => {
  assert.equal(isBroadOf("ai", "ai-agents"), true);
  assert.equal(isBroadOf("agent", "multi-agent"), true);
  assert.equal(isBroadOf("claude", "claude-code"), true);
  assert.equal(isBroadOf("news", "release-notes"), false);
  assert.equal(isBroadOf("ai", "agentic"), false);
  assert.equal(isBroadOf("ai", "ai"), false);
});

test("detectBroadNarrowPairs finds derivative pairs", () => {
  const pairs = detectBroadNarrowPairs(["ai", "ai-agents", "agentic", "claude", "claude-code"]);
  assert.deepEqual(pairs.map((p) => `${p.broad}>${p.narrow}`).sort(), [
    "ai>ai-agents",
    "claude>claude-code",
  ]);
});

test("broadNarrowDecision: 5x threshold, both, ozzy-hardcode, indeterminate", () => {
  assert.equal(broadNarrowDecision(120000, 20000), "broad-only"); // ratio 6
  assert.equal(broadNarrowDecision(50000, 10000), "broad-only"); // exactly 5x
  assert.equal(broadNarrowDecision(28000, 10000), "both"); // < 5x
  assert.equal(broadNarrowDecision(21062, 25514), "ozzy-hardcode"); // narrow > broad
  assert.equal(broadNarrowDecision(null, 5), "indeterminate"); // unknown popularity
  assert.equal(broadNarrowDecision(5, null), "indeterminate");
});

// ---------------------------------------------------------------------------
// 3. Engine: Step 4 singular / plural
// ---------------------------------------------------------------------------

test("detectSingularPluralPairs + singularPluralDecision pick the popular form", () => {
  assert.deepEqual(detectSingularPluralPairs(["agent", "agents", "ai"]), [
    { singular: "agent", plural: "agents" },
  ]);
  assert.deepEqual(singularPluralDecision("agent", 100, "agents", 500), {
    chosen: "agents",
    dropped: "agent",
  });
  assert.deepEqual(singularPluralDecision("agent", 500, "agents", 100), {
    chosen: "agent",
    dropped: "agents",
  });
  // unknown popularity leaves the pair undecided (both kept)
  assert.deepEqual(singularPluralDecision("agent", null, "agents", 100), {
    chosen: null,
    dropped: null,
  });
});

// ---------------------------------------------------------------------------
// 3. Engine: Step 2 popularity (mocked gh, session cache = query once)
// ---------------------------------------------------------------------------

test("fetchPopularity: parses counts, dedupes queries, records failures as null", () => {
  const gh = mockGh({ popularity: { ai: 120879, rss: 4200 } });
  const { counts, errors } = fetchPopularity(gh, ["ai", "rss", "ai", "nope"]);
  assert.equal(counts.ai, 120879);
  assert.equal(counts.rss, 4200);
  assert.equal(counts.nope, null); // failed lookup -> null, never 0
  assert.ok(errors.nope, "failure reason recorded for the unknown topic");
  // session cache: each unique topic queried exactly once (ai not queried twice)
  const apiCalls = gh.calls.filter((a) => a[0] === "api");
  assert.equal(apiCalls.length, 3);
});

test("parseRepoSlug: ssh / https / trailing .git", () => {
  assert.equal(parseRepoSlug("git@github.com:ozzy-labs/skills.git"), "ozzy-labs/skills");
  assert.equal(parseRepoSlug("https://github.com/ozzy-labs/skills"), "ozzy-labs/skills");
  assert.equal(parseRepoSlug("https://github.com/ozzy-labs/skills.git"), "ozzy-labs/skills");
  assert.equal(parseRepoSlug("https://example.com/x/y"), null);
});

// ---------------------------------------------------------------------------
// 3. Engine: selectTopics (pure, over a fixed popularity map)
// ---------------------------------------------------------------------------

test("selectTopics: broad-only pruning drops the redundant narrow term", () => {
  const r = selectTopics(["ai", "ai-agents"], { ai: 1_000_000, "ai-agents": 1000 });
  assert.deepEqual(r.final_topics, ["ai"]);
  assert.ok(r.dropped_by_decision.includes("ai-agents"));
  assert.equal(r.broad_narrow[0].decision, "broad-only");
});

test("selectTopics: ozzy hardcode retention overrides broad-only for claude/claude-code", () => {
  // Even with a lopsided popularity that would prune the narrow term, the
  // hardcoded convention keeps both.
  const r = selectTopics(["claude", "claude-code"], { claude: 1_000_000, "claude-code": 1000 });
  assert.deepEqual(r.final_topics.sort(), ["claude", "claude-code"]);
  assert.deepEqual(r.dropped_by_decision, []);
  assert.equal(r.conventions.hardcoded.length, 1);
});

test("selectTopics: end-to-end ozzy-labs realistic list -> Final 16 topics", () => {
  // Reproduces the agentic-watch setup from #63 (post-constraint valid list).
  const valid = [
    "ai",
    "ai-agents",
    "agentic",
    "multi-agent",
    "multiagent", // convention drop
    "cli",
    "claude",
    "claude-code",
    "codex-cli", // -> codex
    "gemini-cli", // -> gemini
    "copilot-cli", // -> copilot
    "rss",
    "web-scraping",
    "news",
    "release-notes",
    "research",
    "markdown",
  ];
  const counts = {
    ai: 120879,
    "ai-agents": 28093,
    agentic: 3000,
    "multi-agent": 4000,
    cli: 90000,
    claude: 21062,
    "claude-code": 25514,
    codex: 5000,
    gemini: 6000,
    copilot: 7000,
    rss: 4200,
    "web-scraping": 8000,
    news: 9000,
    "release-notes": 1200,
    research: 30000,
    markdown: 40000,
  };
  const r = selectTopics(valid, counts);
  assert.equal(r.final_topics.length, 16, JSON.stringify(r.final_topics));
  assert.ok(!r.final_topics.includes("multiagent"), "multiagent replaced by multi-agent");
  assert.ok(!r.final_topics.includes("codex-cli"), "codex-cli stripped");
  assert.ok(r.final_topics.includes("codex"), "codex present after strip");
  assert.ok(r.final_topics.includes("claude") && r.final_topics.includes("claude-code"));
  assert.ok(r.final_topics.includes("multi-agent"));
  // ai / ai-agents are same order of magnitude (ratio < 5) -> both kept
  assert.ok(r.final_topics.includes("ai") && r.final_topics.includes("ai-agents"));
});

// ---------------------------------------------------------------------------
// 3. Engine: run() modes (plan / dry-run / apply) with injected gh + git
// ---------------------------------------------------------------------------

const PLAN_POP = { ai: 120000, rss: 4200, claude: 21062, "claude-code": 25514 };

test("run: default is a PLAN — no gh repo edit, apply_command populated", () => {
  const gh = mockGh({ popularity: PLAN_POP });
  const r = run(["ai,rss", "--repo", "ozzy-labs/skills"], { ghRun: gh, gitRun: mockGit() });
  assert.equal(r.mode, "plan");
  assert.equal(r.apply_pending, true);
  assert.equal(r.applied, false);
  assert.ok(r.apply_command.startsWith("gh repo edit ozzy-labs/skills --add-topic"));
  assert.ok(!gh.calls.some((a) => a[0] === "repo" && a[1] === "edit"), "plan must not apply");
});

test("run: --dry-run analyzes but never applies", () => {
  const gh = mockGh({ popularity: PLAN_POP });
  const r = run(["ai", "--dry-run"], { ghRun: gh, gitRun: mockGit() });
  assert.equal(r.mode, "dry-run");
  assert.equal(r.applied, false);
  assert.equal(r.repo, "ozzy-labs/skills"); // resolved from the git remote
  assert.ok(!gh.calls.some((a) => a[0] === "repo" && a[1] === "edit"));
});

test("run: --dry-run wins over --apply (誤適用防止)", () => {
  const gh = mockGh({ popularity: PLAN_POP });
  const r = run(["ai", "--apply", "--dry-run"], { ghRun: gh, gitRun: mockGit() });
  assert.equal(r.mode, "dry-run");
  assert.ok(!gh.calls.some((a) => a[0] === "repo" && a[1] === "edit"));
});

test("run: --apply executes gh repo edit and verifies via gh repo view", () => {
  const gh = mockGh({ popularity: PLAN_POP, viewTopics: ["ai", "rss"] });
  const r = run(["ai,rss", "--apply", "--repo", "ozzy-labs/skills"], {
    ghRun: gh,
    gitRun: mockGit(),
  });
  assert.equal(r.mode, "apply");
  assert.equal(r.applied, true);
  const edit = gh.calls.find((a) => a[0] === "repo" && a[1] === "edit");
  assert.ok(edit, "gh repo edit must run");
  assert.ok(edit.includes("--add-topic"));
  assert.deepEqual(r.apply.verified_topics, ["ai", "rss"]);
});

test("run: --apply surfaces a failed gh repo edit", () => {
  const gh = mockGh({ popularity: PLAN_POP, applyFail: true });
  const r = run(["ai", "--apply", "--repo", "ozzy-labs/skills"], { ghRun: gh, gitRun: mockGit() });
  assert.equal(r.applied, false);
  assert.ok(r.apply.error, "apply error surfaced");
});

test("run: unauthenticated gh -> gh_available false, popularity null (not 0)", () => {
  const gh = mockGh({ unauth: true });
  const r = run(["ai,claude", "--dry-run"], { ghRun: gh, gitRun: mockGit() });
  assert.equal(r.gh_available, false);
  assert.equal(r.popularity.ai, null);
  assert.equal(r.popularity.claude, null);
});

test("run: all candidates rejected -> error, popularity API never called", () => {
  const gh = mockGh({ popularity: PLAN_POP });
  const r = run(["Foo_Bar", "BAD", "--dry-run"], { ghRun: gh, gitRun: mockGit() });
  assert.match(r.error, /no applicable candidates/);
  assert.equal(r.constraints.valid.length, 0);
  assert.ok(!gh.calls.some((a) => a[0] === "api"), "must not call the search API");
});

test("run: no GitHub remote and no --repo -> repo_error set", () => {
  const gh = mockGh({ popularity: PLAN_POP });
  const r = run(["ai"], { ghRun: gh, gitRun: mockGit(null) });
  assert.equal(r.repo, null);
  assert.equal(r.repo_error, "no GitHub remote");
});

// ---------------------------------------------------------------------------
// 3. Engine: render smoke
// ---------------------------------------------------------------------------

test("render: human report includes the final topics line and apply plan", () => {
  const gh = mockGh({ popularity: PLAN_POP });
  const r = run(["ai,rss", "--repo", "ozzy-labs/skills"], { ghRun: gh, gitRun: mockGit() });
  const text = render(r);
  assert.match(text, /Final \d+ topics:/);
  assert.match(text, /Apply plan:/);
});
