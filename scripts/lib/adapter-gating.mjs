// Per-skill adapter gating.
//
// A skill may restrict which adapters emit it via a frontmatter `adapters`
// field. The SKILL.md frontmatter parser is a flat, string-only subset of
// YAML (no arrays — see frontmatter.mjs), so `adapters` is a COMMA-SEPARATED
// string, not a YAML array:
//
//   adapters: claude-code
//   adapters: claude-code, codex-cli
//
// When the field is absent, the skill is emitted by every adapter (the
// default — preserves pre-gating behavior). An id outside the known set is a
// build error so typos fail loudly.
//
// This is the per-skill counterpart of `src/agents/` being Claude Code only
// (ADR-0026): some skills depend on a single agent's runtime (e.g.
// `usage-guard` needs Claude Code's OAuth token + ScheduleWakeup) and must
// not ship to adapters that cannot run them.

export const KNOWN_ADAPTER_IDS = ["claude-code", "codex-cli", "gemini-cli", "copilot"];

/**
 * Parse the `adapters` frontmatter value into a normalized id list.
 *
 * @param {Record<string, string>} frontmatter
 * @param {string} fileLabel  Path used in error messages.
 * @returns {string[] | null}  The allowed adapter ids, or null when the field
 *   is absent/empty (no restriction).
 */
export function parseAdapters(frontmatter, fileLabel) {
  const raw = frontmatter?.adapters;
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const ids = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return null;
  for (const id of ids) {
    if (!KNOWN_ADAPTER_IDS.includes(id)) {
      throw new Error(
        `${fileLabel}: unknown adapter id '${id}' in 'adapters' (known: ${KNOWN_ADAPTER_IDS.join(", ")})`,
      );
    }
  }
  return ids;
}

/**
 * The allowed adapter ids for a skill (null = no restriction).
 *
 * Prefers a precomputed `skill.adapters` (set once at load time in build.mjs);
 * falls back to parsing `skill.frontmatter` so the helper also works on skill
 * objects constructed directly in tests.
 *
 * @param {{ name?: string, adapters?: string[] | null, frontmatter?: Record<string, string> }} skill
 * @returns {string[] | null}
 */
export function skillAdapterIds(skill) {
  if (skill.adapters !== undefined) return skill.adapters;
  return parseAdapters(skill.frontmatter ?? {}, `skill '${skill.name ?? "<unknown>"}'`);
}

/**
 * Whether a skill should be emitted for the given adapter id. Skills without
 * an `adapters` restriction are allowed everywhere.
 *
 * @param {object} skill
 * @param {string} adapterId
 * @returns {boolean}
 */
export function isAdapterAllowed(skill, adapterId) {
  const ids = skillAdapterIds(skill);
  return ids === null || ids.includes(adapterId);
}

/**
 * Filter a skill list down to those an adapter is allowed to emit.
 *
 * Called at the top of every adapter's `generate()` so gating applies
 * uniformly to per-skill outputs (Claude Code `.claude/skills/`, Codex CLI
 * `.agents/skills/`) and to aggregate listings (Gemini CLI / Copilot
 * snippets). Because the build orchestrator routes both `writeAdapterOutputs`
 * and `writeProjectScopeOutput` through `generate()`, gating here covers both
 * paths — there is no separate gate to keep in sync.
 *
 * @template {object} S
 * @param {S[]} skills
 * @param {string} adapterId
 * @returns {S[]}
 */
export function filterSkillsForAdapter(skills, adapterId) {
  return skills.filter((s) => isAdapterAllowed(s, adapterId));
}
