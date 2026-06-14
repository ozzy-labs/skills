#!/usr/bin/env node
// Build the @ozzylabs/skills distribution bundle and self-consume mirror.
//
// Reads canonical skill files from src/skills/{name}/SKILL.md, validates the
// frontmatter, and emits two kinds of output:
//
//   1. In-repo dogfood mirrors (NOT part of the npm payload; excluded via
//      `package.json#files`):
//        - .agents/skills/{name}/SKILL.md        (Codex CLI / Gemini CLI dogfood)
//        - .claude/skills/{name}/SKILL.md        (Claude Code dogfood)
//      Plus any non-SKILL.* files under each skill dir (e.g. perspectives/).
//      These are kept because skills repo dogfoods its own skill bundle via
//      slash commands, but they are not shipped to npm consumers.
//
//   2. Adapter outputs under dist/{adapter-id}/, produced by AdapterBase
//      subclasses. These are the canonical npm payload for consumers — each
//      consumer opts in to one or more adapter ids via `skills_adapters` in
//      `.commons/sync.yaml`. Adapters are pure functions; this orchestrator
//      is the sole writer.
//
//   3. Claude Code agents loaded from src/agents/<name>.md and emitted
//      as dist/claude-code/.claude/agents/<name>.md (ADR-0026).
//
// The legacy `dist/.agents/skills/` and `dist/.claude/skills/` outputs that
// duplicated adapter content have been removed (issue #97); consumers should
// read from `dist/{adapter-id}/` instead.

import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter } from "./adapters/claude-code.mjs";
import { CodexCliAdapter } from "./adapters/codex-cli.mjs";
import { CopilotAdapter } from "./adapters/copilot.mjs";
import { GeminiCliAdapter } from "./adapters/gemini-cli.mjs";
import { isAdapterAllowed, parseAdapters } from "./lib/adapter-gating.mjs";
import { assertRequiredFields, parseSkillDocument } from "./lib/frontmatter.mjs";
import { rewriteSkillRefsToUserScope } from "./lib/user-scope-refs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src", "skills");
const SRC_AGENTS = join(ROOT, "src", "agents");
const DIST = join(ROOT, "dist");

// In-repo dogfood targets: these mirror the canonical skill files into
// `.agents/skills/` and `.claude/skills/` so the skills repo can use its own
// slash commands (e.g. `/drive`, `/lint`). They are NOT shipped to npm —
// `package.json#files` only includes `dist/`, `bin/`, `schemas/`, etc.
const CLAUDE_DOGFOOD_TARGET = join(ROOT, ".claude", "skills");
// Each dogfood target mirrors the canonical skills for the adapter(s) that
// read from it: `.agents/skills/` feeds Codex CLI + Gemini CLI, `.claude/skills/`
// feeds Claude Code. A skill restricted via frontmatter `adapters` is mirrored
// into a target only when it is allowed for at least one of that target's
// adapters (e.g. an `adapters: claude-code` skill is kept out of `.agents/skills/`).
const DOGFOOD_TARGETS = [
  { dir: join(ROOT, ".agents", "skills"), adapterIds: ["codex-cli", "gemini-cli"] },
  { dir: CLAUDE_DOGFOOD_TARGET, adapterIds: ["claude-code"] },
];

// Internal-use skills are kept in src/skills/ for skills/commons repo's own
// dogfooding (via DOGFOOD_TARGETS) but MUST NOT be shipped to npm consumers.
// See handbook ADR-0027: project skills are limited to skills/commons internal
// use; the npm payload only carries the generic 10. Excluding them from
// `writeAdapterOutputs` keeps them out of `dist/{adapter-id}/` and therefore
// out of `npm pack` (which only ships `dist/`).
const INTERNAL_SKILLS = new Set(["health", "topics", "phase-issue"]);

const ADAPTERS = [
  new ClaudeCodeAdapter(),
  new CodexCliAdapter(),
  new GeminiCliAdapter(),
  new CopilotAdapter(),
];

// Project-scope payload id (dist subdirectory). Unlike the per-adapter outputs
// above, this one keeps repo-root-relative skill refs (no user-scope rewrite)
// so it can be committed into a consumer repo for Claude mobile / web (cloud)
// sessions. See writeProjectScopeOutput + handbook ADR-0027 (project-scope
// opt-in) for the rationale.
const PROJECT_SCOPE_ID = "claude-code-project";

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
    // Validate + normalize the optional `adapters` gate once at load time so a
    // typo'd adapter id fails the build early (rather than per-adapter later).
    const adapters = parseAdapters(frontmatter, label);
    skills.push({
      name,
      description: frontmatter.description,
      frontmatter,
      body,
      raw,
      claudeCodeCompanion,
      extraFiles,
      adapters,
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

async function writeDogfoodTargets(skills) {
  // Write in-repo dogfood mirrors at `.agents/skills/` and `.claude/skills/`.
  // These are excluded from the npm payload by `package.json#files` but kept
  // in the repo so skills repo can use its own slash commands.
  for (const target of DOGFOOD_TARGETS) {
    if (existsSync(target.dir)) {
      await rm(target.dir, { recursive: true, force: true });
    }
    await mkdir(target.dir, { recursive: true });
    // The in-repo .claude/skills/ mirror is what this repo loads when it
    // dogfoods its own skills. Use the Claude Code companion when present so
    // dogfood stays in sync with what the Claude Code adapter ships to
    // consumers.
    const useCompanion = target.dir === CLAUDE_DOGFOOD_TARGET;
    // Mirror a skill only when it is allowed for one of this target's adapters
    // (adapter gating — keeps e.g. `adapters: claude-code` skills out of `.agents/skills/`).
    const targetSkills = skills.filter((skill) =>
      target.adapterIds.some((id) => isAdapterAllowed(skill, id)),
    );
    for (const skill of targetSkills) {
      const destDir = join(target.dir, skill.name);
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

async function cleanupRemovedLegacyTargets() {
  // Defensive: remove the previously-generated `dist/.agents/skills/` and
  // `dist/.claude/skills/` directories if they exist from an older build.
  // The new build pipeline (issue #97) no longer writes them — they were
  // duplicates of `dist/codex-cli/.agents/skills/` and
  // `dist/claude-code/.claude/skills/` respectively. Consumers should read
  // from `dist/{adapter-id}/` instead.
  const removed = [join(DIST, ".agents"), join(DIST, ".claude")];
  for (const target of removed) {
    if (existsSync(target)) {
      await rm(target, { recursive: true, force: true });
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
      // dist/ is the user-scope install payload (ADR-0027): repo-root-relative
      // skill refs must become `~/`-prefixed here. Dogfood mirrors above keep
      // the relative form, and adapters stay verbatim (pure functions).
      await writeFile(dest, rewriteSkillRefsToUserScope(out.content));
    }
  }
}

async function writeProjectScopeOutput(skills, agents) {
  // Project-scope payload for Claude mobile / web (cloud) sessions.
  //
  // Cloud sessions run "repo only": they see a consumer repo's committed
  // `.claude/skills/` but never the user-scope `~/.claude/skills/` that the CLI
  // installer populates. So `dist/{adapter}/` is useless there — its refs were
  // rewritten to `~/.agents/skills/<name>/SKILL.md` by writeAdapterOutputs and
  // resolve against an empty HOME.
  //
  // This payload is the project-scope counterpart. It ships the Claude Code
  // wrappers (`.claude/skills/`, `.claude/agents/`) AND the canonical
  // `.agents/skills/` SKILL.md files those wrappers Read, all with
  // repo-root-relative refs PRESERVED (the user-scope rewrite is intentionally
  // skipped). `npx @ozzylabs/skills sync-project --target <repo>` copies it into
  // a consumer repo so cloud Claude can discover and run the skills.
  const root = join(DIST, PROJECT_SCOPE_ID);
  if (existsSync(root)) {
    await rm(root, { recursive: true, force: true });
  }
  const claudeOutputs = await new ClaudeCodeAdapter().generate(skills, { agents });
  const codexOutputs = await new CodexCliAdapter().generate(skills);
  const outputs = [
    ...claudeOutputs,
    // Only the canonical SKILL.md (+ extras) under .agents/skills/ — the files
    // the Claude wrapper Reads. The AGENTS.md.snippet is an AGENTS.md
    // aggregation artifact, irrelevant to skill discovery, so it is dropped.
    ...codexOutputs.filter((out) => out.relativePath.startsWith(".agents/skills/")),
  ];
  for (const out of outputs) {
    const dest = join(root, out.relativePath);
    await mkdir(dirname(dest), { recursive: true });
    // Verbatim — NO rewriteSkillRefsToUserScope. Relative refs are the point.
    await writeFile(dest, out.content);
  }
}

async function main() {
  const skills = await loadSkills();
  const agents = await loadAgents();
  await cleanupRemovedLegacyTargets();
  await writeDogfoodTargets(skills);
  const publicSkills = skills.filter((s) => !INTERNAL_SKILLS.has(s.name));
  await writeAdapterOutputs(publicSkills, agents);
  await writeProjectScopeOutput(publicSkills, agents);
  await writeSyncHelpers();

  const internalNames = skills.filter((s) => INTERNAL_SKILLS.has(s.name)).map((s) => s.name);
  console.log(`✓ Built ${skills.length} skill(s), ${agents.length} agent(s)`);
  console.log("In-repo dogfood (excluded from npm payload):");
  for (const target of DOGFOOD_TARGETS) {
    console.log(`  ${target.dir.replace(ROOT, "").replace(/^\//, "")}`);
  }
  console.log(`Adapters (npm payload, ${publicSkills.length} public skill(s)):`);
  for (const adapter of ADAPTERS) {
    console.log(`  dist/${adapter.constructor.id}/`);
  }
  console.log("Project-scope payload (Claude mobile/web, relative refs):");
  console.log(`  dist/${PROJECT_SCOPE_ID}/`);
  if (internalNames.length > 0) {
    console.log(`Internal skills (dogfood only, not shipped): ${internalNames.join(", ")}`);
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
