// Claude Code adapter.
//
// Claude Code reads `.claude/skills/{name}/SKILL.md` from the consumer repo,
// driven by frontmatter (`description`, plus Claude-specific fields like
// `allowed-tools`, `disable-model-invocation`, `argument-hint`,
// `user-invocable`).
//
// Each canonical skill may ship an optional companion file at
// `.agents/skills/{name}/SKILL.claude-code.md`. When present, the adapter emits
// the companion verbatim so the skill can carry a Claude-Code-specific
// wrapper (next-action AskUserQuestion menus, argument parsing, etc.)
// without polluting the canonical SKILL.md other adapters consume. When
// absent, the canonical SKILL.md is passed through — preserving the
// pre-companion behavior.
//
// The adapter also emits any non-SKILL.* extra files shipped with a skill
// (e.g. `perspectives/<axis>.md` for the review skill — ADR-0025) and
// project-level Claude Code agents under `.claude/agents/<name>.md`
// (ADR-0026). Agents are Claude Code only — other adapters ignore them.
//
// Reference: https://docs.claude.com/en/docs/claude-code/skills

import { AdapterBase } from "../lib/adapter-base.mjs";
import { filterSkillsForAdapter } from "../lib/adapter-gating.mjs";
import { assertRequiredFields, serializeFrontmatter } from "../lib/frontmatter.mjs";

/**
 * @typedef {import("../lib/types.mjs").Skill} Skill
 * @typedef {import("../lib/types.mjs").Agent} Agent
 * @typedef {import("../lib/types.mjs").OutputFile} OutputFile
 * @typedef {import("../lib/types.mjs").GenerateOptions} GenerateOptions
 */

export class ClaudeCodeAdapter extends AdapterBase {
  static id = "claude-code";

  /**
   * @param {Skill[]} skills
   * @param {GenerateOptions} [options]
   * @returns {Promise<OutputFile[]>}
   */
  async generate(skills, options = {}) {
    const allowed = filterSkillsForAdapter(skills, ClaudeCodeAdapter.id);
    const sortedSkills = [...allowed].sort((a, b) => a.name.localeCompare(b.name));
    const outputs = [];
    for (const skill of sortedSkills) {
      const canonicalLabel = `.agents/skills/${skill.name}/SKILL.md`;
      assertRequiredFields(skill.frontmatter, ["name", "description"], canonicalLabel);

      const companion = skill.claudeCodeCompanion;
      if (companion) {
        // Overlay model: the companion carries ONLY Claude-specific frontmatter
        // (allowed-tools, disable-model-invocation, argument-hint, …) plus its
        // body — NOT a duplicated `description`. The canonical `description` is
        // the single source of truth and is injected here as the first key, so
        // the two can never drift. Any stray `description` in the overlay is
        // dropped in favour of the canonical one.
        const { description: _ignored, ...claudeOnly } = companion.frontmatter;
        const merged = { description: skill.description, ...claudeOnly };
        outputs.push({
          relativePath: `.claude/skills/${skill.name}/SKILL.md`,
          content: serializeFrontmatter(merged) + companion.body,
        });
      } else {
        outputs.push({
          relativePath: `.claude/skills/${skill.name}/SKILL.md`,
          content: skill.raw,
        });
      }
      for (const extra of skill.extraFiles ?? []) {
        outputs.push({
          relativePath: `.claude/skills/${skill.name}/${extra.relativePath}`,
          content: extra.content,
        });
      }
    }

    const agents = [...(options.agents ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of agents) {
      const label = `src/agents/${agent.name}.md`;
      assertRequiredFields(agent.frontmatter, ["name", "description", "tools"], label);
      outputs.push({
        relativePath: `.claude/agents/${agent.name}.md`,
        content: agent.raw,
      });
    }
    return outputs;
  }
}
