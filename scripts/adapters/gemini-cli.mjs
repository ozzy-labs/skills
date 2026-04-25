// Gemini CLI adapter.
//
// Gemini CLI reads `.gemini/settings.json` and follows `context.fileName`
// to the consumer's AGENTS.md, where the skill list lives. This adapter
// emits the settings.json plus the same `AGENTS.md.snippet` body the
// Codex CLI adapter (#11) produces — both adapters share
// scripts/lib/agents-md-snippet.mjs so consumers stay in sync.
//
// Reference: https://github.com/google-gemini/gemini-cli

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
 * Stable JSON serializer — emits keys in insertion order with 2-space
 * indent and a trailing newline, matching what we want committed to dist/.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stableJsonStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export class GeminiCliAdapter extends AdapterBase {
  static id = "gemini-cli";

  /**
   * @param {Skill[]} skills
   * @returns {OutputFile[]}
   */
  generate(skills) {
    const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
    return [
      {
        relativePath: ".gemini/settings.json",
        content: stableJsonStringify(SETTINGS),
      },
      {
        relativePath: "AGENTS.md.snippet",
        content: renderAgentsMdSnippet(sorted),
      },
    ];
  }
}
