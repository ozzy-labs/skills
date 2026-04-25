// Codex CLI adapter.
//
// Codex CLI reads `AGENTS.md` from the consumer repo and resolves skill
// references to `.agents/skills/{name}/SKILL.md` at runtime. This adapter
// emits both: the canonical SKILL.md files under `.agents/skills/` and an
// `AGENTS.md.snippet` that consumer-side sync scripts merge into the
// repo's hand-edited AGENTS.md.

import { AdapterBase } from "../lib/adapter-base.mjs";
import { renderAgentsMdSnippet } from "../lib/agents-md-snippet.mjs";
import { assertRequiredFields } from "../lib/frontmatter.mjs";

/**
 * @typedef {import("../lib/types.mjs").Skill} Skill
 * @typedef {import("../lib/types.mjs").OutputFile} OutputFile
 */

export class CodexCliAdapter extends AdapterBase {
  static id = "codex-cli";

  /**
   * @param {Skill[]} skills
   * @returns {OutputFile[]}
   */
  generate(skills) {
    const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
    const outputs = sorted.map((skill) => {
      const label = `src/skills/${skill.name}/SKILL.md`;
      assertRequiredFields(skill.frontmatter, ["name", "description"], label);
      return {
        relativePath: `.agents/skills/${skill.name}/SKILL.md`,
        content: skill.raw,
      };
    });
    outputs.push({
      relativePath: "AGENTS.md.snippet",
      content: renderAgentsMdSnippet(sorted),
    });
    return outputs;
  }
}
