// Tests for the user-scope skill-ref rewrite (scripts/lib/user-scope-refs.mjs)
// and the resulting invariant on the committed dist/ payload: installed
// user-scope copies must not carry repo-root-relative skill references
// (ADR-0027 user-skills-only distribution).

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { rewriteSkillRefsToUserScope } from "../scripts/lib/user-scope-refs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

async function walkFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

test("rewrites backtick-quoted refs for both skill roots", () => {
  assert.equal(
    rewriteSkillRefsToUserScope("`.agents/skills/commit/SKILL.md` を Read し、"),
    "`~/.agents/skills/commit/SKILL.md` を Read し、",
  );
  assert.equal(
    rewriteSkillRefsToUserScope("→ `.claude/skills/pr/SKILL.md` を Read し、"),
    "→ `~/.claude/skills/pr/SKILL.md` を Read し、",
  );
});

test("rewrites refs at line start and inside code-block comments", () => {
  assert.equal(
    rewriteSkillRefsToUserScope(".agents/skills/foo/SKILL.md に従う\n"),
    "~/.agents/skills/foo/SKILL.md に従う\n",
  );
  assert.equal(
    rewriteSkillRefsToUserScope("// canonical（.agents/skills/drive/SKILL.md）の contract"),
    "// canonical（~/.agents/skills/drive/SKILL.md）の contract",
  );
});

test("leaves already user-scoped refs untouched (idempotent)", () => {
  const input = "`~/.agents/skills/commit/SKILL.md` と `~/.claude/skills/pr/SKILL.md`";
  assert.equal(rewriteSkillRefsToUserScope(input), input);
  const once = rewriteSkillRefsToUserScope("`.agents/skills/commit/SKILL.md`");
  assert.equal(rewriteSkillRefsToUserScope(once), once);
});

test("leaves refs embedded in longer paths untouched", () => {
  const input = "consumers read from dist/claude-code/.claude/skills/foo/SKILL.md instead";
  assert.equal(rewriteSkillRefsToUserScope(input), input);
});

test("leaves other dot-directories untouched", () => {
  const input =
    ".claude/worktrees/agent-1/ と .claude/agents/code-reviewer.md と .agents/agents-template/";
  assert.equal(rewriteSkillRefsToUserScope(input), input);
});

test("dist payload contains no repo-root-relative skill refs", async () => {
  for (const adapterId of ["claude-code", "codex-cli", "gemini-cli", "copilot"]) {
    const root = join(DIST, adapterId);
    for (const file of await walkFiles(root)) {
      if (!file.endsWith(".md")) continue;
      const content = await readFile(file, "utf8");
      assert.equal(
        content,
        rewriteSkillRefsToUserScope(content),
        `${file.replace(ROOT, "")} contains repo-root-relative skill refs`,
      );
    }
  }
});

test("dist claude-code wrappers reference canonical skills via ~/.agents/skills/", async () => {
  const wrapper = await readFile(
    join(DIST, "claude-code", ".claude", "skills", "drive", "SKILL.md"),
    "utf8",
  );
  assert.match(wrapper, /~\/\.agents\/skills\/drive\/SKILL\.md/);
});
