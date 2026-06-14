// drive `--usage-guard` overlay wiring (issue #122).
//
// The pause/resume mechanism is Claude-specific (OAuth usage endpoint +
// ScheduleWakeup), so the wiring lives in the Claude Code overlay
// (src/skills/drive/SKILL.claude-code.md) — the precedent is `review --deep`.
// The neutral drive/SKILL.md only documents the flag as Claude Code only.
//
// These are simple string-contains assertions over (a) the source companion,
// (b) the built claude-code output (companion emitted verbatim as
// .claude/skills/drive/SKILL.md), and (c) the neutral SKILL.md.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter } from "../scripts/adapters/claude-code.mjs";
import { assertRequiredFields, parseSkillDocument } from "../scripts/lib/frontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src", "skills");

async function loadCompanion(name, suffix, requiredFields) {
  const file = join(SRC, name, `SKILL.${suffix}.md`);
  if (!existsSync(file)) return null;
  const raw = await readFile(file, "utf8");
  const label = `src/skills/${name}/SKILL.${suffix}.md`;
  const { frontmatter, body } = parseSkillDocument(raw, label);
  assertRequiredFields(frontmatter, requiredFields, label);
  return { frontmatter, body, raw };
}

async function loadSkill(name) {
  const file = join(SRC, name, "SKILL.md");
  const raw = await readFile(file, "utf8");
  const label = `src/skills/${name}/SKILL.md`;
  const { frontmatter, body } = parseSkillDocument(raw, label);
  assertRequiredFields(frontmatter, ["name", "description"], label);
  const claudeCodeCompanion = await loadCompanion(name, "claude-code", ["description"]);
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    frontmatter,
    body,
    raw,
    claudeCodeCompanion,
  };
}

// --- source companion: the wiring section -----------------------------------

test("drive claude-code companion documents the --usage-guard flag + section", async () => {
  const companion = await loadCompanion("drive", "claude-code", ["description"]);
  assert.ok(companion, "src/skills/drive/SKILL.claude-code.md must exist");
  const raw = companion.raw;
  // argument-hint advertises the flag
  assert.match(raw, /argument-hint:.*--usage-guard/);
  // dedicated wiring section
  assert.ok(
    raw.includes("usage-guard 配線（`--usage-guard`）"),
    "companion must carry a dedicated usage-guard wiring section",
  );
});

test("drive companion places checkpoints at the four resumable-unit boundaries", async () => {
  const companion = await loadCompanion("drive", "claude-code", ["description"]);
  const raw = companion.raw;
  // Phase 1 start (single mode)
  assert.ok(raw.includes("Phase 1"), "checkpoint at Phase 1 (implement) start");
  // each review-loop iteration
  assert.ok(raw.includes("review loop"), "checkpoint before each review-loop iteration");
  // each wave (orchestration)
  assert.ok(raw.includes("wave"), "checkpoint before each wave");
  // before worker dispatch (orchestration)
  assert.ok(raw.includes("worker dispatch"), "checkpoint before worker dispatch");
});

test("drive companion delegates over-threshold to the usage-guard wait-loop + idempotent resume", async () => {
  const companion = await loadCompanion("drive", "claude-code", ["description"]);
  const raw = companion.raw;
  // Reads/invokes the usage-guard engine
  assert.ok(raw.includes("usage-guard"), "references the usage-guard engine");
  assert.ok(raw.includes("ScheduleWakeup"), "delegates to ScheduleWakeup-based wait-loop");
  // continuation command is /drive --usage-guard <original args>
  assert.ok(
    raw.includes("/drive --usage-guard"),
    "continuation command is /drive --usage-guard <original args>",
  );
  // checkpoints must sit at resumable boundaries — must NOT pause mid-implement
  assert.ok(
    raw.includes("mid-implement") || raw.includes("PR がまだ存在しない"),
    "must note checkpoints sit at resumable-unit boundaries (no mid-implement pause)",
  );
});

// --- built claude-code output (companion emitted verbatim) ------------------

test("built claude-code drive output carries the --usage-guard wiring", async () => {
  const drive = await loadSkill("drive");
  const out = await new ClaudeCodeAdapter().generate([drive]);
  const driveOut = out.find((o) => o.relativePath === ".claude/skills/drive/SKILL.md");
  assert.ok(driveOut, "claude-code adapter emits .claude/skills/drive/SKILL.md");
  assert.match(driveOut.content, /--usage-guard/);
  assert.ok(driveOut.content.includes("ScheduleWakeup"));
  assert.ok(driveOut.content.includes("/drive --usage-guard"));
});

// --- neutral SKILL.md: flag is documented as Claude Code only ---------------

test("neutral drive SKILL.md documents --usage-guard as Claude Code only", async () => {
  const raw = await readFile(join(SRC, "drive", "SKILL.md"), "utf8");
  assert.match(raw, /--usage-guard/);
  // marked Claude Code only (same treatment as review --deep)
  assert.ok(
    raw.includes("Claude Code 環境のみ") || raw.includes("Claude Code only"),
    "neutral SKILL.md must mark --usage-guard as Claude Code only",
  );
  // wave-boundary granularity + PreToolUse hook ceiling noted
  assert.ok(raw.includes("wave 境界"), "notes orchestration pauses at wave-boundary granularity");
  assert.ok(
    raw.includes("PreToolUse hook"),
    "notes an in-flight worker's ceiling is the PreToolUse hook",
  );
});
