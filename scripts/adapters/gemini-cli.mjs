// Gemini CLI adapter.
//
// Gemini CLI reads Agent Skills natively from `.agents/skills/` (preferred over
// `.gemini/skills/` for cross-tool interop), so this adapter ships the same
// canonical `.agents/skills/` tree as Codex. It also emits `.gemini/settings.json`
// (pointing `context.fileName` at AGENTS.md) and the shared `AGENTS.md.snippet`
// human-readable index (identical to the Codex adapter's, via
// scripts/lib/agents-md-snippet.mjs).
//
// Reference: https://github.com/google-gemini/gemini-cli

import prettier from "prettier";
import { AdapterBase } from "../lib/adapter-base.mjs";
import { filterSkillsForAdapter } from "../lib/adapter-gating.mjs";
import { renderAgentsMdSnippet } from "../lib/agents-md-snippet.mjs";
import { renderAgentsSkillsTree } from "../lib/agents-skills-tree.mjs";

/**
 * @typedef {import("../lib/types.mjs").Skill} Skill
 * @typedef {import("../lib/types.mjs").OutputFile} OutputFile
 */

const SETTINGS = {
  context: {
    fileName: ["AGENTS.md"],
  },
};

/**
 * JSON serializer whose output is Prettier-idempotent — `JSON.stringify`'s
 * default formatter splits every array/object onto multiple lines, which
 * collides with Prettier/Biome's "collapse short arrays" policy and causes
 * sync oscillation in downstream repos (skills#35). Routing through
 * `prettier.format` produces the exact bytes Prettier and Biome would emit,
 * so consumers can run their formatters over `dist/` without drift.
 *
 * @param {unknown} value
 * @returns {Promise<string>}
 */
async function stableJsonStringify(value) {
  return prettier.format(JSON.stringify(value), { parser: "json" });
}

export class GeminiCliAdapter extends AdapterBase {
  static id = "gemini-cli";

  /**
   * @param {Skill[]} skills
   * @returns {Promise<OutputFile[]>}
   */
  async generate(skills) {
    const allowed = filterSkillsForAdapter(skills, GeminiCliAdapter.id);
    const sorted = [...allowed].sort((a, b) => a.name.localeCompare(b.name));
    return [
      ...renderAgentsSkillsTree(sorted),
      {
        relativePath: ".gemini/settings.json",
        content: await stableJsonStringify(SETTINGS),
      },
      {
        relativePath: "AGENTS.md.snippet",
        content: renderAgentsMdSnippet(sorted),
      },
    ];
  }
}
