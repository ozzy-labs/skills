// Tests for verify.mjs — the deterministic `verify` engine (ADR-0028 R4 / R1).
//
// Two layers:
//   1. Pure functions (parseArgs, classifyKind, the AGENTS.md / justfile /
//      Makefile / lefthook extractors, package-manager detection, LINT_RULES).
//   2. Real tmp-repo fixtures that exercise the discovery chain end-to-end
//      (AGENTS.md → stage 1, package.json only → stage 2, justfile only →
//      stage 3, go.mod → stage 4, nothing → unresolved) plus the upper-stage
//      stop rule (段跨ぎ禁止), the `source` provenance on every command, and the
//      serial runner with an injected fake (no real command ever executes).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  classifyKind,
  detectPackageManager,
  discoverCommands,
  extractAgentsMdCommands,
  extractJustfileTargets,
  extractLefthookHooks,
  extractMakefileTargets,
  LINT_RULES,
  parseArgs,
  run,
  runCommands,
  STAGE_AGENTS_MD,
  STAGE_LANGUAGE,
  STAGE_PACKAGE_JSON,
  STAGE_TASK_RUNNER,
} from "../.agents/skills/verify/verify.mjs";

const tmpDirs = [];

function mkRepo() {
  const dir = mkdtempSync(join(tmpdir(), "verify-fixture-"));
  tmpDirs.push(dir);
  return dir;
}

/** Write `files` (relativePath → content) into a fresh tmp repo, return its dir. */
function repoWith(files) {
  const dir = mkRepo();
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

const AGENTS_MD = [
  "# AGENTS.md",
  "",
  "## 検証（必須）",
  "",
  "1. `pnpm run build` — ビルド成功（dist/ の更新を必ず commit）",
  "2. `pnpm run lint:all` — 全リンター通過",
  "",
  "## 次の節",
  "",
  "`これは別節なので無視` される",
].join("\n");

// ---------------------------------------------------------------------------
// pure functions
// ---------------------------------------------------------------------------

test("parseArgs: flags and key=value", () => {
  assert.deepEqual(parseArgs(["--dry-run", "--json", "--repo-root=/x"]), {
    "dry-run": true,
    json: true,
    "repo-root": "/x",
  });
});

test("classifyKind: build / typecheck / test / lint / other", () => {
  assert.equal(classifyKind("pnpm run build"), "build");
  assert.equal(classifyKind("go build ./..."), "build");
  assert.equal(classifyKind("pnpm run typecheck"), "typecheck");
  assert.equal(classifyKind("tsc --noEmit"), "typecheck");
  assert.equal(classifyKind("go test ./..."), "test");
  assert.equal(classifyKind("uv run pytest"), "test");
  assert.equal(classifyKind("pnpm run lint:all"), "lint");
  assert.equal(classifyKind("biome check ."), "lint");
  assert.equal(classifyKind("echo hello"), "other");
});

test("extractAgentsMdCommands: inline backtick commands in the 検証 section only", () => {
  const cmds = extractAgentsMdCommands(AGENTS_MD);
  assert.deepEqual(cmds, ["pnpm run build", "pnpm run lint:all"]);
  // prose backtick in a LATER section is not captured (single-token / other section).
  assert.ok(!cmds.some((c) => c.includes("別節")));
});

test("extractAgentsMdCommands: fenced code block, trailing # comments stripped", () => {
  const raw = [
    "## 検証",
    "",
    "```bash",
    "pnpm run build             # コメントは除去",
    "# 純粋なコメント行は無視",
    "pnpm run test",
    "```",
  ].join("\n");
  assert.deepEqual(extractAgentsMdCommands(raw), ["pnpm run build", "pnpm run test"]);
});

test("extractAgentsMdCommands: no 検証 section → empty", () => {
  assert.deepEqual(extractAgentsMdCommands("# AGENTS.md\n\n## その他\n\n`foo bar`"), []);
});

test("extractJustfileTargets: recipes filtered to canonical set, := assignment ignored", () => {
  const raw = [
    "version := '1'",
    "build:",
    "  echo build",
    'test target="x":',
    "  echo test",
    "deploy:",
  ].join("\n");
  // only canonical targets, in canonical order; `deploy` and the `:=` line excluded.
  assert.deepEqual(extractJustfileTargets(raw), ["build", "test"]);
});

test("extractMakefileTargets: targets filtered to canonical set, := assignment ignored", () => {
  const raw = ["CC := gcc", "build: deps", "\techo build", "lint:", "\techo lint", "clean:"].join(
    "\n",
  );
  assert.deepEqual(extractMakefileTargets(raw), ["build", "lint"]);
});

test("extractLefthookHooks: top-level git hooks only", () => {
  const raw = [
    "pre-commit:",
    "  commands:",
    "    lint:",
    "      run: biome check",
    "pre-push:",
    "  commands:",
    "    test:",
    "      run: pnpm test",
  ].join("\n");
  assert.deepEqual(extractLefthookHooks(raw), ["pre-commit", "pre-push"]);
});

test("detectPackageManager: from lockfile, default npm", () => {
  assert.equal(detectPackageManager(repoWith({ "pnpm-lock.yaml": "" }), {}), "pnpm");
  assert.equal(detectPackageManager(repoWith({ "yarn.lock": "" }), {}), "yarn");
  assert.equal(detectPackageManager(repoWith({}), {}), "npm");
});

test("LINT_RULES: carries the folded-in lint-rules correspondence table", () => {
  assert.equal(LINT_RULES[".ts"], "biome check --write <file>");
  assert.equal(LINT_RULES[".md"], "markdownlint-cli2 --fix <file>");
  assert.equal(LINT_RULES[".sh"], "shfmt -w <file> && shellcheck <file>");
  assert.ok(Object.isFrozen(LINT_RULES));
});

// ---------------------------------------------------------------------------
// discovery chain: one fixture per stage
// ---------------------------------------------------------------------------

test("stage 1: AGENTS.md 検証 section wins", () => {
  const dir = repoWith({ "AGENTS.md": AGENTS_MD });
  const { stage, commands } = discoverCommands(dir);
  assert.equal(stage, STAGE_AGENTS_MD);
  assert.deepEqual(
    commands.map((c) => c.command),
    ["pnpm run build", "pnpm run lint:all"],
  );
  assert.ok(
    commands.every((c) => c.source === STAGE_AGENTS_MD),
    "every command carries its source",
  );
});

test("stage 2: package.json scripts when no AGENTS.md 検証", () => {
  const dir = repoWith({
    "package.json": JSON.stringify({
      scripts: { build: "x", test: "y", lint: "z", other: "ignored" },
    }),
    "pnpm-lock.yaml": "",
  });
  const { stage, commands } = discoverCommands(dir);
  assert.equal(stage, STAGE_PACKAGE_JSON);
  // canonical order build/typecheck/test/lint; `other` is not selected.
  assert.deepEqual(
    commands.map((c) => c.command),
    ["pnpm run build", "pnpm run test", "pnpm run lint"],
  );
  assert.ok(commands.every((c) => c.source === STAGE_PACKAGE_JSON));
});

test("stage 3: justfile when no AGENTS.md / package.json", () => {
  const dir = repoWith({ justfile: ["build:", "  echo b", "test:", "  echo t"].join("\n") });
  const { stage, commands } = discoverCommands(dir);
  assert.equal(stage, STAGE_TASK_RUNNER);
  assert.deepEqual(
    commands.map((c) => c.command),
    ["just build", "just test"],
  );
  assert.ok(commands.every((c) => c.source === STAGE_TASK_RUNNER));
});

test("stage 4: language heuristic (go.mod) as last resort", () => {
  const dir = repoWith({ "go.mod": "module example.com/x\n\ngo 1.22\n" });
  const { stage, commands } = discoverCommands(dir);
  assert.equal(stage, STAGE_LANGUAGE);
  assert.deepEqual(
    commands.map((c) => c.command),
    ["go build ./...", "go test ./..."],
  );
  assert.ok(commands.every((c) => c.source === STAGE_LANGUAGE));
});

test("unresolved: nothing discovered → stage null, empty commands", () => {
  const { stage, commands } = discoverCommands(repoWith({ "README.md": "hi" }));
  assert.equal(stage, null);
  assert.deepEqual(commands, []);
});

// ---------------------------------------------------------------------------
// upper-stage stop rule (段跨ぎ禁止)
// ---------------------------------------------------------------------------

test("stop rule: AGENTS.md wins over package.json (no stage crossing)", () => {
  const dir = repoWith({
    "AGENTS.md": AGENTS_MD,
    "package.json": JSON.stringify({ scripts: { build: "x", test: "y" } }),
    "pnpm-lock.yaml": "",
  });
  const { stage, commands } = discoverCommands(dir);
  assert.equal(stage, STAGE_AGENTS_MD);
  assert.ok(
    !commands.some((c) => c.source === STAGE_PACKAGE_JSON),
    "no package-json command leaks in",
  );
});

test("stop rule: package.json wins over justfile + go.mod", () => {
  const dir = repoWith({
    "package.json": JSON.stringify({ scripts: { test: "y" } }),
    justfile: "build:\n  echo b\n",
    "go.mod": "module x\n",
  });
  const { stage, commands } = discoverCommands(dir);
  assert.equal(stage, STAGE_PACKAGE_JSON);
  assert.deepEqual(
    commands.map((c) => c.command),
    ["npm run test"],
  );
});

// ---------------------------------------------------------------------------
// execution (injected fake runner — nothing real runs)
// ---------------------------------------------------------------------------

test("runCommands: serial, continues on failure, records ok + source", () => {
  const commands = [
    { command: "a", source: STAGE_PACKAGE_JSON, kind: "build" },
    { command: "b", source: STAGE_PACKAGE_JSON, kind: "test" },
  ];
  const order = [];
  const runner = (c) => {
    order.push(c);
    return c === "b"
      ? { status: 1, stdout: "", stderr: "boom\n", error: null }
      : { status: 0, stdout: "ok", stderr: "", error: null };
  };
  const results = runCommands(commands, runner);
  assert.deepEqual(order, ["a", "b"], "runs serially in order");
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].error, "boom");
  assert.equal(results[1].source, STAGE_PACKAGE_JSON);
});

test("run: --dry-run discovers but never executes", () => {
  const dir = repoWith({ "package.json": JSON.stringify({ scripts: { test: "y" } }) });
  let called = false;
  const result = run(["--dry-run"], {
    cwd: dir,
    runner: () => {
      called = true;
      return { status: 0, stdout: "", stderr: "", error: null };
    },
  });
  assert.equal(result.dry_run, true);
  assert.equal(result.executed, false);
  assert.equal(result.ok, null);
  assert.equal(result.results, undefined);
  assert.equal(called, false, "runner must not be called under --dry-run");
  assert.equal(result.discovery.stage, STAGE_PACKAGE_JSON);
});

test("run: default executes the winning stage via the injected runner", () => {
  const dir = repoWith({ "AGENTS.md": AGENTS_MD });
  const runner = () => ({ status: 0, stdout: "ok", stderr: "", error: null });
  const result = run([], { cwd: dir, runner });
  assert.equal(result.executed, true);
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((r) => r.source === STAGE_AGENTS_MD));
});

test("run: ok is false when any command fails", () => {
  const dir = repoWith({ "go.mod": "module x\n" });
  const runner = (c) =>
    c.includes("test")
      ? { status: 1, stdout: "", stderr: "fail\n", error: null }
      : { status: 0, stdout: "", stderr: "", error: null };
  const result = run([], { cwd: dir, runner });
  assert.equal(result.ok, false);
  assert.equal(result.results.find((r) => r.kind === "test").ok, false);
});

test("run: unresolved repo executes nothing and ok stays null", () => {
  const dir = repoWith({ "README.md": "hi" });
  let called = false;
  const result = run([], {
    cwd: dir,
    runner: () => {
      called = true;
      return { status: 0, stdout: "", stderr: "", error: null };
    },
  });
  assert.equal(result.discovery.stage, null);
  assert.equal(result.executed, false);
  assert.equal(result.ok, null);
  assert.equal(called, false);
});
