// Claude Code adapter.
//
// Claude Code reads `.claude/skills/{name}/SKILL.md` from the consumer repo,
// driven by frontmatter (`description`, plus Claude-specific fields like
// `allowed-tools`, `disable-model-invocation`, `argument-hint`,
// `user-invocable`).
//
// Each canonical skill may ship an optional companion file at
// `src/skills/{name}/SKILL.claude-code.md`. When present, the adapter emits
// the companion verbatim so the skill can carry a Claude-Code-specific
// wrapper (next-action AskUserQuestion menus, argument parsing, etc.)
// without polluting the canonical SKILL.md other adapters consume. When
// absent, the canonical SKILL.md is passed through — preserving the
// pre-companion behavior.
//
// Reference: https://docs.claude.com/en/docs/claude-code/skills

import { AdapterBase } from "../lib/adapter-base.mjs";
import { assertRequiredFields } from "../lib/frontmatter.mjs";

/**
 * @typedef {import("../lib/types.mjs").Skill} Skill
 * @typedef {import("../lib/types.mjs").OutputFile} OutputFile
 */

export class ClaudeCodeAdapter extends AdapterBase {
  static id = "claude-code";

  /**
   * @param {Skill[]} skills
   * @returns {Promise<OutputFile[]>}
   */
  async generate(skills) {
    const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
    return sorted.map((skill) => {
      const canonicalLabel = `src/skills/${skill.name}/SKILL.md`;
      assertRequiredFields(skill.frontmatter, ["name", "description"], canonicalLabel);

      const companion = skill.claudeCodeCompanion;
      if (companion) {
        const label = `src/skills/${skill.name}/SKILL.claude-code.md`;
        assertRequiredFields(companion.frontmatter, ["description"], label);
        return {
          relativePath: `.claude/skills/${skill.name}/SKILL.md`,
          content: companion.raw,
        };
      }

      return {
        relativePath: `.claude/skills/${skill.name}/SKILL.md`,
        content: skill.raw,
      };
    });
  }
}
