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
    "前提と原則",
    "アクション分類と policy 参照",
    "入力",
    "未処理セッションの特定",
    "プレフィルタ",
    "教訓抽出",
    "HITL 承認と issue 起票",
    "処理済み記録",
    "完了報告",
    "注意事項",
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
  assert.match(body, /auto-apply 経路なし/, "no-auto-apply contract must be documented");
  assert.match(
    body,
    /issue 起票以外の外部反映を行わない/,
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
  assert.match(body, /一括確認/, "batch confirmation of extracted lessons must be documented");
  // Negative assertions: the old per-item-default prose must be gone (superseded
  // by the batch-confirm gate). The word "1 件ずつ" may still appear only as the
  // strict `ask` fallback, but the old default sentences must not.
  assert.doesNotMatch(
    body,
    /抽出した教訓を 1 件ずつユーザーに提示し/,
    "old per-item default approval prose must be removed",
  );
  assert.doesNotMatch(
    body,
    /issue 起票は 1 件ずつユーザー承認を得てから行う/,
    "old per-item auto-apply principle prose must be removed",
  );
});

test("lessons-triage canonical SKILL.md documents the privacy contract", async () => {
  const { body } = await loadCanonical();
  assert.match(
    body,
    /transcript の内容を外部 CLI \/ 外部サービスへ渡さない/,
    "external delegation ban must be documented",
  );
  assert.match(body, /gemini-delegate 等への委譲は禁止/, "gemini-delegate must be named");
  assert.match(
    body,
    /逐語引用・機密情報（トークン、内部パス、private リポの内容等）を含めない/,
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
    /backlog ポインタ/,
    "issue must be framed as a backlog pointer (priority index), not a fix carrier",
  );
  assert.match(
    body,
    /定量ベースライン/,
    "issue-body template must include the rollup as quantitative evidence",
  );
  assert.match(
    body,
    /診断・修正は transcript のあるローカルで行い/,
    "diagnosis/fix must be deferred to the local transcript, not carried in the issue",
  );
});

test("lessons-triage canonical SKILL.md keeps rollup quotes free of verbatim logs (privacy extension)", async () => {
  const { body } = await loadCanonical();
  // Privacy assertion extended to the metrics-primed rollup: no verbatim
  // transcript / payload / secret / raw identifiers may leak through a quote.
  assert.match(
    body,
    /rollup 引用にも逐語トランスクリプト・payload・secret・raw repo 名\/cwd\/PR 生値を含めない/,
    "rollup-quote privacy rule must be documented",
  );
  assert.match(
    body,
    /rollup を引用する場合も \*\*metadata（件数・window）のみ\*\*/,
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
  assert.match(body, /人間のみが付与/, "auto-ok must be documented as human-only to apply");
  assert.match(
    body,
    /起票時に .*を付けない/,
    "the skill must be documented as never applying auto-ok itself",
  );

  // The two human boundary conditions (HATL): filing approval + label.
  assert.match(body, /HATL/, "the HATL boundary must be named");
  assert.match(body, /起票承認/, "boundary 1 (issue-filing approval) must be documented");
  assert.match(body, /ラベル付与/, "boundary 2 (auto-ok label application) must be documented");
});

test("lessons-triage canonical SKILL.md documents reflection as opt-in HITL", async () => {
  const { body } = await loadCanonical();
  // (c) Reflection (sending) stays an explicit opt-in HITL action; local
  // aggregation/prioritization may be automatic but issue-filing is not.
  assert.match(
    body,
    /反映（送信）は常に明示 opt-in・HITL/,
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
  assert.match(body, /queue 自体は書き換えない/, "append-only queue contract must be documented");
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
    /SessionEnd 未発火のため queue に存在しない/,
    "companion must explain why the live session never appears in the queue",
  );
  // batch-confirm gate: the companion must use a single multiSelect round.
  assert.match(
    companionBody,
    /multiSelect/,
    "companion must use multiSelect for the batch-confirm approval round",
  );
});
