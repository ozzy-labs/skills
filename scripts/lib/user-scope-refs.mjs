// Rewrite repo-root-relative skill references to user-scope paths.
//
// dist/{adapter-id}/ payloads are installed under $HOME by the CLI installer
// (handbook ADR-0027: user-skills-only distribution). Repo-root-relative
// references like `.agents/skills/<name>/SKILL.md` resolve against the
// consumer's CWD at runtime and break in repos that do not carry project
// skills — the post-migrate norm. Installed copies must therefore reference
// `~/.agents/skills/...` / `~/.claude/skills/...` instead.
//
// The in-repo dogfood mirrors (`.agents/skills/`, `.claude/skills/`) keep the
// relative form — they resolve correctly against the skills/commons repo
// root — so the build orchestrator applies this transform only when writing
// dist/ outputs (adapters stay verbatim; see tests/build-pipeline.test.mjs).
//
// The pattern intentionally skips:
//   - already-rewritten refs (`~/.agents/skills/...`)
//   - refs embedded in longer paths (`dist/claude-code/.claude/skills/...`)
//   - other dot-dirs (`.claude/worktrees/...`, `.claude/agents/...`)

const SKILL_REF = /(^|[^\w/~.])(\.(?:agents|claude)\/skills\/)/gm;

/**
 * @param {string} content
 * @returns {string}
 */
export function rewriteSkillRefsToUserScope(content) {
  return content.replace(SKILL_REF, "$1~/$2");
}
