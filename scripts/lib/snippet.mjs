// `.snippet` marker helpers.
//
// Adapters that emit content meant to be merged into a consumer-owned file
// (AGENTS.md, copilot-instructions.md) wrap their payload with begin/end
// markers so consumer-side sync scripts can replace just the managed region.

const MARKER_TAG = "@ozzylabs/skills";

export const SNIPPET_BEGIN = `<!-- begin: ${MARKER_TAG} -->`;
export const SNIPPET_END = `<!-- end: ${MARKER_TAG} -->`;

/**
 * Wrap a body string with begin/end markers.
 *
 * The marker block is emitted with one blank line after the begin marker and
 * one blank line before the end marker so the output is idempotent under
 * Prettier's Markdown formatter (which inserts those blank lines around
 * HTML-block comments). Without this, consumers running Prettier on a
 * synced snippet would re-format on every sync, oscillating with the next
 * sync's overwrite.
 *
 * @param {string} body
 * @returns {string}
 */
export function wrapSnippet(body) {
  const trimmed = body.replace(/\n+$/, "");
  return `${SNIPPET_BEGIN}\n\n${trimmed}\n\n${SNIPPET_END}\n`;
}
