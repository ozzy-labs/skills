// Gemini CLI adapter.
//
// Gemini CLI reads `.gemini/settings.json` and follows `context.fileName`
// to the consumer's AGENTS.md, where the skill list lives. This adapter
// emits the settings.json plus the same `AGENTS.md.snippet` body the
// Codex CLI adapter (#11) produces — both adapters share
// scripts/lib/agents-md-snippet.mjs so consumers stay in sync.
//
// Reference: https://github.com/google-gemini/gemini-cli

import prettier from "prettier";
import { AdapterBase } from "../lib/adapter-base.mjs";
import { renderAgentsMdSnippet } from "../lib/agents-md-snippet.mjs";

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
    const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
    return [
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
