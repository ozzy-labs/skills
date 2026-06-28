// Payload self-containment guard.
//
// Regression test for the dangling user-scope reference bug: the Claude Code
// wrappers Read `~/.agents/skills/<name>/SKILL.md` (the canonical body), but
// the claude-code payload historically shipped only `.claude/skills/` — so a
// standalone `install --adapter=claude-code` left those refs pointing at files
// that were never installed (only the codex-cli payload carried them).
//
// Invariant: every `~/.(agents|claude)/skills/<name>/SKILL.md` reference inside
// a per-skill adapter payload MUST resolve to a file shipped in that SAME
// payload (i.e. installing that one adapter to an empty $HOME is self-sufficient).
// The existing user-scope-refs test only checks that refs are REWRITTEN to `~/`,
// not that they RESOLVE — this closes that gap.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

// Adapters whose payloads ship per-skill SKILL.md files. Codex / Gemini /
// Copilot all ship the same canonical `.agents/skills/` tree; claude-code adds
// the `.claude/skills/` wrappers on top.
const PER_SKILL_ADAPTERS = ["claude-code", "codex-cli", "gemini-cli", "copilot"];

// `~/.agents/skills/<name>/SKILL.md` or `~/.claude/skills/<name>/SKILL.md`
const REF_RE = /~\/(\.(?:agents|claude)\/skills\/[a-z0-9-]+\/SKILL\.md)/g;

async function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

for (const adapter of PER_SKILL_ADAPTERS) {
  test(`${adapter} payload resolves every ~/ skill reference within itself`, async () => {
    const adapterRoot = join(DIST, adapter);
    assert.ok(
      existsSync(adapterRoot),
      `missing adapter payload at dist/${adapter}/ — run \`pnpm build\` first`,
    );

    const files = (await walk(adapterRoot)).filter((f) => f.endsWith("SKILL.md"));
    const dangling = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const match of content.matchAll(REF_RE)) {
        const target = join(adapterRoot, match[1]);
        if (!existsSync(target)) {
          dangling.push(`${relative(ROOT, file)} → ${match[0]} (missing ${match[1]})`);
        }
      }
    }
    assert.deepEqual(
      dangling,
      [],
      `dist/${adapter}/ ships SKILL.md files referencing skill bodies that are not in the payload:\n  ${dangling.join("\n  ")}`,
    );
  });
}
