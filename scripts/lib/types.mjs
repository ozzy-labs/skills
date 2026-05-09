// Shared type definitions for the adapter pipeline.
//
// Adapters take a list of canonical Skill objects (and optional Claude Code
// agents) and return OutputFile[]. File system writes are performed by the
// build orchestrator only — adapters are pure functions.

/**
 * A canonical skill loaded from `src/skills/{name}/SKILL.md`.
 *
 * @typedef {object} Skill
 * @property {string} name           Skill identifier (matches directory name).
 * @property {string} description    One-line description from frontmatter.
 * @property {Record<string, string>} frontmatter  Full parsed frontmatter map.
 * @property {string} body           SKILL.md content with frontmatter stripped.
 * @property {string} raw            Full SKILL.md content (frontmatter + body).
 * @property {SkillCompanion | null} [claudeCodeCompanion]
 *     Optional Claude Code companion (`SKILL.claude-code.md`). When present,
 *     the Claude Code adapter emits this content instead of the canonical
 *     SKILL.md so each skill can ship a Claude-Code-specific wrapper
 *     (frontmatter fields like `disable-model-invocation`, `allowed-tools`,
 *     `argument-hint`, plus AskUserQuestion-driven UX). Other adapters
 *     ignore this field.
 * @property {SkillExtraFile[]} [extraFiles]
 *     Auxiliary files under `src/skills/{name}/` that are NOT the canonical
 *     SKILL.md or any adapter companion (`SKILL.<adapter>.md`). Examples:
 *     `perspectives/<axis>.md` for the review skill (ADR-0025). Adapters
 *     that emit a per-skill directory (Claude Code, Codex CLI) copy these
 *     verbatim under the same relative path.
 */

/**
 * A non-SKILL.* file that ships alongside a skill (e.g.
 * `perspectives/<axis>.md` under the review skill).
 *
 * @typedef {object} SkillExtraFile
 * @property {string} relativePath   Path relative to the skill directory.
 * @property {string} content        File content (UTF-8).
 */

/**
 * A Claude Code agent loaded from `src/agents/{name}.md`.
 *
 * Only the Claude Code adapter consumes agents — agent concept does not
 * exist in Codex CLI / Gemini CLI / GitHub Copilot, so other adapters
 * ignore the agents collection entirely (ADR-0026).
 *
 * @typedef {object} Agent
 * @property {string} name           Agent identifier (matches file name).
 * @property {Record<string, string>} frontmatter  Parsed frontmatter map.
 * @property {string} body           Agent file content with frontmatter stripped.
 * @property {string} raw            Full agent file content.
 */

/**
 * Adapter-specific companion file loaded from
 * `src/skills/{name}/SKILL.{adapter}.md`.
 *
 * @typedef {object} SkillCompanion
 * @property {Record<string, string>} frontmatter
 * @property {string} body
 * @property {string} raw
 */

/**
 * Options passed to `AdapterBase.generate(skills, options)`.
 *
 * @typedef {object} GenerateOptions
 * @property {Agent[]} [agents]   Claude Code agents (only used by ClaudeCodeAdapter).
 */

/**
 * One file emitted by an adapter, relative to the adapter's dist root.
 *
 * @typedef {object} OutputFile
 * @property {string} relativePath   Path under `dist/{adapter}/`.
 * @property {string} content        File content (UTF-8).
 */

export {};
