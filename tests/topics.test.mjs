// Validate the topics skill (issue #63).
//
// The topics skill is a prompt-driven workflow: there is no JS module that
// implements topic selection. These tests therefore cover two things:
//
//   1. SKILL.md / SKILL.claude-code.md present and structurally valid
//      (frontmatter shape + name match + documented behaviors).
//   2. Fixture-based assertions that exercise the documented validation
//      rules (GitHub constraints, broad+narrow 5x ratio, singular/plural
//      comparison, ozzy-labs hardcoded conventions). The fixtures are pure
//      data; the rules are reimplemented here as the canonical reference
//      that the SKILL.md is expected to describe. If the SKILL.md drifts
//      from these rules, doc-content assertions in this file catch it.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSkillDocument } from "../scripts/lib/frontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOPICS_DIR = join(ROOT, ".agents", "skills", "topics");
const SKILL_MD = join(TOPICS_DIR, "SKILL.md");
const SKILL_CLAUDE_MD = join(TOPICS_DIR, "SKILL.claude-code.md");

// ---------------------------------------------------------------------------
// 1. SKILL.md structural validation
// ---------------------------------------------------------------------------

test("topics skill directory exists", () => {
  assert.ok(existsSync(TOPICS_DIR), `expected ${TOPICS_DIR} to exist`);
  assert.ok(existsSync(SKILL_MD), "SKILL.md must exist");
  assert.ok(existsSync(SKILL_CLAUDE_MD), "SKILL.claude-code.md must exist");
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
  // Overlay companions carry only Claude-only keys; `description` is injected
  // from the canonical SKILL.md at build time, so it must NOT be duplicated here.
  assert.ok(
    !frontmatter.description,
    "Claude Code companion must not duplicate description (canonical is the single source)",
  );
  assert.equal(
    frontmatter["disable-model-invocation"],
    "true",
    "topics companion must carry its Claude-only frontmatter",
  );
  // Companion must not redeclare `name` (the canonical SKILL.md owns it).
  assert.equal(
    frontmatter.name,
    undefined,
    "Claude Code companion must not redeclare 'name' (avoid drift with SKILL.md)",
  );
});

// ---------------------------------------------------------------------------
// 2. Documented behaviors (acceptance criteria 1-7 of #63)
// ---------------------------------------------------------------------------

test("SKILL.md documents GitHub official constraints (#63 AC2)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  // Must mention the four constraints: lowercase, hyphen, 50 chars, 20 max.
  assert.match(raw, /lowercase/i, "must document lowercase constraint");
  assert.match(raw, /ハイフン|hyphen|`-`/i, "must document hyphen constraint");
  assert.match(raw, /50/, "must document 50-character length cap");
  assert.match(raw, /20/, "must document 20-topic count cap");
});

test("SKILL.md documents popularity lookup with session cache (#63 AC3)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(
    raw,
    /search\/repositories\?q=topic:/,
    "must document the gh api search query for popularity",
  );
  assert.match(raw, /total_count/, "must reference total_count from the search endpoint");
  assert.match(raw, /session 内キャッシュ|session\s*cache/i, "must require session-scoped cache");
});

test("SKILL.md documents broad+narrow 5x threshold (#63 AC4)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /broad/i, "must mention broad/narrow concept");
  assert.match(raw, /narrow/i, "must mention narrow concept");
  assert.match(raw, /\b5\b|×\s*5|x\s*5/, "must document 5x threshold");
});

test("SKILL.md documents singular/plural comparison (#63 AC5)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /単数.*複数|単数\s*\/\s*複数/, "must document singular/plural comparison rule");
  assert.match(raw, /-s\b/, "must reference the -s suffix as the comparison key");
});

test("SKILL.md hardcodes ozzy-labs conventions (#63 AC6)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  // claude-code preferred over claude
  assert.match(raw, /claude-code/, "must hardcode claude-code as a special case");
  assert.match(raw, /claude\b/, "must compare claude-code with claude");
  // multi-agent fixed form
  assert.match(raw, /multi-agent/, "must hardcode multi-agent as the canonical form");
  assert.match(
    raw,
    /multi-agents|multiagent/,
    "must mention rejected variants (multi-agents / multiagent)",
  );
  // *-cli suffix removal with claude-code as exception
  assert.match(raw, /-cli/, "must document the *-cli suffix removal rule");
  assert.match(
    raw,
    /codex.*gemini.*copilot|gemini.*codex.*copilot|copilot.*codex.*gemini/s,
    "must enumerate the three CLIs subject to suffix removal",
  );
});

test("SKILL.md documents --dry-run and --apply flags (#63 AC7)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /--dry-run/, "must document --dry-run flag");
  assert.match(raw, /--apply/, "must document --apply flag");
});

test("SKILL.md classes topics apply as externally-visible and references policy (#181 PR2)", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  // Application is now expressed as an action class + central policy reference,
  // not a bespoke confirmation prose.
  assert.match(raw, /externally-visible/, "topics apply must be classed as externally-visible");
  assert.match(raw, /batch-confirm/, "zero-config gate for topics apply must be batch-confirm");
  assert.match(raw, /policy-read\.mjs/, "must point at the policy read substrate");
  assert.match(raw, /topics-apply/, "must name the policy action for `gh repo edit --add-topic`");
  // --apply is reframed as the explicit batch-confirm opt-out.
  assert.match(
    raw,
    /--apply[^\n]*opt-out|opt-out[^\n]*--apply|明示 opt-out/,
    "--apply must be documented as the explicit batch-confirm opt-out",
  );
});

test("SKILL.claude-code.md gates apply confirmation on the policy batch-confirm gate (#181 PR2)", async () => {
  const raw = await readFile(SKILL_CLAUDE_MD, "utf8");
  assert.match(raw, /batch-confirm/, "companion must reference the batch-confirm gate");
  assert.match(raw, /AskUserQuestion/, "companion must keep the AskUserQuestion confirmation flow");
});

test("SKILL.md documents scope (ozzy-labs only) and exclusions", async () => {
  const raw = await readFile(SKILL_MD, "utf8");
  assert.match(raw, /ozzy-labs/i, "must declare ozzy-labs scope");
  assert.match(
    raw,
    /スコープ外|out of scope/i,
    "must enumerate explicit scope-out items (cross-org, persistent cache, init-templates)",
  );
});

// ---------------------------------------------------------------------------
// 3. Fixture-based rule reference (canonical implementation of the spec)
// ---------------------------------------------------------------------------
//
// The topics skill is executed by an LLM following SKILL.md prose. To pin down
// the rules and detect doc drift, we re-implement them here as small pure
// functions and exercise them with fixtures. If the SKILL.md changes without
// updating these fixtures (or vice versa), the test suite breaks loudly.

/**
 * GitHub official topic constraints.
 * @param {string} topic
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateConstraint(topic) {
  if (typeof topic !== "string" || topic.length === 0) {
    return { valid: false, reason: "empty" };
  }
  if (topic.length > 50) return { valid: false, reason: "length>50" };
  if (!/^[a-z0-9-]+$/.test(topic)) return { valid: false, reason: "charset" };
  if (topic.startsWith("-") || topic.endsWith("-")) {
    return { valid: false, reason: "leading/trailing hyphen" };
  }
  return { valid: true };
}

/**
 * Cap the candidate list to GitHub's max of 20 topics.
 * Returns at most 20 entries; additional entries are reported as overflow.
 */
function applyCountCap(topics, max = 20) {
  const unique = [...new Set(topics)];
  return {
    accepted: unique.slice(0, max),
    overflow: unique.slice(max),
  };
}

/**
 * Decide broad+narrow recommendation given popularity counts.
 * @param {number} broad
 * @param {number} narrow
 * @returns {"broad-only" | "both" | "ozzy-hardcode"}
 */
function broadNarrowDecision(broad, narrow) {
  if (broad >= narrow * 5) return "broad-only";
  if (narrow > broad) return "ozzy-hardcode";
  return "both";
}

/**
 * Apply ozzy-labs hardcoded conventions to a candidate list.
 * - `multi-agents` / `multiagent` → drop in favor of `multi-agent`
 * - `<name>-cli` → strip `-cli` for codex / gemini / copilot
 *   (claude-code is the explicit exception: it is a product name)
 */
function applyOzzyConventions(candidates) {
  const out = [];
  const dropped = [];
  const renamed = [];
  for (const c of candidates) {
    if (c === "multi-agents" || c === "multiagent") {
      dropped.push({ from: c, reason: "multi-agent canonical form" });
      continue;
    }
    if (c === "codex-cli" || c === "gemini-cli" || c === "copilot-cli") {
      const stripped = c.slice(0, -"-cli".length);
      renamed.push({ from: c, to: stripped, reason: "*-cli suffix removed" });
      out.push(stripped);
      continue;
    }
    // claude-code is preserved verbatim — it's a product name, not "<tool>-cli"
    out.push(c);
  }
  // Deduplicate after rewrite (e.g. ["codex-cli", "codex"] → ["codex"]).
  return { out: [...new Set(out)], dropped, renamed };
}

// --- constraint fixtures ---

test("fixture: constraint validation accepts well-formed topics", () => {
  const valid = ["ai", "ai-agents", "claude-code", "multi-agent", "rss", "web-scraping", "a1"];
  for (const t of valid) {
    assert.deepEqual(validateConstraint(t), { valid: true }, `expected ${t} to be valid`);
  }
});

test("fixture: constraint validation rejects malformed topics", () => {
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
    const result = validateConstraint(topic);
    assert.equal(result.valid, false, `expected ${JSON.stringify(topic)} to be invalid`);
    assert.equal(result.reason, reason, `expected reason '${reason}' for ${JSON.stringify(topic)}`);
  }
});

test("fixture: count cap returns first 20 and reports overflow", () => {
  const inputs = Array.from({ length: 25 }, (_, i) => `t${i}`);
  const { accepted, overflow } = applyCountCap(inputs);
  assert.equal(accepted.length, 20, "must accept at most 20");
  assert.equal(overflow.length, 5, "must report 5 overflow items");
  assert.equal(accepted[0], "t0");
  assert.equal(overflow[0], "t20");
});

test("fixture: count cap dedupes before counting", () => {
  const inputs = ["a", "b", "a", "c", "b"];
  const { accepted, overflow } = applyCountCap(inputs);
  assert.deepEqual(accepted, ["a", "b", "c"]);
  assert.deepEqual(overflow, []);
});

// --- broad+narrow fixtures ---

test("fixture: broad-only recommended when broad >= narrow * 5", () => {
  // Realistic-looking numbers: broad >> narrow.
  assert.equal(broadNarrowDecision(120_000, 20_000), "broad-only"); // ratio = 6
  assert.equal(broadNarrowDecision(50_000, 10_000), "broad-only"); // exactly 5x
  assert.equal(broadNarrowDecision(100, 1), "broad-only"); // tiny narrow
});

test("fixture: both retained when broad < narrow * 5 and broad > narrow", () => {
  // Same-order-of-magnitude case.
  assert.equal(broadNarrowDecision(28_000, 10_000), "both"); // ratio < 5
  assert.equal(broadNarrowDecision(30_000, 28_000), "both"); // close
});

test("fixture: narrow > broad triggers ozzy-hardcode path (claude-code case)", () => {
  // The motivating example from #63: claude-code (~25k) > claude (~21k).
  assert.equal(broadNarrowDecision(21_062, 25_514), "ozzy-hardcode");
});

// --- ozzy-labs convention fixtures ---

test("fixture: multi-agents / multiagent are dropped in favor of multi-agent", () => {
  const { out, dropped } = applyOzzyConventions([
    "multi-agent",
    "multi-agents",
    "multiagent",
    "ai",
  ]);
  assert.deepEqual(out, ["multi-agent", "ai"]);
  assert.deepEqual(dropped.map((d) => d.from).sort(), ["multi-agents", "multiagent"]);
});

test("fixture: *-cli suffix removed for codex / gemini / copilot", () => {
  const { out, renamed } = applyOzzyConventions(["codex-cli", "gemini-cli", "copilot-cli"]);
  assert.deepEqual(out.sort(), ["codex", "copilot", "gemini"]);
  assert.equal(renamed.length, 3, "all three CLI suffixes must be renamed");
  assert.ok(
    renamed.every((r) => r.reason.includes("*-cli")),
    "rename reason must reference the *-cli rule",
  );
});

test("fixture: claude-code is the explicit exception (not stripped)", () => {
  const { out, renamed } = applyOzzyConventions(["claude-code", "codex-cli"]);
  assert.ok(out.includes("claude-code"), "claude-code must remain unchanged");
  assert.ok(out.includes("codex"), "codex-cli must still be stripped to codex");
  // Only codex-cli should be in the rename list.
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0].from, "codex-cli");
});

test("fixture: applying conventions dedupes after rewrite (codex-cli + codex → codex)", () => {
  const { out } = applyOzzyConventions(["codex-cli", "codex"]);
  assert.deepEqual(out, ["codex"], "duplicate after suffix-strip must be removed");
});

// --- end-to-end ozzy-labs candidate fixture ---

test("fixture: end-to-end ozzy-labs realistic candidate list", () => {
  // Reproduces the agentic-watch setup mentioned in #63.
  const candidates = [
    "ai",
    "ai-agents",
    "agentic",
    "multi-agent",
    "multiagent", // dropped
    "cli",
    "claude",
    "claude-code",
    "codex-cli", // → codex
    "gemini-cli", // → gemini
    "copilot-cli", // → copilot
    "rss",
    "web-scraping",
    "news",
    "release-notes",
    "research",
    "markdown",
    "Foo-Bar", // dropped (charset)
    "ai_agents", // dropped (charset)
  ];
  // Step 1: constraints
  const valid = candidates.filter((c) => validateConstraint(c).valid);
  // Step 5: ozzy conventions
  const { out } = applyOzzyConventions(valid);
  // Step 1 (count cap)
  const { accepted, overflow } = applyCountCap(out);

  assert.ok(!accepted.includes("Foo-Bar"), "uppercase must be filtered");
  assert.ok(!accepted.includes("ai_agents"), "underscore must be filtered");
  assert.ok(!accepted.includes("multiagent"), "multiagent must be replaced by multi-agent");
  assert.ok(!accepted.includes("codex-cli"), "codex-cli must be stripped");
  assert.ok(accepted.includes("codex"), "codex must be present after suffix removal");
  assert.ok(accepted.includes("claude-code"), "claude-code must survive as-is");
  assert.ok(accepted.includes("multi-agent"), "multi-agent canonical form must be present");
  assert.ok(accepted.length <= 20, "must respect 20-topic cap");
  assert.equal(overflow.length, 0, "this fixture sits within the 20 cap");
});
