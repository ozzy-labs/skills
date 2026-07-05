// Structural tests for the lessons-triage skill.
//
// lessons-triage is a documentation-driven skill (not a runnable script):
// the canonical SKILL.md is read and executed by an agent. These tests
// assert on the document's *structure* — the contract the skill pins down —
// rather than on a runtime (same approach as phase-issue.test.mjs):
//   1. canonical / companion frontmatter are well-formed
//   2. the workflow section skeleton is present and ordered
//   3. the HITL contract is documented (per-item approval, no auto-apply)
//   4. the privacy contract is documented (no external delegation of
//      transcripts, no verbatim quotes in issue bodies)
//   5. the queue contract matches the dotfiles lesson-capture.sh producer
//      (file paths, field names, append-only semantics)
//   6. Claude-Code-only behaviors stay in the companion (AskUserQuestion is
//      *not* present in canonical SKILL.md, only in the companion)

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertRequiredFields, parseSkillDocument } from "../scripts/lib/frontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_DIR = join(ROOT, ".agents", "skills", "lessons-triage");
const CANONICAL = join(SKILL_DIR, "SKILL.md");
const COMPANION = join(SKILL_DIR, "SKILL.claude-code.md");

async function loadCanonical() {
  const raw = await readFile(CANONICAL, "utf8");
  const { frontmatter, body } = parseSkillDocument(raw, ".agents/skills/lessons-triage/SKILL.md");
  return { frontmatter, body, raw };
}

async function loadCompanion() {
  const raw = await readFile(COMPANION, "utf8");
  const { frontmatter, body } = parseSkillDocument(
    raw,
    ".agents/skills/lessons-triage/SKILL.claude-code.md",
  );
  return { frontmatter, body, raw };
}

test("lessons-triage canonical SKILL.md has required frontmatter", async () => {
  const { frontmatter } = await loadCanonical();
  assertRequiredFields(frontmatter, ["name", "description"], "lessons-triage SKILL.md");
  assert.equal(frontmatter.name, "lessons-triage", "name must match the directory name");
  assert.ok(
    frontmatter.description.length > 0,
    "description must be non-empty for adapter validation",
  );
});

test("lessons-triage companion SKILL.claude-code.md has required frontmatter", async () => {
  const { frontmatter } = await loadCompanion();
  // Overlay companions carry only Claude-only keys; `description` is injected
  // from the canonical SKILL.md at build time, so it must NOT be duplicated here.
  assert.ok(!frontmatter.description, "companion must not duplicate canonical description");
  assert.match(
    frontmatter["allowed-tools"] ?? "",
    /AskUserQuestion/,
    "companion must allow AskUserQuestion (HITL approval flow)",
  );
  assert.equal(
    frontmatter["disable-model-invocation"],
    "true",
    "skill must be user-invoked, not model-invoked",
  );
});

test("lessons-triage canonical SKILL.md keeps the workflow skeleton in order", async () => {
  const { body } = await loadCanonical();

  const expectedSections = [
    "Premises and principles",
    "Action classification and policy reference",
    "## Input",
    "Identify unprocessed sessions",
    "Prefilter",
    "Lesson extraction",
    "HITL approval and issue filing",
    "Recording as processed",
    "Completion report",
    "## Notes",
  ];

  let cursor = 0;
  for (const heading of expectedSections) {
    const idx = body.indexOf(heading, cursor);
    assert.notEqual(idx, -1, `section heading missing or out of order: "${heading}"`);
    cursor = idx + heading.length;
  }
});

test("lessons-triage canonical SKILL.md documents the HITL contract", async () => {
  const { body } = await loadCanonical();
  assert.match(body, /No auto-apply path/, "no-auto-apply contract must be documented");
  assert.match(
    body,
    /No external reflection other than filing issues/,
    "issue filing must be declared as the only external output",
  );
});

test("lessons-triage canonical SKILL.md references the central policy (not a hardcoded gate)", async () => {
  const { body } = await loadCanonical();
  // The HITL gate is now expressed as an action class + policy reference,
  // not as a per-item prose gate.
  assert.match(body, /externally-visible/, "issue filing must be classed as externally-visible");
  assert.match(body, /batch-confirm/, "zero-config gate for issue filing must be batch-confirm");
  assert.match(body, /policy-read\.mjs/, "must point at the policy read substrate");
  assert.match(
    body,
    /batch confirmation/,
    "batch confirmation of extracted lessons must be documented",
  );
  // Negative assertions: the old per-item-default prose must be gone (superseded
  // by the batch-confirm gate). "per-lesson approval" may still appear only as the
  // strict `ask` fallback, but the old default sentences must not.
  assert.doesNotMatch(
    body,
    /present the extracted lessons to the user one by one/i,
    "old per-item default approval prose must be removed",
  );
  assert.doesNotMatch(
    body,
    /issue filing happens only after obtaining per-lesson user approval/i,
    "old per-item auto-apply principle prose must be removed",
  );
});

test("lessons-triage canonical SKILL.md documents the privacy contract", async () => {
  const { body } = await loadCanonical();
  assert.match(
    body,
    /Never pass transcript content to an external CLI \/ external service/,
    "external delegation ban must be documented",
  );
  assert.match(
    body,
    /Delegation to things like gemini-delegate is prohibited/,
    "gemini-delegate must be named",
  );
  assert.match(
    body,
    /Do not include verbatim transcript quotes or sensitive information \(tokens, internal paths, private repo content, etc\.\) in the issue body/,
    "issue-body privacy rule must be documented",
  );
});

test("lessons-triage canonical SKILL.md documents the metrics-primed reflection channel", async () => {
  const { body } = await loadCanonical();
  // (a) The rollup is a documented input and prioritization starting point.
  assert.match(body, /metrics-primed/, "metrics-primed reflection channel must be documented");
  assert.match(body, /skill-metrics/, "must reference the skill-metrics rollup as input");
  assert.match(body, /--snapshot/, "must reference the /skill-metrics --snapshot rollup command");
  // The filed issue is a backlog pointer, not a fix carrier, and cites the rollup.
  assert.match(
    body,
    /backlog pointer/,
    "issue must be framed as a backlog pointer (priority index), not a fix carrier",
  );
  assert.match(
    body,
    /Quantitative baseline/,
    "issue-body template must include the rollup as quantitative evidence",
  );
  assert.match(
    body,
    /diagnosis and fixing happen locally, where the transcript is/,
    "diagnosis/fix must be deferred to the local transcript, not carried in the issue",
  );
});

test("lessons-triage canonical SKILL.md keeps rollup quotes free of verbatim logs (privacy extension)", async () => {
  const { body } = await loadCanonical();
  // Privacy assertion extended to the metrics-primed rollup: no verbatim
  // transcript / payload / secret / raw identifiers may leak through a quote.
  assert.match(
    body,
    /Rollup citations must also not include verbatim transcripts, payloads, secrets, or raw repo names\/cwd\/PR values/,
    "rollup-quote privacy rule must be documented",
  );
  assert.match(
    body,
    /citing the rollup, include \*\*metadata only \(counts, window\)\*\*/,
    "issue-body rule must restrict rollup quotes to metadata only",
  );
});

test("lessons-triage canonical SKILL.md documents the auto-ok label convention + backlog connection", async () => {
  const { body } = await loadCanonical();
  // (R5) The filed issue connects to `/backlog --auto` via a human-applied
  // auto-ok label — closing the reflect → consume half of the loop.
  assert.match(body, /auto-ok/, "auto-ok label convention must be documented");
  assert.match(body, /\/backlog --auto/, "must connect the filed issue to backlog --auto");
  assert.match(body, /consume/, "reflect → consume framing must be documented");

  // HATL: auto-ok is human-only and this skill must NOT apply it (no auto path).
  assert.match(
    body,
    /applied only by a human/,
    "auto-ok must be documented as human-only to apply",
  );
  assert.match(
    body,
    /does not attach `auto-ok` when filing/,
    "the skill must be documented as never applying auto-ok itself",
  );

  // The two human boundary conditions (HATL): filing approval + label.
  assert.match(body, /HATL/, "the HATL boundary must be named");
  assert.match(body, /Filing approval/, "boundary 1 (issue-filing approval) must be documented");
  assert.match(
    body,
    /Attaching the `auto-ok` label/,
    "boundary 2 (auto-ok label application) must be documented",
  );
});

test("lessons-triage canonical SKILL.md documents reflection as opt-in HITL", async () => {
  const { body } = await loadCanonical();
  // (c) Reflection (sending) stays an explicit opt-in HITL action; local
  // aggregation/prioritization may be automatic but issue-filing is not.
  assert.match(
    body,
    /Reflection \(sending\) is always explicit opt-in \/ HITL/,
    "reflection (sending) must be documented as always opt-in HITL",
  );
});

test("lessons-triage canonical SKILL.md matches the lesson-capture.sh queue contract", async () => {
  const { body } = await loadCanonical();

  // File paths shared with the dotfiles producer.
  assert.match(body, /~\/\.agents\/lessons\/queue\.jsonl/, "queue path must be documented");
  assert.match(body, /processed\.jsonl/, "processed ledger must be documented");

  // Queue record fields emitted by agents/hooks/lesson-capture.sh (dotfiles).
  for (const field of ["queued_at", "cli", "session_id", "cwd", "transcript_path", "reason"]) {
    assert.ok(body.includes(`\`${field}\``), `queue field must be documented: ${field}`);
  }

  // Append-only semantics protect against producer/consumer races.
  assert.match(
    body,
    /The queue itself is never rewritten/,
    "append-only queue contract must be documented",
  );
});

test("lessons-triage canonical SKILL.md documents every processed outcome", async () => {
  const { body } = await loadCanonical();
  for (const outcome of [
    "issues-created:<N>",
    "no-findings",
    "discarded",
    "transcript-missing",
    "no-skill-usage",
    "self",
  ]) {
    assert.ok(body.includes(outcome), `outcome must be documented: ${outcome}`);
  }
});

test("lessons-triage keeps Claude-Code-only behaviors in the companion", async () => {
  const { body: canonicalBody } = await loadCanonical();
  const { body: companionBody } = await loadCompanion();

  assert.ok(
    !canonicalBody.includes("AskUserQuestion"),
    "canonical must stay CLI-neutral (AskUserQuestion belongs to the companion)",
  );
  assert.match(
    companionBody,
    /AskUserQuestion/,
    "companion must define the AskUserQuestion approval flow",
  );
  assert.match(
    companionBody,
    /hasn't fired SessionEnd yet, it doesn't exist in the queue/,
    "companion must explain why the live session never appears in the queue",
  );
  // batch-confirm gate: the companion must use a single multiSelect round.
  assert.match(
    companionBody,
    /multiSelect/,
    "companion must use multiSelect for the batch-confirm approval round",
  );
});
