#!/usr/bin/env node
// Build the @ozzylabs/skills distribution bundle and self-consume mirror.
//
// Reads canonical skill files from src/skills/{name}/SKILL.md, validates the
// frontmatter, and emits two kinds of output:
//
//   1. Legacy 3-target copy (kept until the staged migration in #14):
//        - dist/.agents/skills/{name}/SKILL.md   (npm payload / Renovate consumers)
//        - .agents/skills/{name}/SKILL.md        (in-repo dogfood)
//        - .claude/skills/{name}/SKILL.md        (in-repo dogfood)
//      Plus any non-SKILL.* files under each skill dir (e.g. perspectives/).
//
//   2. Adapter outputs under dist/{adapter-id}/, produced by AdapterBase
//      subclasses. Adapters are pure functions; this orchestrator is the
//      sole writer.
//
//   3. Claude Code agents loaded from src/agents/<name>.md and emitted
//      as dist/claude-code/.claude/agents/<name>.md (ADR-0026).

import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter } from "./adapters/claude-code.mjs";
import { CodexCliAdapter } from "./adapters/codex-cli.mjs";
import { CopilotAdapter } from "./adapters/copilot.mjs";
import { GeminiCliAdapter } from "./adapters/gemini-cli.mjs";
import { assertRequiredFields, parseSkillDocument } from "./lib/frontmatter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src", "skills");
const SRC_AGENTS = join(ROOT, "src", "agents");
const DIST = join(ROOT, "dist");

const CLAUDE_LEGACY_TARGET = join(ROOT, ".claude", "skills");
const LEGACY_TARGETS = [
  join(ROOT, "dist", ".agents", "skills"),
  join(ROOT, ".agents", "skills"),
  CLAUDE_LEGACY_TARGET,
];

const ADAPTERS = [
  new ClaudeCodeAdapter(),
  new CodexCliAdapter(),
  new GeminiCliAdapter(),
  new CopilotAdapter(),
];

async function readSkillNames() {
  const entries = await readdir(SRC, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

async function loadCompanion(name, adapterSuffix, requiredFields) {
  const file = join(SRC, name, `SKILL.${adapterSuffix}.md`);
  if (!existsSync(file)) return null;
  const raw = await readFile(file, "utf8");
  const label = `src/skills/${name}/SKILL.${adapterSuffix}.md`;
  const { frontmatter, body } = parseSkillDocument(raw, label);
  assertRequiredFields(frontmatter, requiredFields, label);
  return { frontmatter, body, raw };
}

async function walkFiles(dir) {
  // Recursively walk a directory and return a sorted list of absolute file paths.
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

async function loadExtraFiles(skillName) {
  // Collect any files under src/skills/<name>/ that are NOT the canonical
  // SKILL.md or an adapter companion (SKILL.<adapter>.md). These are
  // additional skill assets (e.g. perspectives/<axis>.md) that need to be
  // copied verbatim into every skill dest dir.
  const skillDir = join(SRC, skillName);
  const all = await walkFiles(skillDir);
  const extras = [];
  for (const file of all) {
    const rel = relative(skillDir, file);
    if (rel === "SKILL.md") continue;
    if (/^SKILL\.[a-z0-9-]+\.md$/.test(rel)) continue;
    const content = await readFile(file, "utf8");
    extras.push({ relativePath: rel, content });
  }
  return extras;
}

async function loadSkills() {
  const names = await readSkillNames();
  if (names.length === 0) {
    throw new Error(`No skills found under ${SRC}`);
  }
  const skills = [];
  for (const name of names) {
    const srcFile = join(SRC, name, "SKILL.md");
    const raw = await readFile(srcFile, "utf8");
    const label = `src/skills/${name}/SKILL.md`;
    const { frontmatter, body } = parseSkillDocument(raw, label);
    assertRequiredFields(frontmatter, ["name", "description"], label);
    if (frontmatter.name !== name) {
      throw new Error(
        `${label}: frontmatter name='${frontmatter.name}' does not match directory name='${name}'`,
      );
    }
    const claudeCodeCompanion = await loadCompanion(name, "claude-code", ["description"]);
    const extraFiles = await loadExtraFiles(name);
    skills.push({
      name,
      description: frontmatter.description,
      frontmatter,
      body,
      raw,
      claudeCodeCompanion,
      extraFiles,
    });
  }
  return skills;
}

async function loadAgents() {
  if (!existsSync(SRC_AGENTS)) return [];
  const entries = await readdir(SRC_AGENTS, { withFileTypes: true });
  const agents = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = join(SRC_AGENTS, entry.name);
    const raw = await readFile(file, "utf8");
    const label = `src/agents/${entry.name}`;
    const { frontmatter, body } = parseSkillDocument(raw, label);
    assertRequiredFields(frontmatter, ["name", "description", "tools"], label);
    const expected = entry.name.replace(/\.md$/, "");
    if (frontmatter.name !== expected) {
      throw new Error(
        `${label}: frontmatter name='${frontmatter.name}' does not match file name='${expected}'`,
      );
    }
    agents.push({ name: frontmatter.name, frontmatter, body, raw });
  }
  return agents;
}

async function writeLegacyTargets(skills) {
  for (const target of LEGACY_TARGETS) {
    if (existsSync(target)) {
      await rm(target, { recursive: true, force: true });
    }
    await mkdir(target, { recursive: true });
    // The in-repo .claude/skills/ mirror is what this repo loads when it
    // dogfoods its own skills. Use the Claude Code companion when present so
    // dogfood stays in sync with what the Claude Code adapter ships to
    // consumers.
    const useCompanion = target === CLAUDE_LEGACY_TARGET;
    for (const skill of skills) {
      const destDir = join(target, skill.name);
      await mkdir(destDir, { recursive: true });
      const content =
        useCompanion && skill.claudeCodeCompanion ? skill.claudeCodeCompanion.raw : skill.raw;
      await writeFile(join(destDir, "SKILL.md"), content);
      for (const extra of skill.extraFiles ?? []) {
        const dest = join(destDir, extra.relativePath);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, extra.content);
      }
    }
  }
}

async function writeSyncHelpers() {
  const src = join(ROOT, "scripts", "sync", "replace-snippet.sh");
  const destDir = join(DIST, "sync");
  if (existsSync(destDir)) {
    await rm(destDir, { recursive: true, force: true });
  }
  await mkdir(destDir, { recursive: true });
  const dest = join(destDir, "replace-snippet.sh");
  await copyFile(src, dest);
  await chmod(dest, 0o755);
}

async function writeAdapterOutputs(skills, agents) {
  for (const adapter of ADAPTERS) {
    const id = adapter.constructor.id;
    if (!id) {
      throw new Error(`${adapter.constructor.name} is missing static id`);
    }
    const adapterRoot = join(DIST, id);
    if (existsSync(adapterRoot)) {
      await rm(adapterRoot, { recursive: true, force: true });
    }
    const outputs = await adapter.generate(skills, { agents });
    for (const out of outputs) {
      const dest = join(adapterRoot, out.relativePath);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, out.content);
    }
  }
}

async function main() {
  const skills = await loadSkills();
  const agents = await loadAgents();
  await writeLegacyTargets(skills);
  await writeAdapterOutputs(skills, agents);
  await writeSyncHelpers();

  console.log(`✓ Built ${skills.length} skill(s), ${agents.length} agent(s)`);
  console.log("Legacy targets:");
  for (const target of LEGACY_TARGETS) {
    console.log(`  ${target.replace(ROOT, "").replace(/^\//, "")}`);
  }
  console.log("Adapters:");
  for (const adapter of ADAPTERS) {
    console.log(`  dist/${adapter.constructor.id}/`);
  }
  console.log("Sync helpers:");
  console.log("  dist/sync/replace-snippet.sh");
  console.log("Skills:");
  for (const skill of skills) {
    console.log(`  - ${skill.name}`);
  }
  if (agents.length > 0) {
    console.log("Agents (Claude Code only):");
    for (const agent of agents) {
      console.log(`  - ${agent.name}`);
    }
  }
}

main().catch((err) => {
  console.error(`✗ Build failed: ${err.message}`);
  process.exit(1);
});
