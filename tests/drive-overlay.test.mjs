// drive usage-guard overlay wiring (issue #122 → default-on opt-out #130).
//
// The pause/resume mechanism is Claude-specific (OAuth usage endpoint +
// ScheduleWakeup), so the wiring lives in the Claude Code overlay
// (.agents/skills/drive/SKILL.claude-code.md) — the precedent is `review --deep`.
// The neutral drive/SKILL.md only documents the behavior as Claude Code only.
//
// #130 flips usage-guard from opt-in (`--usage-guard`) to default-on
// (opt-out via `--no-usage-guard`); `--usage-guard` survives as a deprecated
// no-op alias and the continuation command drops the forced flag (`/drive
// <args>`).
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
const SRC = join(ROOT, ".agents", "skills");

async function loadCompanion(name, suffix, requiredFields) {
  const file = join(SRC, name, `SKILL.${suffix}.md`);
  if (!existsSync(file)) return null;
  const raw = await readFile(file, "utf8");
  const label = `.agents/skills/${name}/SKILL.${suffix}.md`;
  const { frontmatter, body } = parseSkillDocument(raw, label);
  assertRequiredFields(frontmatter, requiredFields, label);
  return { frontmatter, body, raw };
}

async function loadSkill(name) {
  const file = join(SRC, name, "SKILL.md");
  const raw = await readFile(file, "utf8");
  const label = `.agents/skills/${name}/SKILL.md`;
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

// --- source companion: default-on opt-out + wiring section ------------------

test("drive claude-code companion advertises --no-usage-guard + default-on wiring section", async () => {
  const companion = await loadCompanion("drive", "claude-code", ["description"]);
  assert.ok(companion, ".agents/skills/drive/SKILL.claude-code.md must exist");
  const raw = companion.raw;
  // argument-hint advertises the opt-out flag (not the legacy opt-in flag)
  assert.match(raw, /argument-hint:.*\[--no-usage-guard\]/);
  assert.ok(
    !/argument-hint:.*\[--usage-guard\]/.test(raw),
    "argument-hint must not advertise the legacy opt-in --usage-guard flag",
  );
  // dedicated wiring section, now keyed on the opt-out flag
  assert.ok(
    raw.includes("usage-guard 配線（既定 ON・`--no-usage-guard` で無効化）"),
    "companion must carry a default-on usage-guard wiring section keyed on --no-usage-guard",
  );
  // default-on wording present
  assert.ok(raw.includes("既定で有効"), "must document usage-guard as default-on (既定で有効)");
});

test("drive companion keeps --usage-guard as a deprecated no-op alias", async () => {
  const companion = await loadCompanion("drive", "claude-code", ["description"]);
  const raw = companion.raw;
  assert.ok(
    raw.includes("--usage-guard") && raw.includes("no-op"),
    "must accept --usage-guard as a deprecated no-op alias for back-compat",
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

test("drive companion gates wave/worker dispatch with headroom-aware projection (#141)", async () => {
  const companion = await loadCompanion("drive", "claude-code", ["description"]);
  const raw = companion.raw;
  // dispatch checkpoints pass --headroom derived from --concurrency
  assert.ok(raw.includes("--headroom"), "dispatch checkpoint passes --headroom to usage-check");
  assert.ok(
    raw.includes("--concurrency") && raw.includes("reserve"),
    "headroom (reserve) must be derived from the concurrency (--concurrency)",
  );
  // worked example so the prose is actionable (concurrency=3 → reserve=12)
  assert.ok(
    raw.includes("in-wave overshoot") || raw.includes("overshoot"),
    "must name the in-wave overshoot failure mode the headroom gate addresses",
  );
  // single-mode checkpoints stay headroom=0 (legacy gate on current util)
  assert.ok(
    raw.includes("単一モードの Phase1 / review-loop checkpoint は headroom を渡さない"),
    "single-mode checkpoints must NOT pass headroom (legacy gate on current util)",
  );
  // two-layer defense: boundary pause + #123 mid-unit hook elevated to default
  assert.ok(
    raw.includes("二層防御") && raw.includes("#123"),
    "must document the two-layer defense (boundary pause + #123 mid-unit hook)",
  );
});

test("drive companion documents graceful degrade when the usage-guard skill is absent", async () => {
  const companion = await loadCompanion("drive", "claude-code", ["description"]);
  const raw = companion.raw;
  assert.ok(
    raw.includes("graceful degrade（skill 不在）"),
    "companion must carry a graceful-degrade section for an absent usage-guard skill",
  );
  // 1-line warning + continue (fail-open) when the skill / usage-check.mjs is missing
  assert.ok(
    raw.includes("未インストール") || raw.includes("未配置"),
    "graceful degrade must cover the skill-not-installed case",
  );
  assert.ok(raw.includes("fail-open"), "skill-absent path must be treated as fail-open");
});

test("drive companion delegates over-threshold to the usage-guard wait-loop + idempotent resume", async () => {
  const companion = await loadCompanion("drive", "claude-code", ["description"]);
  const raw = companion.raw;
  // Reads/invokes the usage-guard engine
  assert.ok(raw.includes("usage-guard"), "references the usage-guard engine");
  assert.ok(raw.includes("ScheduleWakeup"), "delegates to ScheduleWakeup-based wait-loop");
  // continuation command is /drive <original args> — must NOT force --usage-guard
  assert.ok(raw.includes("/drive <元の引数>"), "continuation command is /drive <original args>");
  assert.ok(
    !raw.includes("/drive --usage-guard"),
    "continuation command must not force --usage-guard (default-on resume)",
  );
  // CronCreate resume trigger for >1h / non-/loop waits
  assert.ok(raw.includes("CronCreate"), "documents the CronCreate one-shot resume trigger");
  // checkpoints must sit at resumable boundaries — must NOT pause mid-implement
  assert.ok(
    raw.includes("mid-implement") || raw.includes("PR がまだ存在しない"),
    "must note checkpoints sit at resumable-unit boundaries (no mid-implement pause)",
  );
});

// --- built claude-code output (companion emitted verbatim) ------------------

test("built claude-code drive output carries the default-on usage-guard wiring", async () => {
  const drive = await loadSkill("drive");
  const out = await new ClaudeCodeAdapter().generate([drive]);
  const driveOut = out.find((o) => o.relativePath === ".claude/skills/drive/SKILL.md");
  assert.ok(driveOut, "claude-code adapter emits .claude/skills/drive/SKILL.md");
  assert.match(driveOut.content, /--no-usage-guard/);
  assert.ok(driveOut.content.includes("ScheduleWakeup"));
  assert.ok(driveOut.content.includes("/drive <元の引数>"));
  assert.ok(
    !driveOut.content.includes("/drive --usage-guard"),
    "built output must not force --usage-guard in the continuation command",
  );
});

// --- neutral SKILL.md: behavior is documented as Claude Code only -----------

test("neutral drive SKILL.md documents usage-guard as default-on + Claude Code only", async () => {
  const raw = await readFile(join(SRC, "drive", "SKILL.md"), "utf8");
  // opt-out flag is documented
  assert.match(raw, /--no-usage-guard/);
  // default-on wording
  assert.ok(raw.includes("既定で有効"), "neutral SKILL.md must document usage-guard as default-on");
  // --usage-guard survives as a deprecated no-op alias
  assert.ok(
    raw.includes("--usage-guard") && raw.includes("no-op"),
    "neutral SKILL.md must keep --usage-guard as a deprecated no-op alias",
  );
  // marked Claude Code only (same treatment as review --deep)
  assert.ok(
    raw.includes("Claude Code 環境のみ") || raw.includes("Claude Code only"),
    "neutral SKILL.md must mark usage-guard as Claude Code only",
  );
  // continuation command drops the forced flag
  assert.ok(
    raw.includes("/drive <元の引数>"),
    "neutral SKILL.md continuation command is /drive <original args>",
  );
  // wave-boundary granularity + PreToolUse hook ceiling noted
  assert.ok(raw.includes("wave 境界"), "notes orchestration pauses at wave-boundary granularity");
  assert.ok(
    raw.includes("PreToolUse hook"),
    "notes an in-flight worker's ceiling is the PreToolUse hook",
  );
});
