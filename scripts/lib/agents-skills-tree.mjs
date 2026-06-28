// Shared `.agents/skills/` tree renderer.
//
// `.agents/skills/{name}/SKILL.md` (+ non-SKILL extra assets) is the cross-tool
// open-standard artifact that Codex CLI, Gemini CLI, and GitHub Copilot CLI all
// read natively. Each of those adapters emits the SAME tree (differing only in
// their AGENTS.md / instructions aggregation), so the tree is rendered here once.

import { assertRequiredFields, stripBuildControlFrontmatter } from "./frontmatter.mjs";

/**
 * @typedef {import("./types.mjs").Skill} Skill
 * @typedef {import("./types.mjs").OutputFile} OutputFile
 */

/**
 * Render the canonical `.agents/skills/` payload for an already-gated, sorted
 * skill list: the canonical SKILL.md plus any extra assets (e.g.
 * `perspectives/<axis>.md`) copied verbatim under each skill directory.
 *
 * @param {Skill[]} skills  Gated + sorted skills.
 * @returns {OutputFile[]}
 */
export function renderAgentsSkillsTree(skills) {
  const outputs = [];
  for (const skill of skills) {
    assertRequiredFields(
      skill.frontmatter,
      ["name", "description"],
      `.agents/skills/${skill.name}/SKILL.md`,
    );
    outputs.push({
      relativePath: `.agents/skills/${skill.name}/SKILL.md`,
      content: stripBuildControlFrontmatter(
        skill.raw,
        `.agents/skills/${skill.name}/SKILL.md`,
      ),
    });
    for (const extra of skill.extraFiles ?? []) {
      outputs.push({
        relativePath: `.agents/skills/${skill.name}/${extra.relativePath}`,
        content: extra.content,
      });
    }
  }
  return outputs;
}
