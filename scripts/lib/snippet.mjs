// `.snippet` marker helpers.
//
// Adapters that emit content meant to be merged into a consumer-owned file
// (AGENTS.md, copilot-instructions.md) wrap their payload with begin/end
// markers so consumer-side sync scripts can replace just the managed region.

const MARKER_TAG = "@ozzylabs/skills";

export const SNIPPET_BEGIN = `<!-- begin: ${MARKER_TAG} -->`;
export const SNIPPET_END = `<!-- end: ${MARKER_TAG} -->`;

/**
 * Wrap a body string with begin/end markers, ensuring exactly one trailing
 * newline so the snippet concatenates cleanly with neighboring content.
 *
 * @param {string} body
 * @returns {string}
 */
export function wrapSnippet(body) {
  const trimmed = body.replace(/\n+$/, "");
  return `${SNIPPET_BEGIN}\n${trimmed}\n${SNIPPET_END}\n`;
}
