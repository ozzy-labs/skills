#!/usr/bin/env node
// policy-read — resolve the effective central autonomy policy (ADR-0028 R3).
//
// This is the all-adapter read substrate for the policy stack: it reads the
// two-level policy.yaml hierarchy (user default + repo override), merges them,
// and prints the merged EFFECTIVE policy as JSON on stdout. Skills call it to
// learn "for the action I am about to take, what gate applies?" — proceed
// (do it + audit trail), batch-confirm (one bulk confirmation), or ask (an
// Approval Gate). Nothing here mutates anything; it only reads and reports.
//
//   ~/.agents/policy.yaml    user default (HOME-anchored)
//   <repo>/.agents/policy.yaml   repo override (wins over user)
//
// Zero-config (no files) returns defaults equivalent to today's behavior:
//   reversible-local  = proceed
//   externally-visible = batch-confirm
//   irreversible       = ask
//
// fail-SAFE (NOT fail-open): unlike observability, a broken/hostile policy must
// never LOOSEN autonomy. So this tool never throws, but any value it cannot
// trust degrades to the STRICT side (`ask`):
//   - an invalid gate token (schema mismatch) for a class/action -> ask
//   - an unparseable policy file            -> that file is ignored + degraded flag;
//                                              the remaining file + defaults still apply
//                                              (dangerous-class default is already ask)
//
// HOME-anchored with path.join so no rewritable skills-dir literal appears in
// source: the user policy path survives the dist user-scope rewrite intact.
// The repo policy path is resolved against --repo-root / cwd. The schema is a
// sibling (import.meta.url) so it travels with the skill into every install.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Sibling schema = single SSOT consumed by both this reader and the tests.
export const SCHEMA_PATH = join(__dirname, "policy.schema.json");
// HOME-anchored user policy, built with path.join so no rewritable literal
// appears in source (the dist build's user-scope rewrite only targets
// `.agents/skills/` refs, never `.agents/policy.yaml`).
export const USER_POLICY_PATH = join(homedir(), ".agents", "policy.yaml");

export const SCHEMA_VERSION = 1;
export const GATES = ["proceed", "batch-confirm", "ask"];
export const CLASSES = ["reversible-local", "externally-visible", "irreversible"];
// Fail-safe: any value we cannot trust collapses to the strictest gate.
export const FAIL_SAFE_GATE = "ask";
// Zero-config defaults == today's behavior (the R3 acceptance condition).
export const ZERO_CONFIG_CLASS_DEFAULTS = Object.freeze({
  "reversible-local": "proceed",
  "externally-visible": "batch-confirm",
  irreversible: "ask",
});
// Known action -> class map so `--action=merge` resolves without an explicit
// `--class`. Names are illustrative of the ADR examples; unknown actions still
// resolve via an explicit `--class` (or fall back to the strict gate).
export const ACTION_CLASSES = Object.freeze({
  "branch-edit": "reversible-local",
  "branch-delete": "reversible-local",
  "worktree-prune": "reversible-local",
  "issue-create": "externally-visible",
  "pr-create": "externally-visible",
  "pr-comment": "externally-visible",
  "topics-apply": "externally-visible",
  merge: "irreversible",
  publish: "irreversible",
  "stash-drop": "irreversible",
  "force-push": "irreversible",
});

/**
 * Resolve the repo-scoped policy path from a repo root (default: cwd).
 * @param {string} [repoRoot]
 * @returns {string}
 */
export function repoPolicyPath(repoRoot = process.cwd()) {
  return join(repoRoot, ".agents", "policy.yaml");
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
 * Parse a minimal YAML subset sufficient for policy.yaml: nested mappings
 * (2-space indentation), `key: value` scalars, `#` comments and blank lines.
 * No sequences/anchors/multiline — the repo ships no YAML runtime dep, and the
 * policy shape is intentionally a shallow map of maps. Throws on structural
 * errors (bad indentation, duplicate key, sequence) so callers can fail-safe.
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseYaml(text) {
  const root = {};
  // Stack of { indent, container } frames; the container at index 0 is root.
  const stack = [{ indent: -1, container: root }];

  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  for (let n = 0; n < lines.length; n += 1) {
    const rawLine = lines[n];
    // Strip a full-line or trailing comment. Values here never contain '#'.
    const noComment = rawLine.replace(/(^|\s)#.*$/, "$1");
    if (noComment.trim() === "") continue;

    const indent = noComment.length - noComment.trimStart().length;
    const content = noComment.trim();

    if (content.startsWith("- ")) {
      throw new Error(`line ${n + 1}: sequences are not supported in policy.yaml`);
    }
    const colon = content.indexOf(":");
    if (colon === -1) {
      throw new Error(`line ${n + 1}: expected 'key: value' but got '${content}'`);
    }

    // Pop frames until we find the parent whose indent is strictly less.
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].container;
    if (parent === null || typeof parent !== "object") {
      throw new Error(`line ${n + 1}: cannot nest under a scalar value`);
    }

    const key = content.slice(0, colon).trim();
    const rest = content.slice(colon + 1).trim();
    if (key === "") throw new Error(`line ${n + 1}: empty key`);
    if (Object.prototype.hasOwnProperty.call(parent, key)) {
      throw new Error(`line ${n + 1}: duplicate key '${key}'`);
    }

    if (rest === "") {
      // Mapping start: push a fresh child container.
      const child = {};
      parent[key] = child;
      stack.push({ indent, container: child });
    } else {
      parent[key] = parseScalar(rest);
    }
  }
  return root;
}

/**
 * Parse a YAML scalar into number / boolean / string. Quotes are stripped.
 * @param {string} raw
 * @returns {number|boolean|string}
 */
export function parseScalar(raw) {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~") return null;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d*\.\d+$/.test(raw)) return Number(raw);
  return raw;
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
 * Minimal draft-07-subset validator tailored to policy.schema.json. Kept
 * dependency-free while treating the schema JSON as the source of truth: it
 * reads type / const / enum / pattern / required / properties /
 * additionalProperties (boolean OR sub-schema) / propertyNames recursively.
 * @param {unknown} value
 * @param {Record<string, any>} schema
 * @param {string} [path]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validatePolicy(value, schema, path = "$") {
  const errors = [];
  validateNode(value, schema, path, errors);
  return { ok: errors.length === 0, errors };
}

function validateNode(value, schema, path, errors) {
  if (!schema || typeof schema !== "object") return;

  if ("const" in schema && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}=${JSON.stringify(value)} not in enum [${schema.enum.join(", ")}]`);
  }
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path} must be ${schema.type}`);
    return; // type mismatch → skip structural checks that assume the type
  }
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path} does not match pattern ${schema.pattern}`);
  }

  if (schema.type === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) errors.push(`${path} missing required '${key}'`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (schema.propertyNames?.pattern && !new RegExp(schema.propertyNames.pattern).test(key)) {
        errors.push(`${childPath}: key does not match ${schema.propertyNames.pattern}`);
      }
      if (key in props) {
        validateNode(child, props[key], childPath, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${childPath}: unknown key (additionalProperties:false)`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validateNode(child, schema.additionalProperties, childPath, errors);
      }
    }
  }
}

function matchesType(val, type) {
  if (type === "string") return typeof val === "string";
  if (type === "number") return typeof val === "number" && Number.isFinite(val);
  if (type === "integer") return Number.isInteger(val);
  if (type === "boolean") return typeof val === "boolean";
  if (type === "object") return val !== null && typeof val === "object" && !Array.isArray(val);
  if (type === "array") return Array.isArray(val);
  return true;
}

/**
 * Coerce a candidate gate to a trusted value: pass valid tokens through, and
 * fail-safe anything else (missing/invalid) to the STRICT gate (`ask`).
 * @param {unknown} value
 * @returns {string|undefined} the gate, or undefined when no value was present
 */
export function coerceGate(value) {
  if (value === undefined) return undefined;
  return GATES.includes(value) ? value : FAIL_SAFE_GATE;
}

/**
 * Merge zero-config defaults <- user <- repo into the effective policy. Repo
 * wins over user; user wins over defaults. Every resolved value is coerced
 * fail-safe, so an invalid override becomes `ask` rather than silently keeping
 * a looser lower-priority value.
 * @param {{ user?: Record<string, any>, repo?: Record<string, any> }} [layers]
 * @returns {{ schema_version: number, classes: Record<string,string>, actions: Record<string,string> }}
 */
export function mergePolicies({ user = {}, repo = {} } = {}) {
  const classes = {};
  for (const cls of CLASSES) {
    const repoVal = repo.classes?.[cls];
    const userVal = user.classes?.[cls];
    const chosen =
      repoVal !== undefined
        ? coerceGate(repoVal)
        : userVal !== undefined
          ? coerceGate(userVal)
          : ZERO_CONFIG_CLASS_DEFAULTS[cls];
    classes[cls] = chosen;
  }

  const actions = {};
  const actionKeys = new Set([
    ...Object.keys(user.actions ?? {}),
    ...Object.keys(repo.actions ?? {}),
  ]);
  for (const key of actionKeys) {
    const repoVal = repo.actions?.[key];
    const userVal = user.actions?.[key];
    actions[key] = coerceGate(repoVal !== undefined ? repoVal : userVal);
  }

  return { schema_version: SCHEMA_VERSION, classes, actions };
}

/**
 * Resolve the effective gate for one action against a merged policy. An action
 * override wins over its class default; the class is taken from --class, else
 * the known ACTION_CLASSES map. With neither, the strict gate is returned.
 * @param {{ classes: Record<string,string>, actions: Record<string,string> }} effective
 * @param {{ action?: string, class?: string }} query
 * @returns {{ gate: string, class: string|null, source: string }}
 */
export function resolveGate(effective, { action, class: klass } = {}) {
  if (action && effective.actions?.[action] !== undefined) {
    return { gate: effective.actions[action], class: klass ?? ACTION_CLASSES[action] ?? null, source: "action-override" };
  }
  const cls = klass ?? (action ? ACTION_CLASSES[action] : undefined) ?? null;
  if (cls && effective.classes?.[cls] !== undefined) {
    return { gate: effective.classes[cls], class: cls, source: "class-default" };
  }
  // Unknown class/action → strictest gate (fail-safe).
  return { gate: FAIL_SAFE_GATE, class: cls, source: "fail-safe" };
}

/**
 * Read one policy file (fail-safe): returns the parsed+validated object, or {}
 * when the file is absent/unparseable/invalid (with a degraded flag + warning).
 * @param {string} path
 * @param {Record<string, any>} schema
 * @param {object} deps
 * @returns {Promise<{ present: boolean, config: Record<string, any>, degraded: boolean }>}
 */
async function readOneFile(path, schema, { existsImpl, readImpl, warn }) {
  if (!existsImpl(path)) return { present: false, config: {}, degraded: false };
  let parsed;
  try {
    parsed = parseYaml(await readImpl(path));
  } catch (err) {
    warn(`policy-read: ${path} unparseable (${err?.message ?? err}); ignoring (fail-safe)`);
    return { present: true, config: {}, degraded: true };
  }
  const { ok, errors } = validatePolicy(parsed, schema);
  if (!ok) {
    // Do NOT discard the whole file: mergePolicies coerces each invalid value
    // to `ask`, so a partially-invalid file still tightens rather than loosens.
    warn(`policy-read: ${path} has invalid values (fail-safe to ask): ${errors.join("; ")}`);
    return { present: true, config: parsed, degraded: true };
  }
  return { present: true, config: parsed, degraded: false };
}

/**
 * Full read flow: load schema → read user + repo files → merge. Fail-safe:
 * NEVER throws; on any failure it degrades toward the strict gate and reports
 * `degraded: true`. Missing files → zero-config defaults (today's behavior).
 * @param {string[]} argv
 * @param {object} [deps]
 * @returns {Promise<Record<string, any>>}
 */
export async function run(
  argv = [],
  {
    readImpl = (p) => readFile(p, "utf8"),
    existsImpl = existsSync,
    loadSchemaImpl = loadSchema,
    userPolicyPath = USER_POLICY_PATH,
    warn = (msg) => process.stderr.write(`${msg}\n`),
  } = {},
) {
  const args = parseArgs(argv);
  const repoRoot = typeof args["repo-root"] === "string" ? args["repo-root"] : process.cwd();
  const repoPath = repoPolicyPath(repoRoot);

  let schema = {};
  try {
    schema = await loadSchemaImpl();
  } catch (err) {
    // Even without a schema we can still return safe defaults.
    warn(`policy-read: schema unreadable (${err?.message ?? err}); values fail-safe to ask`);
  }

  const deps = { existsImpl, readImpl, warn };
  const userFile = await readOneFile(userPolicyPath, schema, deps).catch((err) => {
    warn(`policy-read: user policy read failed (${err?.message ?? err}); ignoring`);
    return { present: false, config: {}, degraded: true };
  });
  const repoFile = await readOneFile(repoPath, schema, deps).catch((err) => {
    warn(`policy-read: repo policy read failed (${err?.message ?? err}); ignoring`);
    return { present: false, config: {}, degraded: true };
  });

  const effective = mergePolicies({ user: userFile.config, repo: repoFile.config });
  const result = {
    ...effective,
    sources: { user: userFile.present, repo: repoFile.present },
    degraded: userFile.degraded || repoFile.degraded,
  };

  // Single-action query mode: resolve one gate against the merged policy.
  if (typeof args.action === "string" || typeof args.class === "string") {
    result.resolved = resolveGate(effective, {
      action: typeof args.action === "string" ? args.action : undefined,
      class: typeof args.class === "string" ? args.class : undefined,
    });
  }
  return result;
}

// CLI entry: print the merged effective policy JSON for a skill to consume.
// Always exit 0 (fail-safe never surfaces as a non-zero exit to a chained caller).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  });
}
