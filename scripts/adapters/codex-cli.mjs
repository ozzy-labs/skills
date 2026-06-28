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
import { filterSkillsForAdapter } from "../lib/adapter-gating.mjs";
import { renderAgentsMdSnippet } from "../lib/agents-md-snippet.mjs";
import { renderAgentsSkillsTree } from "../lib/agents-skills-tree.mjs";

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
    const allowed = filterSkillsForAdapter(skills, CodexCliAdapter.id);
    const sorted = [...allowed].sort((a, b) => a.name.localeCompare(b.name));
    return [
      ...renderAgentsSkillsTree(sorted),
      { relativePath: "AGENTS.md.snippet", content: renderAgentsMdSnippet(sorted) },
    ];
  }
}
