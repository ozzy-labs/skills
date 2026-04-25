// Shared type definitions for the adapter pipeline.
//
// Adapters take a list of canonical Skill objects and return OutputFile[].
// File system writes are performed by the build orchestrator only — adapters
// are pure functions.

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
 * One file emitted by an adapter, relative to the adapter's dist root.
 *
 * @typedef {object} OutputFile
 * @property {string} relativePath   Path under `dist/{adapter}/`.
 * @property {string} content        File content (UTF-8).
 */

export {};
