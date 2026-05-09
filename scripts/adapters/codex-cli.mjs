// Codex CLI adapter.
//
// Codex CLI reads `AGENTS.md` from the consumer repo and resolves skill
// references to `.agents/skills/{name}/SKILL.md` at runtime. This adapter
// emits both: the canonical SKILL.md files under `.agents/skills/` and an
// `AGENTS.md.snippet` that consumer-side sync scripts merge into the
// repo's hand-edited AGENTS.md.
//
// Skills may ship non-SKILL.* extra files (e.g. `perspectives/<axis>.md`
// under the review skill — ADR-0025). These are copied verbatim under each
// skill's `.agents/skills/{name}/` directory.

import { AdapterBase } from "../lib/adapter-base.mjs";
import { renderAgentsMdSnippet } from "../lib/agents-md-snippet.mjs";
import { assertRequiredFields } from "../lib/frontmatter.mjs";

/**
 * @typedef {import("../lib/types.mjs").Skill} Skill
 * @typedef {import("../lib/types.mjs").OutputFile} OutputFile
 * @typedef {import("../lib/types.mjs").GenerateOptions} GenerateOptions
 */

export class CodexCliAdapter extends AdapterBase {
  static id = "codex-cli";

  /**
   * @param {Skill[]} skills
   * @param {GenerateOptions} [_options]
   * @returns {Promise<OutputFile[]>}
   */
  async generate(skills, _options = {}) {
    const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
    const outputs = [];
    for (const skill of sorted) {
      const label = `src/skills/${skill.name}/SKILL.md`;
      assertRequiredFields(skill.frontmatter, ["name", "description"], label);
      outputs.push({
        relativePath: `.agents/skills/${skill.name}/SKILL.md`,
        content: skill.raw,
      });
      for (const extra of skill.extraFiles ?? []) {
        outputs.push({
          relativePath: `.agents/skills/${skill.name}/${extra.relativePath}`,
          content: extra.content,
        });
      }
    }
    outputs.push({
      relativePath: "AGENTS.md.snippet",
      content: renderAgentsMdSnippet(sorted),
    });
    return outputs;
  }
}
