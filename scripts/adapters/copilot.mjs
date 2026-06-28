// GitHub Copilot adapter.
//
// GitHub Copilot CLI reads Agent Skills natively from `.agents/skills/` (it also
// reads `.github/skills/` and `.claude/skills/`, but `.agents/skills/` carries
// the canonical, non-Claude-wrapped SKILL.md — the right source for Copilot).
// So this adapter ships the same canonical `.agents/skills/` tree as Codex,
// plus a `copilot-instructions.md.snippet` human-readable index that the
// consumer's sync script merges into the hand-edited instructions file.
//
// Reference: https://docs.github.com/en/copilot/customizing-copilot

import { AdapterBase } from "../lib/adapter-base.mjs";
import { filterSkillsForAdapter } from "../lib/adapter-gating.mjs";
import { renderAgentsSkillsTree } from "../lib/agents-skills-tree.mjs";
import { wrapSnippet } from "../lib/snippet.mjs";

/**
 * @typedef {import("../lib/types.mjs").Skill} Skill
 * @typedef {import("../lib/types.mjs").OutputFile} OutputFile
 */

/**
 * @param {Skill[]} skills
 * @returns {string}
 */
function renderCopilotSnippet(skills) {
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  const lines = ["## Available Skills", ""];
  for (const skill of sorted) {
    lines.push(`- \`${skill.name}\` — ${skill.description}`);
  }
  return wrapSnippet(lines.join("\n"));
}

export class CopilotAdapter extends AdapterBase {
  static id = "copilot";

  /**
   * @param {Skill[]} skills
   * @returns {Promise<OutputFile[]>}
   */
  async generate(skills) {
    const allowed = filterSkillsForAdapter(skills, CopilotAdapter.id);
    const sorted = [...allowed].sort((a, b) => a.name.localeCompare(b.name));
    return [
      ...renderAgentsSkillsTree(sorted),
      {
        relativePath: ".github/copilot-instructions.md.snippet",
        content: renderCopilotSnippet(sorted),
      },
    ];
  }
}
