// drive Workflow-based orchestration overlay (issue #183 → ADR-0028 R2).
//
// The Claude Code overlay (.agents/skills/drive/SKILL.claude-code.md) carries an
// embedded Dynamic Workflow orchestration script: Phase 0's `drive-plan.mjs`
// wave plan is passed as the script `args`, each wave is a `parallel()` barrier
// of `agent({ isolation: 'worktree' })` workers, and interruption resume is the
// Workflow journal (`resumeFromRunId`) — replacing the Agent-tool method's
// 30-second `gh pr list` polling + manual re-run.
//
// These are STATIC checks of that embedded script (the drive-plan.mjs /
// drive-report.mjs unit behavior is covered by the R1 tests
// drive-plan.test.mjs / drive-report.test.mjs):
//   1. meta structure  — pure-literal `name` / `description` / `phases`
//   2. phase list       — phases is an array of `{ title }`
//   3. primitives       — agent() + isolation:'worktree' + schema + parallel()
//                         + log(), and Workflow-determinism (no Date.now /
//                         Math.random / arg-less new Date)
//   4. syntax           — the script parses as JS (export stripped, async-wrapped)
//   5. schema alignment — the script consumes exactly the field names
//                         `drive-plan.mjs` emits (`waves` string[][] + `deps`
//                         map) and the worker contract fields the canonical
//                         SKILL.md declares (status capped at merge-ready)
//   6. shipping         — the built claude-code SKILL.md carries the script

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";
import { run as drivePlanRun } from "../.agents/skills/drive/drive-plan.mjs";
import { ClaudeCodeAdapter } from "../scripts/adapters/claude-code.mjs";
import { assertRequiredFields, parseSkillDocument } from "../scripts/lib/frontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, ".agents", "skills");
const OVERLAY = join(SRC, "drive", "SKILL.claude-code.md");

/** Read the raw Claude Code overlay for the drive skill. */
async function loadOverlayRaw() {
  return readFile(OVERLAY, "utf8");
}

/**
 * Extract the fenced ```js block that carries the Workflow script (the one that
 * declares `export const meta`). Fails loudly if none / more than one qualifies.
 */
function extractWorkflowScript(raw) {
  const blocks = [...raw.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
  const scripts = blocks.filter((b) => b.includes("export const meta"));
  assert.equal(
    scripts.length,
    1,
    `overlay must embed exactly one Workflow script (found ${scripts.length} js blocks with 'export const meta')`,
  );
  return scripts[0];
}

/**
 * Return the `{...}` object-literal string starting at `marker` using a balanced
 * brace scan (robust to nested braces / arrays / comments).
 */
function extractBalancedObject(src, marker) {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `marker not found: ${marker}`);
  const open = src.indexOf("{", at);
  assert.ok(open >= 0, `no opening brace after marker: ${marker}`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces after marker: ${marker}`);
}

// --- 1 + 2. meta structure -------------------------------------------------

test("workflow script declares a pure-literal meta with name / description / phases", async () => {
  const script = extractWorkflowScript(await loadOverlayRaw());
  assert.ok(script.includes("export const meta = {"), "must export a meta object");

  const metaLiteral = extractBalancedObject(script, "export const meta =");
  // meta must be a pure literal (constraint: no args / no function calls). Eval
  // it in an isolated context; a reference to `args`/`agent`/etc. would throw.
  const meta = new Script(`(${metaLiteral})`).runInContext(createContext({}));
  assert.equal(typeof meta.name, "string", "meta.name must be a string literal");
  assert.ok(meta.name.length > 0, "meta.name must be non-empty");
  assert.equal(typeof meta.description, "string", "meta.description must be a string literal");
  assert.ok(Array.isArray(meta.phases), "meta.phases must be an array");
  assert.ok(meta.phases.length > 0, "meta.phases must be non-empty");
  for (const p of meta.phases) {
    assert.equal(typeof p.title, "string", "each phase must be a { title: string } literal");
  }
});

// --- 3. primitives + determinism -------------------------------------------

test("workflow script uses the Workflow primitives with worktree isolation + schema", async () => {
  const script = extractWorkflowScript(await loadOverlayRaw());
  // worker = agent() with worktree isolation + structured return validation
  assert.match(script, /agent\(/, "must spawn workers via agent()");
  assert.match(script, /isolation:\s*'worktree'/, "workers must run isolation:'worktree'");
  assert.match(script, /schema:\s*WORKER_SCHEMA/, "agent() must validate the return with a schema");
  // wave = parallel() barrier (within-wave), wave sequence = the dependency for-await
  assert.match(script, /parallel\(/, "within-wave workers run under a parallel() barrier");
  assert.match(
    script,
    /for\s*\(const\s*\[i,\s*wave\]\s*of\s*args\.waves\.entries\(\)\)/,
    "iterates args.waves",
  );
  // 1-line progress
  assert.match(script, /\blog\(/, "must surface progress via log()");
});

test("workflow script obeys Workflow determinism (no Date.now / Math.random / arg-less new Date)", async () => {
  const script = extractWorkflowScript(await loadOverlayRaw());
  assert.ok(!/Date\.now\s*\(/.test(script), "Date.now() breaks resume determinism");
  assert.ok(!/Math\.random\s*\(/.test(script), "Math.random() breaks resume determinism");
  assert.ok(!/new Date\s*\(\s*\)/.test(script), "arg-less new Date() breaks resume determinism");
});

// --- 4. the script is syntactically valid JS -------------------------------

test("workflow script is syntactically valid JS (export stripped, async-wrapped)", async () => {
  const script = extractWorkflowScript(await loadOverlayRaw());
  // Strip ESM `export ` and wrap the top-level await/return in an async fn so
  // `new Script` (which compiles a classic script) can parse it. A SyntaxError
  // in the embedded orchestration script fails the build's documentation.
  const transformed = `(async () => {\n${script.replace(/\bexport const /g, "const ")}\n})`;
  assert.doesNotThrow(
    () => new Script(transformed),
    "embedded Workflow script must parse as JavaScript",
  );
});

// --- 5. alignment with the drive-plan.mjs engine output --------------------

test("workflow script consumes the exact field names drive-plan.mjs emits (waves + deps)", async () => {
  const script = extractWorkflowScript(await loadOverlayRaw());
  // The engine's actual orchestration output shape (not a hand-rolled fixture).
  const plan = drivePlanRun(["#1,#2 -> #3"]);
  assert.equal(plan.mode, "orchestration", "sanity: #1,#2 -> #3 is orchestration");

  // waves is a 2-D array of "#N" target strings…
  assert.ok(Array.isArray(plan.waves), "plan.waves must be an array");
  assert.ok(
    plan.waves.every((w) => Array.isArray(w) && w.every((t) => typeof t === "string")),
    "plan.waves must be string[][] (target strings), not objects",
  );
  assert.deepEqual(plan.waves, [["#1", "#2"], ["#3"]], "wave partition sanity");
  // …and deps is a separate target -> deps[] map (NOT embedded per wave item).
  assert.ok(plan.deps && typeof plan.deps === "object", "plan.deps must be a map object");
  assert.deepEqual(plan.deps["#3"], ["#1", "#2"], "deps map sanity");

  // The script must read those exact engine fields, so a rename on either side
  // (waves→levels, deps→edges, …) trips this alignment guard.
  assert.match(script, /args\.waves\b/, "script must read args.waves (drive-plan.mjs `waves`)");
  assert.match(script, /args\.deps\b/, "script must read args.deps (drive-plan.mjs `deps`)");
  // It must NOT assume the pre-R2 object-per-wave-item shape (t.target / t.deps).
  assert.ok(
    !/\bt\.target\b/.test(script) && !/\bt\.deps\b/.test(script),
    "script must not assume the wrong object-per-item wave shape (t.target / t.deps)",
  );
});

test("WORKER_SCHEMA matches the canonical worker return contract (status capped at merge-ready)", async () => {
  const script = extractWorkflowScript(await loadOverlayRaw());
  const schemaLiteral = extractBalancedObject(script, "const WORKER_SCHEMA =");
  // The canonical worker JSON fields (SKILL.md) must all appear in the schema.
  for (const field of [
    "target",
    "title",
    "branch",
    "pr_url",
    "pr_number",
    "status",
    "review",
    "cross_cutting_gaps",
    "final_head_state",
    "error",
  ]) {
    assert.ok(schemaLiteral.includes(field), `WORKER_SCHEMA must declare '${field}'`);
  }
  // Workers do not self-merge: the status is capped at merge-ready | failed
  // (no 'merged'), matching the canonical `"status": "merge-ready" | "failed"`.
  assert.match(
    schemaLiteral,
    /status:\s*\{\s*enum:\s*\[\s*'merge-ready',\s*'failed'\s*\]\s*\}/,
    "WORKER_SCHEMA.status must be capped at merge-ready | failed (workers never self-merge)",
  );

  // Cross-check against the canonical SKILL.md worker contract.
  const canonical = await readFile(join(SRC, "drive", "SKILL.md"), "utf8");
  assert.ok(
    canonical.includes('"status": "merge-ready" | "failed"'),
    "canonical worker status is merge-ready | failed",
  );
});

// --- 6. the script ships into the built claude-code output ------------------

test("built claude-code drive SKILL.md ships the Workflow orchestration script", async () => {
  const canonicalRaw = await readFile(join(SRC, "drive", "SKILL.md"), "utf8");
  const { frontmatter, body } = parseSkillDocument(canonicalRaw, ".agents/skills/drive/SKILL.md");
  assertRequiredFields(frontmatter, ["name", "description"], ".agents/skills/drive/SKILL.md");
  const companionRaw = await loadOverlayRaw();
  const companion = parseSkillDocument(companionRaw, ".agents/skills/drive/SKILL.claude-code.md");
  const drive = {
    name: frontmatter.name,
    description: frontmatter.description,
    frontmatter,
    body,
    raw: canonicalRaw,
    claudeCodeCompanion: companion,
  };
  const out = await new ClaudeCodeAdapter().generate([drive]);
  const driveOut = out.find((o) => o.relativePath === ".claude/skills/drive/SKILL.md");
  assert.ok(driveOut, "adapter emits .claude/skills/drive/SKILL.md");
  assert.ok(
    driveOut.content.includes("export const meta = {"),
    "built output must carry the Workflow orchestration script",
  );
  assert.ok(
    driveOut.content.includes("resumeFromRunId"),
    "built output must document journal resume (resumeFromRunId)",
  );
  assert.ok(
    driveOut.content.includes("agent({ isolation: 'worktree' })") ||
      driveOut.content.includes("isolation: 'worktree'"),
    "built output must document worktree-isolated workers",
  );
});
