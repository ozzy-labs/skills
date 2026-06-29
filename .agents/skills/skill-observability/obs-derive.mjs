#!/usr/bin/env node
// obs-derive — artifact-derived capture hook (SessionEnd) for skill observability.
//
// This is the PRIMARY capture path: it reconstructs which skills ran in a
// session by reading the session transcript after the fact, rather than asking
// the model to self-report mid-run. Artifact derivation avoids the self-report
// bias where the worst runs (the ones that abort) are the least likely to emit.
//
// Wired as a Claude Code SessionEnd hook (manual opt-in — the repo ships no
// settings/hooks; see the skill's SKILL.md "SessionEnd hook を有効化"). The hook
// receives the SessionEnd event JSON on stdin (keys: session_id, transcript_path,
// cwd, reason — the same contract the dotfiles lesson-capture.sh consumes) and
// appends derived events to ~/.agents/observability/events.jsonl through the
// obs-emit substrate (shared build→validate→append path, no duplication).
//
// What it derives (the RELIABLE core):
//   - one `heartbeat` per session — records "the observer ran", so an empty
//     window reads as "0 invocations" and NOT as "the hook never fired".
//   - one `start` per skill invocation found in the transcript, via two channels:
//       * model-invoked Skill tool_use  → operation: "invoke_agent"
//       * user-typed /slash-command     → operation: "slash_command"
//
// What it deliberately does NOT derive (deferred — see SKILL.md): merge/abort
// OUTCOME. Session-end merge state is unconfirmed and needs a session→PR linkage
// plus deferred re-evaluation; abort-inference ("ended without a PR") is noisy
// (human interruption / idempotent resume look identical). Those are a separate
// increment so this hook stays reliable and low-noise.
//
// Always exits 0 and never throws (fail-open): capturing observability must not
// block session teardown. Lightweight: lines are substring-prefiltered before
// any JSON.parse to stay within the SessionEnd timeout budget.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, buildEvent, loadSchema, validateEvent } from "./obs-emit.mjs";

const SLASH_RE = /<command-name>\/?([a-z][a-z0-9-]*)<\/command-name>/;

// This file ships at <skills-root>/skill-observability/obs-derive.mjs, so the
// skills root is its grandparent dir. A user-typed /slash-command counts as a
// skill invocation only if a sibling skill dir exists — this filters out
// built-in commands (/clear, /compact, /config, /help, …) that would otherwise
// pollute the data. Model-invoked Skill tool_uses need no such filter (the Skill
// tool only ever invokes real skills).
const SKILLS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Default predicate: a slash command names a real skill iff a sibling skill dir
 * with a SKILL.md exists under the skills root.
 * @param {string} name
 * @returns {boolean}
 */
export function isInstalledSkill(name) {
  return existsSync(join(SKILLS_ROOT, name, "SKILL.md"));
}

/**
 * Extract the plain text of a transcript message's content (string or block array).
 * @param {unknown} content
 * @returns {string}
 */
function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}

/**
 * Derive skill invocations from a raw transcript (JSONL string). Pure +
 * dependency-free so it is unit-testable without any I/O. Lines are
 * substring-prefiltered so only the few relevant lines are JSON-parsed.
 * @param {string} text
 * @returns {Array<{ skill: string, operation: string }>}
 */
export function parseTranscript(text) {
  const invocations = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const hasSkill = line.includes('"Skill"');
    const hasSlash = line.includes("command-name");
    if (!hasSkill && !hasSlash) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = obj && typeof obj.message === "object" ? obj.message : null;
    const content = msg ? msg.content : null;
    // Channel 1: model-invoked Skill tool_use.
    if (hasSkill && Array.isArray(content)) {
      for (const b of content) {
        if (b && typeof b === "object" && b.type === "tool_use" && b.name === "Skill") {
          const skill = b.input && typeof b.input.skill === "string" ? b.input.skill : null;
          if (skill) invocations.push({ skill, operation: "invoke_agent" });
        }
      }
    }
    // Channel 2: user-typed slash command.
    if (hasSlash) {
      const m = SLASH_RE.exec(contentText(content));
      if (m) invocations.push({ skill: m[1], operation: "slash_command" });
    }
  }
  return invocations;
}

/**
 * Build the derived event list (one heartbeat + one start per invocation).
 * Events are built through obs-emit's buildEvent so they share the exact
 * envelope and pass the same schema. Skill args are intentionally never
 * included — only the skill name and the channel (operation).
 * @param {Array<{ skill: string, operation: string }>} invocations
 * @param {{ sessionId?: string, adapter?: string, now?: () => Date, env?: NodeJS.ProcessEnv }} [deps]
 * @returns {Array<Record<string, unknown>>}
 */
export function deriveEvents(invocations, { sessionId, adapter = "claude-code", now, env } = {}) {
  const common = { session: sessionId, adapter };
  const opts = { now, env };
  const events = [
    buildEvent({ skill: "skill-observability", event: "heartbeat", operation: "derive", ...common }, opts),
  ];
  for (const inv of invocations) {
    events.push(
      buildEvent({ skill: inv.skill, event: "start", operation: inv.operation, ...common }, opts),
    );
  }
  return events;
}

/**
 * Read all of stdin as a string.
 * @returns {Promise<string>}
 */
export function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

/**
 * Full derive flow: read SessionEnd stdin → read transcript → derive → append.
 * NEVER throws (fail-open). Returns a structured result for tests.
 * @param {object} [deps] dependency injection
 * @returns {Promise<{ ok: boolean, appended: number, errors: string[] }>}
 */
export async function run({
  readStdinImpl = readStdin,
  readTranscriptImpl = (p) => readFile(p, "utf8"),
  loadSchemaImpl = loadSchema,
  appendImpl = appendEvent,
  isSkillImpl = isInstalledSkill,
  now = () => new Date(),
  env = process.env,
  warn = (msg) => process.stderr.write(`${msg}\n`),
} = {}) {
  const errors = [];
  let appended = 0;
  try {
    let session = {};
    try {
      session = JSON.parse((await readStdinImpl()) || "{}");
    } catch {
      session = {};
    }
    const sessionId = typeof session.session_id === "string" ? session.session_id : undefined;
    const transcriptPath =
      typeof session.transcript_path === "string" ? session.transcript_path : null;

    let invocations = [];
    if (transcriptPath) {
      try {
        // Keep model-invoked Skill uses; for user-typed slash commands keep only
        // those that name a real installed skill (drop built-ins like /clear).
        invocations = parseTranscript(await readTranscriptImpl(transcriptPath)).filter(
          (inv) => inv.operation !== "slash_command" || isSkillImpl(inv.skill),
        );
      } catch (err) {
        // Transcript unreadable/expired → still emit the heartbeat below so the
        // session is recorded as observed-with-no-derivable-data.
        warn(`obs-derive: transcript unreadable (${err?.message ?? err}); heartbeat only`);
      }
    }

    const events = deriveEvents(invocations, { sessionId, now, env });
    const schema = await loadSchemaImpl();
    for (const ev of events) {
      const { ok, errors: ve } = validateEvent(ev, schema);
      if (!ok) {
        errors.push(...ve);
        continue;
      }
      await appendImpl(ev);
      appended += 1;
    }
    return { ok: errors.length === 0, appended, errors };
  } catch (err) {
    warn(`obs-derive: degraded (${err?.message ?? err})`);
    return { ok: false, appended, errors: [String(err?.message ?? err)] };
  }
}

// CLI entry (SessionEnd hook). Always exit 0 (fail-open): observability must not
// block session teardown.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().then(() => process.exit(0));
}
