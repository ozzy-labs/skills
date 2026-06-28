#!/usr/bin/env node
// obs-emit — append one validated skill-observability event to the local log.
//
// This is the write substrate for the observability stack: the shared,
// fail-open append+validate primitive that every emit path (a future
// artifact-derived SessionEnd hook, or a skill emitting a semantic signal
// inline) calls to record a single event. It does NOT capture anything on its
// own — it only writes what it is told, after validating against the single
// SSOT schema (event.schema.json, its sibling). Nothing here ever runs unless
// explicitly invoked, and any failure is swallowed (fail-open) so observability
// can never break the skill being observed.
//
// Output (append-only, one JSON line per event):
//   ~/.agents/observability/events.jsonl
//
// HOME-anchored with path.join so no rewritable skills-dir path literal appears
// in source (M2): the events log and the credentials-style HOME paths survive
// the dist build's user-scope rewrite intact. The schema, by contrast, is a
// sibling of this file (resolved via import.meta.url) so it travels with the
// skill into every install location.
//
// CLI:
//   node obs-emit.mjs --skill=drive --event=outcome --status=completed
//   node obs-emit.mjs --skill=review --event=signal --name=review.loop_iter --value=2
//   node obs-emit.mjs --skill=drive --event=heartbeat            # "observer ran"
//
// Privacy: events are metadata only. additionalProperties:false in the schema
// rejects any unknown field, and --repo is hashed (never stored raw). Free-form
// payloads, diffs, tokens and paths cannot pass validation.

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Sibling schema = single SSOT consumed by both this emitter and the tests.
export const SCHEMA_PATH = join(__dirname, "event.schema.json");
// HOME-anchored event log, OUTSIDE any skills dir (so the dogfood mirror rebuild
// never wipes it and any consumer can read it), built with path.join so no
// rewritable skills-dir literal appears in source (M2).
export const EVENTS_PATH = join(homedir(), ".agents", "observability", "events.jsonl");

export const SCHEMA_VERSION = 1;
const ADAPTERS = ["claude-code", "codex-cli", "gemini-cli", "copilot"];

/**
 * Resolve the originating adapter (CLI flag → env → default).
 * @param {string|undefined} flag
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveAdapter(flag, env = process.env) {
  const raw = flag ?? env?.OZZY_SKILLS_ADAPTER;
  return raw && String(raw).trim() !== "" ? String(raw).trim() : "claude-code";
}

/**
 * Resolve the host session id (CLI flag → env → "unknown").
 * @param {string|undefined} flag
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveSessionId(flag, env = process.env) {
  const raw = flag ?? env?.CLAUDE_SESSION_ID ?? env?.OZZY_SESSION_ID;
  return raw && String(raw).trim() !== "" ? String(raw).trim() : "unknown";
}

/**
 * Hash a repo identifier (path or name) to a 12-hex-char prefix. Privacy: the
 * raw value never leaves the caller's machine; only the hash is recorded.
 * @param {string} raw
 * @returns {string}
 */
export function hashRepo(raw) {
  return createHash("sha256").update(String(raw)).digest("hex").slice(0, 12);
}

/**
 * Parse `--key=value` / `--flag` argv into a flat object. Bare flags are `true`.
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
export function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq === -1) out[body] = true;
    else out[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return out;
}

/**
 * Build a complete event object from parsed args. Adds the required envelope
 * (schema_version, ts, adapter, session_id) and hashes --repo. Optional fields
 * are included only when provided so validation stays strict.
 * @param {Record<string, string|boolean>} args
 * @param {{ now?: () => Date, env?: NodeJS.ProcessEnv, hashImpl?: (s: string) => string }} [deps]
 * @returns {Record<string, unknown>}
 */
export function buildEvent(args, { now = () => new Date(), env = process.env, hashImpl = hashRepo } = {}) {
  const ev = {
    schema_version: SCHEMA_VERSION,
    ts: now().toISOString(),
    adapter: resolveAdapter(typeof args.adapter === "string" ? args.adapter : undefined, env),
    session_id: resolveSessionId(typeof args.session === "string" ? args.session : undefined, env),
    skill: typeof args.skill === "string" ? args.skill : "unknown",
    event: typeof args.event === "string" ? args.event : "",
  };
  if (typeof args.operation === "string") ev.operation = args.operation;
  if (typeof args.phase === "string") ev.phase = args.phase;
  if (typeof args.status === "string") ev.status = args.status;
  if (typeof args.name === "string") ev.name = args.name;
  if (args.value !== undefined && String(args.value).trim() !== "") {
    const n = Number(args.value);
    if (Number.isFinite(n)) ev.value = n;
  }
  if (typeof args.reason === "string") ev.reason = args.reason;
  if (typeof args.run === "string") ev.run_id = args.run;
  if (typeof args.repo === "string" && args.repo.trim() !== "") ev.repo_hash = hashImpl(args.repo);
  return ev;
}

/**
 * Minimal draft-07-subset validator tailored to event.schema.json. Kept
 * dependency-free (the repo ships no runtime deps) while still treating the
 * schema JSON as the source of truth — it reads required[], enums, const,
 * additionalProperties:false and the allOf/if-then conditionals from the schema
 * object rather than hardcoding them here.
 * @param {Record<string, unknown>} ev
 * @param {Record<string, any>} schema
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateEvent(ev, schema) {
  const errors = [];
  if (ev === null || typeof ev !== "object" || Array.isArray(ev)) {
    return { ok: false, errors: ["event is not an object"] };
  }
  const props = schema.properties ?? {};

  // additionalProperties: false → reject any field absent from the schema.
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(ev)) {
      if (!(key in props)) errors.push(`unknown field '${key}' (additionalProperties:false)`);
    }
  }

  // required
  for (const key of schema.required ?? []) {
    if (ev[key] === undefined) errors.push(`missing required field '${key}'`);
  }

  // per-property: const / enum / type
  for (const [key, spec] of Object.entries(props)) {
    if (ev[key] === undefined) continue;
    const val = ev[key];
    if ("const" in spec && val !== spec.const) {
      errors.push(`field '${key}' must equal ${JSON.stringify(spec.const)}`);
    }
    if (Array.isArray(spec.enum) && !spec.enum.includes(val)) {
      errors.push(`field '${key}'='${val}' not in enum [${spec.enum.join(", ")}]`);
    }
    if (spec.type && !matchesType(val, spec.type)) {
      errors.push(`field '${key}' must be ${spec.type}`);
    }
    if (typeof val === "string" && typeof spec.minLength === "number" && val.length < spec.minLength) {
      errors.push(`field '${key}' shorter than minLength ${spec.minLength}`);
    }
    if (typeof val === "string" && spec.pattern && !new RegExp(spec.pattern).test(val)) {
      errors.push(`field '${key}' does not match pattern ${spec.pattern}`);
    }
  }

  // allOf if-then conditionals (event=outcome → status; event=signal → name)
  for (const clause of schema.allOf ?? []) {
    const cond = clause.if?.properties ?? {};
    const matches = Object.entries(cond).every(([k, spec]) => "const" in spec && ev[k] === spec.const);
    if (matches) {
      for (const key of clause.then?.required ?? []) {
        if (ev[key] === undefined) errors.push(`event implies required field '${key}'`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function matchesType(val, type) {
  if (type === "string") return typeof val === "string";
  if (type === "number") return typeof val === "number" && Number.isFinite(val);
  if (type === "integer") return Number.isInteger(val);
  if (type === "object") return val !== null && typeof val === "object" && !Array.isArray(val);
  return true;
}

/**
 * Load and parse the sibling schema.
 * @param {{ readImpl?: (p: string) => Promise<string>, schemaPath?: string }} [deps]
 * @returns {Promise<Record<string, any>>}
 */
export async function loadSchema({ readImpl = (p) => readFile(p, "utf8"), schemaPath = SCHEMA_PATH } = {}) {
  return JSON.parse(await readImpl(schemaPath));
}

/**
 * Append one validated event as a JSON line. Creates the parent dir if needed.
 * @param {Record<string, unknown>} ev
 * @param {{ eventsPath?: string, mkdirImpl?: (d: string) => Promise<unknown>, appendImpl?: (p: string, s: string) => Promise<unknown> }} [deps]
 * @returns {Promise<void>}
 */
export async function appendEvent(
  ev,
  {
    eventsPath = EVENTS_PATH,
    mkdirImpl = (d) => mkdir(d, { recursive: true }),
    appendImpl = (p, s) => appendFile(p, s),
  } = {},
) {
  await mkdirImpl(dirname(eventsPath));
  await appendImpl(eventsPath, `${JSON.stringify(ev)}\n`);
}

/**
 * Full emit flow: build → validate → append. Returns a structured result for
 * tests; NEVER throws (fail-open) so an emit failure cannot break the caller.
 * @param {string[]} argv
 * @param {object} [deps] dependency injection for tests
 * @returns {Promise<{ ok: boolean, event?: Record<string, unknown>, errors: string[] }>}
 */
export async function run(
  argv,
  {
    now = () => new Date(),
    env = process.env,
    hashImpl = hashRepo,
    loadSchemaImpl = loadSchema,
    appendImpl = appendEvent,
    warn = (msg) => process.stderr.write(`${msg}\n`),
  } = {},
) {
  try {
    const args = parseArgs(argv);
    const ev = buildEvent(args, { now, env, hashImpl });
    const schema = await loadSchemaImpl();
    const { ok, errors } = validateEvent(ev, schema);
    if (!ok) {
      warn(`obs-emit: event rejected (not written): ${errors.join("; ")}`);
      return { ok: false, event: ev, errors };
    }
    await appendImpl(ev);
    return { ok: true, event: ev, errors: [] };
  } catch (err) {
    // Fail-open: observability must never break the observed skill.
    warn(`obs-emit: degraded (event not written): ${err?.message ?? err}`);
    return { ok: false, errors: [String(err?.message ?? err)] };
  }
}

// CLI entry (only when executed directly, not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2)).then((res) => {
    // Always exit 0 (fail-open): a rejected/failed emit must not signal failure
    // to a caller that chained `&&`.
    process.exit(0);
    void res;
  });
}
