#!/usr/bin/env node
// verify — deterministic engine for the `verify` skill (ADR-0028 R4 / R1 type).
//
// A single unified verification skill that replaces the split lint / test /
// lint-rules trio. `verify` is always the same composite ("does build + type +
// test + lint pass?"), so the determinism it needs is a repeatable way to FIND
// the project's verification commands and then RUN them. This engine owns all of
// that; SKILL.md keeps only the judgment layer (when to run, how to report,
// where to ask the human).
//
// Discovery chain (issue #182, absorbing #179's AGENTS.md fallback). The first
// stage that yields any command WINS — no stage is crossed once one matches,
// and every command WITHIN the winning stage runs (段跨ぎ禁止・同段内は全実行):
//
//   1. agents-md        AGENTS.md「検証」section (fenced blocks + inline `cmd`)
//   2. package-json     package.json scripts among build / typecheck / test / lint
//   3. task-runner      justfile > Makefile > lefthook.yaml targets (first found)
//   4. language         go.mod → go build/test · pyproject+uv.lock → uv run pytest
//                       · Cargo.toml → cargo build/test
//
// Every discovered command carries its `source` (which stage found it) so the
// report can explain provenance. The engine then runs the winning stage's
// commands SERIALLY (git/build state is shared) and returns a structured JSON
// summary. It is a plain .mjs (real spawnSync); the pure discovery functions and
// the injectable runner are exported so tests drive it against tmp fixtures
// without executing anything.
//
// The per-extension lint correspondence table that used to live in the
// `lint-rules` skill is carried here as LINT_RULES — verify's own rules,
// referenced by SKILL.md.
//
// Output modes (CLI):
//   node verify.mjs             discover + run the winning stage, rendered report
//   node verify.mjs --dry-run   discover only (no execution), rendered plan
//   node verify.mjs --json      the structured JSON result instead of text
//   node verify.mjs --repo-root=<dir>   verify a different directory

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = 1;

// Discovery stage ids (the `source` stamped onto each command).
export const STAGE_AGENTS_MD = "agents-md";
export const STAGE_PACKAGE_JSON = "package-json";
export const STAGE_TASK_RUNNER = "task-runner";
export const STAGE_LANGUAGE = "language-heuristic";

// The canonical verification target names, in priority order. Both the
// package.json-scripts stage and the task-runner stage select from this set, so
// discovery is consistent across stages.
export const CANONICAL_TARGETS = ["build", "typecheck", "test", "lint"];

// Git hook names lefthook can define that a `lefthook run <hook>` verifies.
const LEFTHOOK_HOOKS = ["pre-commit", "pre-push"];

// The per-extension lint / format correspondence table, folded in from the old
// `lint-rules` skill (ADR-0028 R4). These are verify's rules for per-file
// linting; the discovery chain finds project-level commands, and this table is
// the reference for what a linter run means per file type. Exported so SKILL.md
// and tests can assert the contract.
export const LINT_RULES = Object.freeze({
  ".ts": "biome check --write <file>",
  ".tsx": "biome check --write <file>",
  ".js": "biome check --write <file>",
  ".jsx": "biome check --write <file>",
  ".json": "biome check --write <file>",
  ".md": "markdownlint-cli2 --fix <file>",
  ".yaml": "yamlfmt <file> && yamllint -c .yamllint.yaml <file>",
  ".yml": "yamlfmt <file> && yamllint -c .yamllint.yaml <file>",
  ".toml": "taplo format <file>",
  ".sh": "shfmt -w <file> && shellcheck <file>",
});

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

function firstLine(s) {
  if (!s) return "";
  const line = String(s).split("\n").find((l) => l.trim());
  return line ? line.trim() : "";
}

/**
 * Classify a command / target name into a coarse verification kind. Order
 * matters (build before typecheck before test before lint). Exported for tests.
 * @param {string} text
 * @returns {"build"|"typecheck"|"test"|"lint"|"other"}
 */
export function classifyKind(text) {
  const s = String(text).toLowerCase();
  if (/\bbuild\b|compile/.test(s)) return "build";
  if (/typecheck|type-check|\btsc\b|mypy|\btypes?\b/.test(s)) return "typecheck";
  if (/\btest\b|pytest|vitest|jest|\bspec\b/.test(s)) return "test";
  if (/lint|biome|clippy|ruff|shellcheck|markdownlint|yamllint|gitleaks|\bfmt\b|format|check/.test(s)) {
    return "lint";
  }
  return "other";
}

function cmd(command, source, kind) {
  return { command, source, kind: kind ?? classifyKind(command) };
}

/** Bind fs implementations (injectable for tests). */
function fsDeps(deps) {
  return {
    existsImpl: deps.existsImpl ?? existsSync,
    readImpl: deps.readImpl ?? ((p) => readFileSync(p, "utf8")),
  };
}

function readOrNull(readImpl, path) {
  try {
    return readImpl(path);
  } catch {
    return null;
  }
}

function firstExisting(cwd, names, existsImpl) {
  for (const name of names) {
    if (existsImpl(join(cwd, name))) return join(cwd, name);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stage 1: AGENTS.md「検証」section
// ---------------------------------------------------------------------------

/**
 * Heuristic: an inline `code` span is a command when it has at least two
 * whitespace-separated tokens and its first token is a plain command name (no
 * colon / equals — rejects prose like `key: value` or `a = b`).
 */
function looksLikeCommand(span) {
  const tokens = span.split(/\s+/);
  if (tokens.length < 2) return false;
  return /^[a-zA-Z][\w.-]*$/.test(tokens[0]);
}

/**
 * Extract verification commands from the「検証」(verification) section of an
 * AGENTS.md body. Commands come from fenced code blocks (trailing `# comment`
 * stripped) and from inline `code` spans that look like a multi-token command.
 * Returns a deduped, order-preserving list of raw command strings. Exported for
 * tests.
 * @param {string} raw
 * @returns {string[]}
 */
export function extractAgentsMdCommands(raw) {
  const lines = String(raw).split("\n");
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (m && /検証|verif/i.test(m[2])) {
      start = i;
      level = m[1].length;
      break;
    }
  }
  if (start === -1) return [];

  const commands = [];
  let inFence = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = line.match(/^(#{1,6})\s+/);
    if (!inFence && heading && heading[1].length <= level) break; // section ended
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const stripped = line.replace(/\s+#.*$/, "").trim();
      if (stripped && !stripped.startsWith("#")) commands.push(stripped);
    } else {
      for (const m of line.matchAll(/`([^`]+)`/g)) {
        const span = m[1].trim();
        if (looksLikeCommand(span)) commands.push(span);
      }
    }
  }
  return [...new Set(commands)];
}

function discoverFromAgentsMd(cwd, deps) {
  const path = join(cwd, "AGENTS.md");
  if (!deps.existsImpl(path)) return [];
  const raw = readOrNull(deps.readImpl, path);
  if (raw == null) return [];
  return extractAgentsMdCommands(raw).map((c) => cmd(c, STAGE_AGENTS_MD));
}

// ---------------------------------------------------------------------------
// Stage 2: package.json scripts
// ---------------------------------------------------------------------------

/**
 * Detect the package manager from the lockfile present in cwd (default npm).
 * Exported for tests.
 */
export function detectPackageManager(cwd, deps) {
  const { existsImpl } = fsDeps(deps);
  if (existsImpl(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsImpl(join(cwd, "yarn.lock"))) return "yarn";
  if (existsImpl(join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

function discoverFromPackageJson(cwd, deps) {
  const path = join(cwd, "package.json");
  if (!deps.existsImpl(path)) return [];
  const raw = readOrNull(deps.readImpl, path);
  if (raw == null) return [];
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return [];
  }
  const scripts = pkg?.scripts ?? {};
  const pm = detectPackageManager(cwd, deps);
  const out = [];
  for (const name of CANONICAL_TARGETS) {
    if (typeof scripts[name] === "string" && scripts[name].trim()) {
      out.push(cmd(`${pm} run ${name}`, STAGE_PACKAGE_JSON, classifyKind(name)));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage 3: task runners (justfile > Makefile > lefthook.yaml)
// ---------------------------------------------------------------------------

/**
 * Recipe names defined in a justfile, filtered to CANONICAL_TARGETS. A recipe
 * definition starts at column 0 with `name [params]:` (and NOT `name :=`, an
 * assignment). Exported for tests.
 */
export function extractJustfileTargets(raw) {
  const found = new Set();
  for (const line of String(raw).split("\n")) {
    if (/^\s/.test(line)) continue; // recipe bodies are indented
    if (/^[a-zA-Z][\w-]*\s*:?=/.test(line)) continue; // assignment: `name :=` / `name =`
    // recipe header: `name [params...]:` — params may hold `=` defaults, so match
    // the name then any signature text up to the terminating colon.
    const m = line.match(/^([a-zA-Z][\w-]*)\b.*:/);
    if (m) found.add(m[1]);
  }
  return CANONICAL_TARGETS.filter((t) => found.has(t));
}

/**
 * Target names defined in a Makefile, filtered to CANONICAL_TARGETS. A target
 * line starts at column 0 with `name:` (and NOT `name :=`, an assignment).
 * Exported for tests.
 */
export function extractMakefileTargets(raw) {
  const found = new Set();
  for (const line of String(raw).split("\n")) {
    const m = line.match(/^([a-zA-Z][\w-]*)\s*:(?!=)/);
    if (m) found.add(m[1]);
  }
  return CANONICAL_TARGETS.filter((t) => found.has(t));
}

/**
 * Git-hook names a lefthook config defines, filtered to LEFTHOOK_HOOKS. Detected
 * as top-level (column 0) mapping keys. Exported for tests.
 */
export function extractLefthookHooks(raw) {
  const found = new Set();
  for (const line of String(raw).split("\n")) {
    const m = line.match(/^([a-z][a-z-]+):\s*$/);
    if (m) found.add(m[1]);
  }
  return LEFTHOOK_HOOKS.filter((h) => found.has(h));
}

function discoverFromTaskRunner(cwd, deps) {
  const just = firstExisting(cwd, ["justfile", "Justfile", ".justfile"], deps.existsImpl);
  if (just) {
    const raw = readOrNull(deps.readImpl, just);
    const targets = raw == null ? [] : extractJustfileTargets(raw);
    if (targets.length) return targets.map((t) => cmd(`just ${t}`, STAGE_TASK_RUNNER, classifyKind(t)));
  }
  const make = firstExisting(cwd, ["Makefile", "makefile", "GNUmakefile"], deps.existsImpl);
  if (make) {
    const raw = readOrNull(deps.readImpl, make);
    const targets = raw == null ? [] : extractMakefileTargets(raw);
    if (targets.length) return targets.map((t) => cmd(`make ${t}`, STAGE_TASK_RUNNER, classifyKind(t)));
  }
  const lh = firstExisting(cwd, ["lefthook.yaml", "lefthook.yml", ".lefthook.yaml"], deps.existsImpl);
  if (lh) {
    const raw = readOrNull(deps.readImpl, lh);
    const hooks = raw == null ? [] : extractLefthookHooks(raw);
    if (hooks.length) return hooks.map((h) => cmd(`lefthook run ${h}`, STAGE_TASK_RUNNER, "other"));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Stage 4: language heuristic
// ---------------------------------------------------------------------------

function discoverFromLanguage(cwd, deps) {
  const ex = (f) => deps.existsImpl(join(cwd, f));
  if (ex("go.mod")) {
    return [cmd("go build ./...", STAGE_LANGUAGE, "build"), cmd("go test ./...", STAGE_LANGUAGE, "test")];
  }
  if (ex("pyproject.toml") && ex("uv.lock")) {
    return [cmd("uv run pytest", STAGE_LANGUAGE, "test")];
  }
  if (ex("Cargo.toml")) {
    return [cmd("cargo build", STAGE_LANGUAGE, "build"), cmd("cargo test", STAGE_LANGUAGE, "test")];
  }
  return [];
}

// ---------------------------------------------------------------------------
// discovery orchestration
// ---------------------------------------------------------------------------

/**
 * Run the discovery chain. Returns `{ stage, commands }` for the FIRST stage
 * that yields any command (upper stages win; stages are never crossed), or
 * `{ stage: null, commands: [] }` when nothing is found. Exported for tests.
 * @param {string} cwd
 * @param {{ existsImpl?: Function, readImpl?: Function }} [deps]
 */
export function discoverCommands(cwd, deps = {}) {
  const d = fsDeps(deps);
  const stages = [
    [STAGE_AGENTS_MD, discoverFromAgentsMd],
    [STAGE_PACKAGE_JSON, discoverFromPackageJson],
    [STAGE_TASK_RUNNER, discoverFromTaskRunner],
    [STAGE_LANGUAGE, discoverFromLanguage],
  ];
  for (const [stage, fn] of stages) {
    const commands = fn(cwd, d);
    if (commands.length) return { stage, commands };
  }
  return { stage: null, commands: [] };
}

// ---------------------------------------------------------------------------
// execution (serial; injectable runner)
// ---------------------------------------------------------------------------

/**
 * Build a spawnSync-backed shell runner bound to a cwd. Each command is run
 * through the shell so `a && b` / `go build ./...` behave as written.
 * @param {string} cwd
 */
export function makeShellRunner(cwd) {
  return (command) => {
    const res = spawnSync(command, {
      cwd,
      shell: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 600000,
    });
    return {
      status: res.status === null ? (res.error ? -1 : 1) : res.status,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      error: res.error ?? null,
    };
  };
}

/**
 * Run the discovered commands serially via `runner`. Continues on failure so
 * the report lists every command's outcome (build state is shared, so a later
 * command may fail for the same root cause — that is still informative).
 * Exported for tests.
 * @param {Array<{command:string,source:string,kind:string}>} commands
 * @param {(command:string)=>{status:number,stdout:string,stderr:string,error:Error|null}} runner
 */
export function runCommands(commands, runner) {
  const results = [];
  for (const c of commands) {
    const r = runner(c.command);
    const ok = r.status === 0;
    results.push({
      command: c.command,
      source: c.source,
      kind: c.kind,
      status: r.status,
      ok,
      error: ok ? null : firstLine(r.stderr) || firstLine(r.error?.message) || `exit ${r.status}`,
    });
  }
  return results;
}

/**
 * Full run: discover the verification commands, then (unless --dry-run) execute
 * the winning stage serially. Never throws; returns the structured result.
 * @param {string[]} argv
 * @param {object} [deps]  injectable { cwd, now, existsImpl, readImpl, runner }
 */
export function run(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const cwd = typeof args["repo-root"] === "string" ? args["repo-root"] : deps.cwd ?? process.cwd();
  const dryRun = Boolean(args["dry-run"] || args.discover);
  const now = deps.now ?? (() => new Date());

  const discovery = discoverCommands(cwd, deps);
  const result = {
    schema_version: SCHEMA_VERSION,
    generated_at: now().toISOString(),
    cwd,
    dry_run: dryRun,
    discovery,
    executed: false,
    ok: null,
  };

  if (!dryRun && discovery.commands.length) {
    const runner = deps.runner ?? makeShellRunner(cwd);
    result.results = runCommands(discovery.commands, runner);
    result.executed = true;
    result.ok = result.results.every((r) => r.ok);
  }
  return result;
}

// ---------------------------------------------------------------------------
// rendering (deterministic; owned by the engine, not the LLM)
// ---------------------------------------------------------------------------

/**
 * Render the structured result into a human report. Exported for tests + CLI.
 */
export function render(result) {
  const lines = [];
  const { stage, commands } = result.discovery;
  if (!stage || commands.length === 0) {
    lines.push("検証コマンドを発見できませんでした（発見連鎖の全 4 段で未ヒット）。");
    lines.push("段: agents-md → package-json → task-runner → language-heuristic");
    return lines.join("\n");
  }

  lines.push(`検証コマンド発見: ${commands.length} 件（出典: ${stage}）`);
  for (const c of commands) {
    lines.push(`  - ${c.command}  [${c.kind}]`);
  }

  if (result.dry_run) {
    lines.push("", "--dry-run: 実行しません（発見のみ）。");
    return lines.join("\n");
  }

  if (result.executed) {
    lines.push("", `## 実行結果 (${result.results.length})`);
    for (const r of result.results) {
      const mark = r.ok ? "✔ pass" : `✖ fail (${r.error})`;
      lines.push(`- [${r.kind}] ${r.command}  … ${mark}`);
    }
    lines.push("", result.ok ? "✅ 全コマンド pass" : "❌ 失敗したコマンドあり");
  }
  return lines.join("\n");
}

// CLI entry: render the human report (or --json for the structured result).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const result = run(argv);
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${render(result)}\n`);
  // Non-zero exit only when we actually executed and something failed, so
  // callers (drive / implement Phase 4) can gate on it; discovery-only / dry-run
  // always exit 0.
  process.exit(result.executed && result.ok === false ? 1 : 0);
}
