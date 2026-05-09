// Validate Claude Code agents loaded from src/agents/ (ADR-0026).
//
// Agents are Claude Code only. Each `src/agents/<name>.md` must declare
// `name`, `description`, and `tools` in frontmatter. The build pipeline
// emits them at `dist/claude-code/.claude/agents/<name>.md` and other
// adapters ignore them entirely.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter } from "../scripts/adapters/claude-code.mjs";
import { CodexCliAdapter } from "../scripts/adapters/codex-cli.mjs";
import { CopilotAdapter } from "../scripts/adapters/copilot.mjs";
import { GeminiCliAdapter } from "../scripts/adapters/gemini-cli.mjs";
import { parseSkillDocument } from "../scripts/lib/frontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = join(ROOT, "src", "agents");

async function loadAgents() {
  if (!existsSync(AGENTS_DIR)) return [];
  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  const agents = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const raw = await readFile(join(AGENTS_DIR, entry.name), "utf8");
    const { frontmatter, body } = parseSkillDocument(raw, `src/agents/${entry.name}`);
    agents.push({ name: frontmatter.name, frontmatter, body, raw });
  }
  return agents;
}

test("agents directory has at least one agent", async () => {
  const agents = await loadAgents();
  assert.ok(
    agents.length > 0,
    "expected src/agents/ to ship at least one agent (e.g. code-reviewer)",
  );
});

test("each agent has required frontmatter keys (name, description, tools)", async () => {
  const agents = await loadAgents();
  for (const agent of agents) {
    for (const key of ["name", "description", "tools"]) {
      assert.ok(
        agent.frontmatter[key] && agent.frontmatter[key].length > 0,
        `src/agents/${agent.name}.md: missing required frontmatter key '${key}'`,
      );
    }
  }
});

test("Claude Code adapter emits .claude/agents/<name>.md for each agent", async () => {
  const agents = await loadAgents();
  const out = await new ClaudeCodeAdapter().generate([], { agents });
  for (const agent of agents) {
    const file = out.find((o) => o.relativePath === `.claude/agents/${agent.name}.md`);
    assert.ok(file, `expected .claude/agents/${agent.name}.md in Claude Code output`);
    assert.equal(file.content, agent.raw, `agent ${agent.name} must be emitted verbatim`);
  }
});

test("non-Claude-Code adapters ignore agents", async () => {
  const agents = await loadAgents();
  for (const Adapter of [CodexCliAdapter, GeminiCliAdapter, CopilotAdapter]) {
    const out = await new Adapter().generate([], { agents });
    for (const file of out) {
      assert.doesNotMatch(
        file.relativePath,
        /\.claude\/agents\//,
        `${Adapter.name} must not emit .claude/agents/ outputs`,
      );
    }
  }
});

test("Claude Code adapter throws when agent is missing required field", async () => {
  const bad = {
    name: "broken",
    frontmatter: { name: "broken", description: "d" }, // missing tools
    body: "x",
    raw: "---\nname: broken\ndescription: d\n---\nx",
  };
  await assert.rejects(
    () => new ClaudeCodeAdapter().generate([], { agents: [bad] }),
    /missing required field 'tools'/,
  );
});

test("code-reviewer agent declares read-only tool allowlist (ADR-0025)", async () => {
  const agents = await loadAgents();
  const reviewer = agents.find((a) => a.name === "code-reviewer");
  assert.ok(reviewer, "code-reviewer agent must exist");
  const tools = reviewer.frontmatter.tools;
  assert.doesNotMatch(tools, /\bBash\b/, "code-reviewer must not allow Bash (read-only)");
  assert.doesNotMatch(tools, /\bEdit\b/, "code-reviewer must not allow Edit (read-only)");
  assert.doesNotMatch(tools, /\bWrite\b/, "code-reviewer must not allow Write (read-only)");
});
