// Shared `AGENTS.md` snippet generator.
//
// Codex CLI and Gemini CLI both read `AGENTS.md` (Gemini via the
// `.gemini/settings.json` `context.fileName` indirection). Both adapters
// emit the same skill-list snippet, so the rendering lives here.
//
// The output is wrapped with `<!-- begin/end: @ozzylabs/skills -->` markers
// so consumer-side sync scripts can replace just the managed region of an
// otherwise hand-edited AGENTS.md.

import { wrapSnippet } from "./snippet.mjs";

/**
 * @typedef {import("./types.mjs").Skill} Skill
 */

/**
 * Render the `AGENTS.md` skill-list snippet.
 *
 * @param {Skill[]} skills  Skills are sorted by name internally for determinism.
 * @returns {string}        Snippet body wrapped with begin/end markers.
 */
export function renderAgentsMdSnippet(skills) {
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  const lines = ["## Available Skills", ""];
  for (const skill of sorted) {
    lines.push(`- \`${skill.name}\` — ${skill.description}`);
  }
  return wrapSnippet(lines.join("\n"));
}
