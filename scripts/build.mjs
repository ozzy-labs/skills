#!/usr/bin/env node
// Build the @ozzylabs/skills distribution bundle.
//
// Reads canonical skill files from src/skills/{name}/SKILL.md, validates each
// has the required frontmatter (name, description), and copies them into
// dist/.agents/skills/{name}/SKILL.md so consumer repos can drop the dist
// tree directly into their own .agents/skills/.

import { readdir, readFile, mkdir, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src", "skills");
const OUT = join(ROOT, "dist", ".agents", "skills");

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;

async function readSkillNames() {
  const entries = await readdir(SRC, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

function parseFrontmatter(text, fileLabel) {
  const match = text.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(`${fileLabel}: missing frontmatter (--- ... ---)`);
  }
  const fm = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    fm[key] = value;
  }
  for (const required of ["name", "description"]) {
    if (!fm[required]) {
      throw new Error(`${fileLabel}: frontmatter missing required field '${required}'`);
    }
  }
  return fm;
}

async function main() {
  if (existsSync(OUT)) {
    await rm(OUT, { recursive: true, force: true });
  }
  await mkdir(OUT, { recursive: true });

  const names = await readSkillNames();
  if (names.length === 0) {
    throw new Error(`No skills found under ${SRC}`);
  }

  for (const name of names) {
    const srcFile = join(SRC, name, "SKILL.md");
    const text = await readFile(srcFile, "utf8");
    const fm = parseFrontmatter(text, `src/skills/${name}/SKILL.md`);
    if (fm.name !== name) {
      throw new Error(
        `src/skills/${name}/SKILL.md: frontmatter name='${fm.name}' does not match directory name='${name}'`,
      );
    }
    const destDir = join(OUT, name);
    await mkdir(destDir, { recursive: true });
    await copyFile(srcFile, join(destDir, "SKILL.md"));
  }

  console.log(`✓ Built ${names.length} skill(s) → dist/.agents/skills/`);
  for (const name of names) {
    console.log(`  - ${name}`);
  }
}

main().catch((err) => {
  console.error(`✗ Build failed: ${err.message}`);
  process.exit(1);
});
