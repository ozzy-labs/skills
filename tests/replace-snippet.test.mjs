// Tests for scripts/sync/replace-snippet.sh.
//
// The helper is the single source of truth for the marker-block sync logic
// downstream consumers run. Behavior contract:
//   - target has markers → replace marker block with snippet
//   - target missing markers → append snippet (auto-recovery for ozzy-labs/skills#33)
//   - target file does not exist → create file with snippet content

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "sync", "replace-snippet.sh");
const SNIPPET = `<!-- begin: @ozzylabs/skills -->

## Available Skills

- \`foo\` — Foo skill
- \`bar\` — Bar skill

<!-- end: @ozzylabs/skills -->
`;

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "replace-snippet-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(target, snippet) {
  return spawnSync("bash", [SCRIPT, target, snippet], { encoding: "utf8" });
}

test("replaces marker block when markers are present", async () => {
  await withTmp(async (dir) => {
    const target = join(dir, "AGENTS.md");
    const snippet = join(dir, "snippet.md");
    await writeFile(snippet, SNIPPET);
    await writeFile(
      target,
      [
        "# Project AGENTS",
        "",
        "Hand-written intro.",
        "",
        "<!-- begin: @ozzylabs/skills -->",
        "(stale content)",
        "<!-- end: @ozzylabs/skills -->",
        "",
        "## Hand-written tail",
        "",
        "More content.",
        "",
      ].join("\n"),
    );
    const result = run(target, snippet);
    assert.equal(result.status, 0, result.stderr);
    const out = await readFile(target, "utf8");
    assert.match(out, /# Project AGENTS/);
    assert.match(out, /Hand-written intro\./);
    assert.match(out, /## Hand-written tail/);
    assert.match(out, /- `foo` — Foo skill/);
    assert.doesNotMatch(out, /\(stale content\)/);
    assert.match(out, /<!-- begin: @ozzylabs\/skills -->/);
    assert.match(out, /<!-- end: @ozzylabs\/skills -->/);
  });
});

test("appends snippet when marker is missing", async () => {
  await withTmp(async (dir) => {
    const target = join(dir, "copilot-instructions.md");
    const snippet = join(dir, "snippet.md");
    await writeFile(snippet, SNIPPET);
    await writeFile(target, "# Copilot instructions\n\nHand-written body.\n");
    const result = run(target, snippet);
    assert.equal(result.status, 0, result.stderr);
    const out = await readFile(target, "utf8");
    assert.match(out, /# Copilot instructions/);
    assert.match(out, /Hand-written body\./);
    assert.match(out, /<!-- begin: @ozzylabs\/skills -->/);
    assert.match(out, /<!-- end: @ozzylabs\/skills -->/);
    assert.match(out, /- `foo` — Foo skill/);
    const beginIdx = out.indexOf("<!-- begin: @ozzylabs/skills -->");
    const handIdx = out.indexOf("Hand-written body.");
    assert.ok(handIdx < beginIdx, "snippet must be appended after existing content");
    // Exactly one blank line between existing content and the snippet.
    assert.match(
      out,
      /Hand-written body\.\n\n<!-- begin: @ozzylabs\/skills -->/,
      "must use exactly one blank line as separator",
    );
  });
});

test("creates file when target does not exist", async () => {
  await withTmp(async (dir) => {
    const target = join(dir, "nested", "AGENTS.md");
    const snippet = join(dir, "snippet.md");
    await writeFile(snippet, SNIPPET);
    const result = run(target, snippet);
    assert.equal(result.status, 0, result.stderr);
    const out = await readFile(target, "utf8");
    assert.equal(out, SNIPPET);
  });
});

test("handles target without trailing newline before append", async () => {
  await withTmp(async (dir) => {
    const target = join(dir, "AGENTS.md");
    const snippet = join(dir, "snippet.md");
    await writeFile(snippet, SNIPPET);
    await writeFile(target, "no-trailing-newline");
    const result = run(target, snippet);
    assert.equal(result.status, 0, result.stderr);
    const out = await readFile(target, "utf8");
    assert.ok(out.startsWith("no-trailing-newline\n"));
    assert.match(out, /<!-- begin: @ozzylabs\/skills -->/);
  });
});

test("re-running on appended file replaces marker block in place", async () => {
  await withTmp(async (dir) => {
    const target = join(dir, "AGENTS.md");
    const snippet = join(dir, "snippet.md");
    await writeFile(snippet, SNIPPET);
    await writeFile(target, "# Hand-written\n\nBody.\n");

    const first = run(target, snippet);
    assert.equal(first.status, 0, first.stderr);

    const second = run(target, snippet);
    assert.equal(second.status, 0, second.stderr);

    const out = await readFile(target, "utf8");
    const beginCount = (out.match(/<!-- begin: @ozzylabs\/skills -->/g) ?? []).length;
    const endCount = (out.match(/<!-- end: @ozzylabs\/skills -->/g) ?? []).length;
    assert.equal(beginCount, 1, "begin marker must remain unique after re-run");
    assert.equal(endCount, 1, "end marker must remain unique after re-run");
  });
});

test("fails with usage error when args are wrong", async () => {
  const result = spawnSync("bash", [SCRIPT], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});

test("fails when snippet file is missing", async () => {
  await withTmp(async (dir) => {
    const target = join(dir, "AGENTS.md");
    const snippet = join(dir, "missing.md");
    await writeFile(target, "x");
    const result = run(target, snippet);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /snippet file not found/);
  });
});
