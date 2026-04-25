// GitHub Copilot adapter.
//
// GitHub Copilot reads `.github/copilot-instructions.md` from the consumer
// repo. It does not load SKILL.md files directly, so this adapter emits a
// single snippet that lists each canonical skill (name + description) for
// Copilot to consume. The consumer's sync script merges the snippet into
// the hand-edited copilot-instructions.md by replacing the marker block.
//
// Reference: https://docs.github.com/en/copilot/customizing-copilot

import { AdapterBase } from "../lib/adapter-base.mjs";
import { wrapSnippet } from "../lib/snippet.mjs";

/**
 * @typedef {import("../lib/types.mjs").Skill} Skill
 * @typedef {import("../lib/types.mjs").OutputFile} OutputFile
 */

/**
 * @param {Skill[]} skills
 * @returns {string}
 */
function renderCopilotSnippet(skills) {
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  const lines = ["## Available Skills", ""];
  for (const skill of sorted) {
    lines.push(`- \`${skill.name}\` — ${skill.description}`);
  }
  return wrapSnippet(lines.join("\n"));
}

export class CopilotAdapter extends AdapterBase {
  static id = "copilot";

  /**
   * @param {Skill[]} skills
   * @returns {OutputFile[]}
   */
  generate(skills) {
    return [
      {
        relativePath: ".github/copilot-instructions.md.snippet",
        content: renderCopilotSnippet(skills),
      },
    ];
  }
}
