// Frontmatter parse / serialize helpers.
//
// SKILL.md frontmatter is a tiny subset of YAML — `key: value` pairs only,
// no nesting, no arrays. Keep the parser small and deterministic.

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;

/**
 * Parse a SKILL.md document.
 *
 * @param {string} text       File contents.
 * @param {string} fileLabel  Path used in error messages.
 * @returns {{ frontmatter: Record<string, string>, body: string }}
 */
export function parseSkillDocument(text, fileLabel) {
  const match = text.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(`${fileLabel}: missing frontmatter (--- ... ---)`);
  }
  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) frontmatter[key] = value;
  }
  const body = text.slice(match[0].length);
  return { frontmatter, body };
}

/**
 * Serialize frontmatter back to a `--- ... ---` block.
 *
 * Keys are emitted in insertion order so callers control determinism by
 * controlling the order they pass keys in.
 *
 * @param {Record<string, string>} frontmatter
 * @returns {string}
 */
export function serializeFrontmatter(frontmatter) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

/**
 * Validate required frontmatter fields.
 *
 * @param {Record<string, string>} frontmatter
 * @param {string[]} required
 * @param {string} fileLabel
 */
export function assertRequiredFields(frontmatter, required, fileLabel) {
  for (const field of required) {
    if (!frontmatter[field]) {
      throw new Error(`${fileLabel}: frontmatter missing required field '${field}'`);
    }
  }
}
