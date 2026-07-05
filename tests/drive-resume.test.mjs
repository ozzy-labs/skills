// drive idempotent-resume hint in failure reports (issue #168).
//
// drive already resumes idempotently (existing PR / branch detection resumes
// from Phase 3; merged-PR detection lets orchestration continue with the
// remaining targets), but failure reports never surfaced HOW to resume —
// users had to read SKILL.md to discover it. #168 adds a mandatory
// `再開: /drive <元の引数>` line to the single-mode Phase 5 report and the
// orchestration Phase Final-6 aggregate report whenever a run ends with
// `failed` / `merge-ready` leftovers / `skipped`, and documents the
// argument-restoration convention (same rule as the usage-guard continuation
// command: carry `--no-usage-guard` only when user-specified, never force
// `--usage-guard`) in the input-parsing section.
//
// These are simple string-contains assertions over (a) the canonical
// SKILL.md (section-anchored so the line lives in the right report), and
// (b) the built claude-code output (companion emitted via ClaudeCodeAdapter).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter } from "../scripts/adapters/claude-code.mjs";
import { assertRequiredFields, parseSkillDocument } from "../scripts/lib/frontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, ".agents", "skills");

const RESUME_LINE = "再開: /drive <元の引数>";

async function loadCanonicalRaw() {
  return readFile(join(SRC, "drive", "SKILL.md"), "utf8");
}

/** Slice raw between two unique markers (endMarker exclusive) and assert both anchor. */
function section(raw, startMarker, endMarker) {
  const start = raw.indexOf(startMarker);
  assert.ok(start >= 0, `section start marker not found: ${startMarker}`);
  const end = raw.indexOf(endMarker, start);
  assert.ok(end > start, `section end marker not found after start: ${endMarker}`);
  return raw.slice(start, end);
}

// --- canonical SKILL.md: input parsing carries the restoration convention ---

test("canonical drive SKILL.md: input-parsing section documents the argument-restoration convention", async () => {
  const raw = await loadCanonicalRaw();
  const parsing = section(raw, "## Input parsing", "## Single mode");
  assert.ok(
    parsing.includes("### Argument restoration (resume command)"),
    "input parsing must carry a dedicated argument-restoration subsection",
  );
  // same rule as the usage-guard continuation command
  assert.ok(
    parsing.includes("identical to usage-guard's continuation-command convention"),
    "restoration convention must be declared identical to the usage-guard continuation-command rule",
  );
  // carry --no-usage-guard only when the user specified it
  assert.ok(
    parsing.includes("`--no-usage-guard` is carried over only if the user specified it"),
    "must carry --no-usage-guard only when user-specified",
  );
  // never force / persist the deprecated no-op alias
  assert.ok(
    parsing.includes(
      "`--usage-guard` is a deprecated no-op alias, so it is neither saved nor added",
    ),
    "must never save/force the deprecated --usage-guard alias",
  );
});

// --- canonical SKILL.md: Phase 5 single-mode report --------------------------

test("canonical drive SKILL.md: Phase 5 report template carries the resume line", async () => {
  const raw = await loadCanonicalRaw();
  const phase5 = section(raw, "### Phase 5: completion report", "## Orchestration mode");
  // template line (aligned) + prose rule both present
  assert.ok(
    phase5.includes("再開:     /drive <元の引数>"),
    "Phase 5 report template must include the resume line",
  );
  assert.ok(phase5.includes(RESUME_LINE), "Phase 5 prose must spell the exact resume command");
  // gated on failed / merge-ready — and mandatory there
  assert.ok(
    /is \*\*always\*\* output when the status is `failed` or `merge-ready`/.test(phase5),
    "resume line must be mandatory for failed / merge-ready outcomes",
  );
  // suppressed when the run completed (merged / auto-merge enabled)
  assert.ok(
    phase5.includes("not shown when the status completes as `merged` / `auto-merge enabled`"),
    "resume line must be suppressed when the single-mode run completed",
  );
});

// --- canonical SKILL.md: Phase Final-6 aggregate report -----------------------

test("canonical drive SKILL.md: Phase Final-6 aggregate report carries the resume line", async () => {
  const raw = await loadCanonicalRaw();
  const final6 = section(raw, "#### Phase Final-6: aggregate report", "## Failure semantics");
  // the example template shows the line after the 集計 block
  assert.ok(final6.includes(RESUME_LINE), "Final-6 template/prose must include the resume line");
  // gated on failed / merge-ready leftovers / skipped — and mandatory there
  assert.ok(
    final6.includes("whenever there's 1 or more `failed` / leftover `merge-ready` / `skipped`"),
    "resume line triggers on failed / merge-ready leftovers / skipped",
  );
  assert.ok(
    final6.includes("is **always** output"),
    "resume line must be mandatory in Final-6 when leftovers exist",
  );
  // suppressed when every target merged
  assert.ok(
    final6.includes("not shown when all targets complete as merged"),
    "resume line must be suppressed when all targets merged",
  );
  // idempotent-resume semantics: merged PRs are detected and skipped
  assert.ok(
    final6.includes("already-merged PRs") && final6.includes("continues"),
    "documents that idempotent resume skips already-merged targets and continues",
  );
});

// --- canonical SKILL.md: 失敗 semantics notes the resume path -----------------

test("canonical drive SKILL.md: failure-semantics section notes the shared resume path", async () => {
  const raw = await loadCanonicalRaw();
  const semantics = section(raw, "## Failure semantics", "## Notes");
  assert.ok(
    semantics.includes(RESUME_LINE),
    "failure semantics must point at the report resume line",
  );
  assert.ok(
    semantics.includes("Idempotent resume"),
    "failure semantics must name the idempotent resume mechanism",
  );
});

// --- built claude-code output (companion emitted via the adapter) ------------

test("built claude-code drive output emits the failure-report resume line wiring", async () => {
  const file = join(SRC, "drive", "SKILL.md");
  const raw = await readFile(file, "utf8");
  const label = ".agents/skills/drive/SKILL.md";
  const { frontmatter, body } = parseSkillDocument(raw, label);
  assertRequiredFields(frontmatter, ["name", "description"], label);
  const companionFile = join(SRC, "drive", "SKILL.claude-code.md");
  const companionRaw = await readFile(companionFile, "utf8");
  const companion = parseSkillDocument(companionRaw, ".agents/skills/drive/SKILL.claude-code.md");
  const drive = {
    name: frontmatter.name,
    description: frontmatter.description,
    frontmatter,
    body,
    raw,
    claudeCodeCompanion: companion,
  };
  const out = await new ClaudeCodeAdapter().generate([drive]);
  const driveOut = out.find((o) => o.relativePath === ".claude/skills/drive/SKILL.md");
  assert.ok(driveOut, "claude-code adapter emits .claude/skills/drive/SKILL.md");
  // the emitted overlay reuses the saved original-argument list for the resume line
  assert.ok(
    driveOut.content.includes(RESUME_LINE),
    "built output must carry the resume-line command",
  );
  assert.ok(
    driveOut.content.includes("Phase 5") && driveOut.content.includes("Final-6"),
    "built output must point the resume line at the Phase 5 / Final-6 reports",
  );
  // restoration convention preserved in the built output
  assert.ok(
    driveOut.content.includes(
      "carried over to the continuation command, only if the user specified it",
    ),
    "built output must keep the --no-usage-guard carry-only-when-user-specified rule",
  );
  assert.ok(
    !driveOut.content.includes("/drive --usage-guard"),
    "built output must not force --usage-guard in any restored command",
  );
});
