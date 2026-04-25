// Claude Code adapter.
//
// Claude Code reads `.claude/skills/{name}/SKILL.md` from the consumer repo,
// driven by frontmatter (`name`, `description`, plus Claude-specific fields
// like `allowed-tools`, `disable-model-invocation`, `argument-hint`). This
// adapter passes the canonical SKILL.md through unchanged — the canonical
// frontmatter is already a superset of what Claude Code requires.
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
   * @returns {OutputFile[]}
   */
  generate(skills) {
    const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
    return sorted.map((skill) => {
      const label = `src/skills/${skill.name}/SKILL.md`;
      assertRequiredFields(skill.frontmatter, ["name", "description"], label);
      return {
        relativePath: `.claude/skills/${skill.name}/SKILL.md`,
        content: skill.raw,
      };
    });
  }
}
