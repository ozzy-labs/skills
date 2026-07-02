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
import { loadExtraFiles } from "../scripts/build.mjs";
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
  const claudeCodeCompanion = await loadCompanion(name, "claude-code", []);
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
  const companion = await loadCompanion("drive", "claude-code", []);
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
  const companion = await loadCompanion("drive", "claude-code", []);
  const raw = companion.raw;
  assert.ok(
    raw.includes("--usage-guard") && raw.includes("no-op"),
    "must accept --usage-guard as a deprecated no-op alias for back-compat",
  );
});

test("drive companion places checkpoints at the four resumable-unit boundaries", async () => {
  const companion = await loadCompanion("drive", "claude-code", []);
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
  const companion = await loadCompanion("drive", "claude-code", []);
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
  const companion = await loadCompanion("drive", "claude-code", []);
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
  const companion = await loadCompanion("drive", "claude-code", []);
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

// --- #166: self-closing --merge (pre-merge audit + reconciliation) -----------
//
// Orchestration --merge must leave no follow-up: workers stop at merge-ready,
// the parent centralizes merge, and cross-cutting gaps are detected before
// merge (Final-2) then folded into the introducing PR (Final-3) — all while
// the worker worktrees still exist (cleanup moved to Final-5, last).

test("neutral drive SKILL.md: workers do not self-merge; parent centralizes merge", async () => {
  const raw = await readFile(join(SRC, "drive", "SKILL.md"), "utf8");
  // worker stops at merge-ready (Phase 4 skipped for workers)
  assert.ok(
    raw.includes("worker は Phase 4"),
    "documents that orchestration workers skip Phase 4 (do not self-merge)",
  );
  // worker return status capped at merge-ready
  assert.ok(
    raw.includes('"status": "merge-ready" | "failed"'),
    "worker return status is capped at merge-ready | failed",
  );
  // parent merges in dependency order at Final-4
  assert.ok(
    raw.includes("Phase Final-4: 依存順マージ"),
    "documents Final-4 parent-centralized dependency-order merge",
  );
});

test("neutral drive SKILL.md: Final phases reordered — audit pre-merge, cleanup last", async () => {
  const raw = await readFile(join(SRC, "drive", "SKILL.md"), "utf8");
  // Final-2 audit is pre-merge
  assert.ok(
    raw.includes("Phase Final-2: cross-cutting audit（マージ前"),
    "Final-2 cross-cutting audit runs pre-merge",
  );
  // Final-3 reconciliation folds into the introducing PR
  assert.ok(
    raw.includes("Phase Final-3: reconciliation") && raw.includes("導入元 PR"),
    "Final-3 reconciliation folds gaps into the introducing PR",
  );
  // cleanup moved to Final-5 (after merge)
  assert.ok(
    raw.includes("Phase Final-5: worker 作業コピーの cleanup"),
    "cleanup moved to Final-5 (last, after merge)",
  );
  // document ORDER must be audit(2) < merge(4) < cleanup(5), not just labels present
  const iAudit = raw.indexOf("#### Phase Final-2: cross-cutting audit");
  const iMerge = raw.indexOf("#### Phase Final-4: 依存順マージ");
  const iCleanup = raw.indexOf("#### Phase Final-5: worker 作業コピーの cleanup");
  assert.ok(
    iAudit > 0 && iMerge > iAudit && iCleanup > iMerge,
    "Final phases are ordered audit(2) → merge(4) → cleanup(5) in the document",
  );
  // audit attribution carries source_pr — anchored to the attribution output block
  // (co-located with category:), not a bare token match
  assert.ok(
    raw.includes("導入元 PR に attribution") && /source_pr:[\s\S]{0,80}category:/.test(raw),
    "audit output block attributes each gap to its source_pr alongside category",
  );
  // reconciliation single-pass convergence (specific phrase)
  assert.ok(raw.includes("1 パス固定"), "reconciliation is a single pass (convergence guarantee)");
  // fail-soft anchored to the reconciliation failure edge-case row, not any occurrence
  assert.ok(
    /reconciliation の lint\/畳み込みが失敗[\s\S]{0,40}fail-soft/.test(raw),
    "reconciliation fold failure is handled fail-soft (anchored to its edge-case row)",
  );
});

test("drive companion: worker prompt forbids self-merge and keeps stacked base", async () => {
  const companion = await loadCompanion("drive", "claude-code", []);
  assert.ok(companion, "drive companion must exist");
  const raw = companion.raw;
  // subagent prompt: no gh pr merge
  assert.ok(
    raw.includes("マージ禁止"),
    "companion instructs workers not to call gh pr merge (マージ禁止)",
  );
  // Final-2/3 run inside the still-present worker worktree, in parallel per PR
  assert.ok(
    raw.includes("Phase Final-2: cross-cutting audit") && raw.includes("worktree 内で並列"),
    "companion runs Final-2 audit inside worker worktrees, parallel per PR",
  );
  assert.ok(
    raw.includes("Phase Final-3: reconciliation") && raw.includes("parallel(gaps.groupBy(pr))"),
    "companion folds reconciliation per-PR in parallel",
  );
  // worktree-safety detail is extracted to a sibling reference (not inline)
  assert.ok(
    raw.includes("worktree-safety.claude-code.md"),
    "companion links to the extracted worktree-safety reference",
  );
  // Final-2 audit + Final-3 reconciliation run regardless of --merge (self-closing
  // guarantee for the --merge-unspecified path); only Final-4 branches on --merge
  assert.ok(
    raw.includes("`--merge` 有無を問わず") && raw.includes("Final-3"),
    "companion runs Final-1..Final-3 regardless of --merge (only Final-4 merge branches)",
  );
});

test("drive's real build discovery ships worktree-safety and excludes the companion", async () => {
  // Exercise the ACTUAL build discovery (scripts/build.mjs loadExtraFiles), not a
  // hand-built extraFiles array — this guards against a companion-exclusion regex
  // regression silently dropping the newly extracted worktree-safety.claude-code.md.
  const extras = await loadExtraFiles("drive");
  const rels = extras.map((e) => e.relativePath);
  assert.ok(
    rels.includes("worktree-safety.claude-code.md"),
    "build discovery includes the extracted worktree-safety sibling file",
  );
  assert.ok(
    !rels.includes("SKILL.claude-code.md"),
    "build discovery excludes the SKILL.claude-code.md companion (not an extra file)",
  );
  const wt = extras.find((e) => e.relativePath === "worktree-safety.claude-code.md");
  // the extracted detail (7-axis detection + recovery + cleanup) lives there now
  assert.ok(wt.content.includes("汚染検出 7 軸"), "extra file carries the 7-axis detection detail");
  assert.ok(
    wt.content.includes("recovery シーケンス") && wt.content.includes("cleanup 実行手順"),
    "extra file carries recovery + cleanup mechanics",
  );
});

test("claude-code adapter emits drive's discovered extra files verbatim", async () => {
  const drive = await loadSkill("drive");
  drive.extraFiles = await loadExtraFiles("drive");
  const out = await new ClaudeCodeAdapter().generate([drive]);
  const wt = out.find(
    (o) => o.relativePath === ".claude/skills/drive/worktree-safety.claude-code.md",
  );
  assert.ok(wt, "claude-code adapter emits the discovered worktree-safety extra file");
});

// --- #181 PR3: merge follows the central autonomy policy (irreversible gate) --
//
// drive is a prose judgment-layer skill, so the merge gate is expressed as an
// action classification that consults the central policy (the `policy` skill),
// not a hardcoded prose gate. These assert the neutral SKILL.md documents it.

test("neutral drive SKILL.md classes merge as irreversible and references the central policy", async () => {
  const raw = await readFile(join(SRC, "drive", "SKILL.md"), "utf8");
  assert.match(raw, /irreversible/, "merge must be classed as irreversible");
  assert.match(raw, /policy-read\.mjs/, "must point at the policy read substrate");
  assert.match(raw, /--action=merge/, "must name the policy action for gh pr merge");
  // zero-config default gate for merge is ask (documented in the resolve comment)
  assert.ok(
    raw.includes("既定 ask"),
    "zero-config gate for merge must be documented as ask (既定 ask)",
  );
});

test("neutral drive SKILL.md: --merge is the explicit opt-in overriding the gate to proceed", async () => {
  const raw = await readFile(join(SRC, "drive", "SKILL.md"), "utf8");
  // The dedicated policy subsection ties --merge to a proceed override.
  assert.match(
    raw,
    /マージと autonomy policy/,
    "must carry the dedicated merge ⇄ autonomy-policy subsection",
  );
  assert.ok(
    /`--merge`[\s\S]{0,120}(opt-in|明示 opt-in)[\s\S]{0,120}proceed|`--merge`[\s\S]{0,120}proceed[\s\S]{0,120}opt-in/.test(
      raw,
    ),
    "--merge must be documented as the explicit opt-in overriding the gate to proceed",
  );
  // both merge sites (single Phase 4 + orchestration Final-4) reference the gate
  const gateRefs = (raw.match(/`irreversible` gate に従う/g) ?? []).length;
  assert.ok(
    gateRefs >= 2,
    `both merge sites (Phase 4 + Phase Final-4) must reference the irreversible gate (found ${gateRefs})`,
  );
});

test("neutral drive SKILL.md documents policy-absence fail-safe for merge", async () => {
  const raw = await readFile(join(SRC, "drive", "SKILL.md"), "utf8");
  assert.match(
    raw,
    /policy 不在でも壊れない/,
    "must document policy-absence safety (fail-safe to ask)",
  );
  assert.match(raw, /fail-safe/, "must reference the fail-safe design");
});
