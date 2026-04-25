#!/usr/bin/env node
// Build the @ozzylabs/skills distribution bundle and self-consume mirror.
//
// Reads canonical skill files from src/skills/{name}/SKILL.md, validates each
// has the required frontmatter (name, description), and writes them to:
//   - dist/.agents/skills/{name}/SKILL.md   (npm package payload, Renovate consumers)
//   - .agents/skills/{name}/SKILL.md        (in-repo Codex / Copilot adapter)
//   - .claude/skills/{name}/SKILL.md        (in-repo Claude Code adapter)
//
// The two latter trees let this repository dogfood its own skills during
// development. CI verifies all three are in sync with src/ so a stale mirror
// fails the build.

import { readdir, readFile, mkdir, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillDocument, assertRequiredFields } from "./lib/frontmatter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src", "skills");

const TARGETS = [
  join(ROOT, "dist", ".agents", "skills"),
  join(ROOT, ".agents", "skills"),
  join(ROOT, ".claude", "skills"),
];

async function readSkillNames() {
  const entries = await readdir(SRC, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

async function emit(target, name, srcFile) {
  const destDir = join(target, name);
  await mkdir(destDir, { recursive: true });
  await copyFile(srcFile, join(destDir, "SKILL.md"));
}

async function main() {
  const names = await readSkillNames();
  if (names.length === 0) {
    throw new Error(`No skills found under ${SRC}`);
  }

  // Validate first so we do not partially overwrite mirrors.
  const validated = [];
  for (const name of names) {
    const srcFile = join(SRC, name, "SKILL.md");
    const text = await readFile(srcFile, "utf8");
    const label = `src/skills/${name}/SKILL.md`;
    const { frontmatter } = parseSkillDocument(text, label);
    assertRequiredFields(frontmatter, ["name", "description"], label);
    if (frontmatter.name !== name) {
      throw new Error(
        `${label}: frontmatter name='${frontmatter.name}' does not match directory name='${name}'`,
      );
    }
    validated.push({ name, srcFile });
  }

  for (const target of TARGETS) {
    if (existsSync(target)) {
      await rm(target, { recursive: true, force: true });
    }
    await mkdir(target, { recursive: true });
    for (const { name, srcFile } of validated) {
      await emit(target, name, srcFile);
    }
  }

  console.log(`✓ Built ${names.length} skill(s) → 3 targets:`);
  for (const target of TARGETS) {
    console.log(`  ${target.replace(ROOT, "").replace(/^\//, "")}`);
  }
  console.log("Skills:");
  for (const { name } of validated) {
    console.log(`  - ${name}`);
  }
}

main().catch((err) => {
  console.error(`✗ Build failed: ${err.message}`);
  process.exit(1);
});
