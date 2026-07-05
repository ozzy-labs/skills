---
name: review
description: Reviews code changes or PRs across 11 perspectives, reporting via JSON structured output plus a human-readable report. Supports switching between quick and deep modes. Takes a PR number or working-tree diff as input.
---

# review - Multi-perspective code review

Reviews the diff across 11 perspectives, classifies findings into Critical / Warning / Info, and reports them as JSON plus a human-readable report. It adopts the hybrid approach from [ADR-0025](https://github.com/ozzy-labs/handbook/blob/main/adr/0025-skills-review-multi-perspective.md) (quick: single agent / deep: parallel per-perspective subagents).

The deterministic logic (perspective selection, duplicate merging, separating cross-perspective conflicts, grouping, generating the human-readable report + embedding `<!-- review-json:v1 -->`) is handled by the bundled **`review.mjs` engine** ([ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R1, prior examples `health-check.mjs` / `usage-check.mjs` / `skill-metrics.mjs`). This SKILL.md is limited to the judgment layer — **deciding perspectives from changed files (`review.mjs select`), producing findings per perspective (LLM judgment), and formatting + posting JSON + report via `review.mjs render`**. The perspective definitions (`perspectives/<axis>.md`) and review-json Schema v1 are invariant.

## Principles

- **Only finding generation is LLM judgment:** the LLM that reads the code decides "which perspective has what issue." The engine handles only the deterministic parts: selection (which perspectives to run) and aggregation/formatting (how to compile and present the findings).
- **Internal representation is always JSON:** all findings are held as JSON; PR comments and stdout are converted to human-readable format via the engine's renderer.
- **The engine never overrides severity:** severity determination follows the severity guide in the corresponding `perspectives/<axis>.md`. Do not arbitrarily raise or lower severity across perspectives.

## Input

- **When a PR number is given** (`#N` or a bare number):
  - Fetch the diff with `gh pr diff <N>`, and the list of changed files with `gh pr diff <N> --name-only`
  - Fetch the PR description with `gh pr view <N>`
- **When no arguments are given:**
  - Fetch working-tree changes with `git diff` (list of changed files via `git diff --name-only`)
  - If there are no changes, fetch the branch diff with `git diff main...HEAD` (changed files via `git diff --name-only main...HEAD`)
  - If there are still no changes, report that there is nothing to review and exit

## Options

- `--axes=<axis,...>`: Explicitly specify which perspectives to apply (overrides automatic selection; perspectives with `default_enabled: false` are only enabled when specified explicitly)
- `--deep`: Run in deep mode (launches subagents in parallel per perspective. Claude Code environment only; other adapters fall back to quick)

## Perspectives (11 axes)

Perspective definitions use `perspectives/<axis>.md` as the SSOT. The frontmatter declares `category` / `applies_when` / `skip_when` / `default_enabled` / inspection items / severity guide / `exit_criteria.drive_loop`.

| category | axis | default |
| --- | --- | --- |
| required | correctness, security, conventions | Always applied |
| design | architecture, compatibility, maintainability | When applies_when matches |
| quality | testing, performance, observability | When applies_when matches |
| ux | usability, documentation | When applies_when matches |

The perspective selection logic (`category: required` is always applied / `default_enabled: false` is applied only when specified explicitly via `--axes` / `skip_when.diff_only_in` is the highest-priority skip condition / applied on an OR match of `applies_when`) is implemented in `review.mjs`, which deterministically returns the applicable perspectives given the frontmatter as input. The only key `skip_when` supports is `diff_only_in` (undefined keys are ignored, for forward-compat).

## Procedure

### 1. Determine applicable perspectives

Pass the list of changed files to `review.mjs select` and let it determine the applicable perspectives. The engine lives in **the same directory as this SKILL.md** (in Claude Code: `~/.claude/skills/review/review.mjs`; for dogfooding: `<repo>/.claude/skills/review/review.mjs`):

```bash
# 変更ファイル一覧（1 行 1 パス）を stdin で渡す
git diff --name-only | node <この skill のディレクトリ>/review.mjs select [--axes=<a,b>]
```

The engine formats and prints an `適用観点 (n/11):` block to stdout. **Present that output as-is** (do not reformat it). If you need a machine-readable perspective list, use `--json` (`{ axesApplied, byCategory, unknownAxes, total }`). Passing `--axes` overrides the selection and applies only those perspectives (including ones with `default_enabled: false`).

### 2. Generate findings (LLM judgment)

For each applicable perspective, review the diff according to the inspection items and severity guide in the corresponding `perspectives/<axis>.md`, and produce findings. **Only this step is LLM judgment**; it is not scripted.

Push each finding into the internal JSON in the following shape: `{ axis, severity ("critical"|"warning"|"info"), file, line, issue, why, suggestion }`. Fundamental trade-offs (e.g. security ↔ DX, observability ↔ performance) are not recorded as findings; push them into the `conflicts` array (`{ axes, file, line, description }`) instead (without a severity, leaving the decision to the reader).

#### quick mode (default)

A single agent scans the applicable perspectives in order, adding findings to the internal JSON buffer per perspective.

#### deep mode (`--deep`)

Launch an independent worker (a unit of parallel execution) for each perspective; each worker reads the corresponding `perspectives/<axis>.md` and returns findings as JSON. On hosts that cannot run in parallel, evaluating each perspective independently in series produces an equivalent result. Input format for the worker:

```text
axis: <axis-name>
mode: deep
context:
  base: <base-ref>
  head: <head-ref>
  pr_number: <N (optional)>

<diff>
```

The worker should be self-contained — reading the perspective MD and producing JSON output only (it does not call other skills). The mechanism for launching deep mode in parallel is host-dependent (Claude Code: see "Parallel launch in deep mode" in `SKILL.claude-code.md`). Adapters without a parallel execution mechanism fall back to quick. As described below, aggregation happens **in the engine after the worker returns** (do not add an aggregation agent inside the workflow).

### 3. Aggregation + report output

Assemble the generated findings (and conflicts) into JSON of the shape `{ mode, axes_applied, findings, conflicts }`, and pass it to `review.mjs render`. The engine performs duplicate merging (merging identical `file:line:issue` entries into one and noting `axes_merged`), summary calculation (by_axis / total), grouping by perspective → severity → file, human-readable report generation, and embedding `<!-- review-json:v1 -->`:

```bash
# findings JSON を stdin で渡す（--input=<file> でも可）
printf '%s' "$FINDINGS_JSON" | node <この skill のディレクトリ>/review.mjs render
```

Present and post the engine's stdout (the human-readable report plus the trailing JSON embed) **as-is**. For a PR review, comment on the PR with `gh pr comment <N> --body "<report>"`. Use `--json` to extract only the embedded Schema v1 JSON.

## review-json Schema v1 (contract, invariant)

The JSON the engine embeds has the following shape ([ADR-0025](https://github.com/ozzy-labs/handbook/blob/main/adr/0025-skills-review-multi-perspective.md) Schema v1; drive re-reads this to evaluate the per-perspective `exit_criteria.drive_loop`):

```json
{
  "version": "1",
  "mode": "quick",
  "axes_applied": ["security", "correctness", "..."],
  "findings": [
    {
      "axis": "security",
      "severity": "warning",
      "file": "src/x.ts",
      "line": 42,
      "issue": "...",
      "why": "...",
      "suggestion": "...",
      "axes_merged": ["security", "correctness"]
    }
  ],
  "conflicts": [
    { "axes": ["security", "usability"], "file": "src/y.ts", "line": 10, "description": "..." }
  ],
  "summary": {
    "by_axis": { "security": { "critical": 0, "warning": 1, "info": 0 } },
    "total": { "critical": 0, "warning": 1, "info": 3 }
  }
}
```

`axes_merged` and `conflicts` are optional fields (the engine adds them only when there is duplicate merging or a cross-perspective conflict).

### Version migration policy

- `version` is a monotonically increasing integer (as a string). This ADR establishes `"1"`
- The reader side (e.g. drive) performs machine judgment only when `version` matches the current code's supported upper bound
- An unsupported version fails soft as `unknown_review_version`, ignoring the JSON and handling only the human-readable part
- Breaking changes bump `version`, and readers keep an implementation that can read at least down to N-1. **When changing Schema v1, revise the engine (`review.mjs`), this SKILL.md, and drive's re-read logic together**

## Compatibility with past PR comments (resume)

Comments drive posted in the past may not have a JSON embed. The reader handles these as follows:

- A comment containing `<!-- review-json:v1 ... -->` → parse the JSON and do machine judgment
- A comment with no JSON → treated as a **legacy comment** and ignored as a trigger for a new review pass (past comments are not deleted)
- `<!-- review-json:v<unknown> ... -->` → ignored as `unknown_review_version` (fail-soft)

## Notes

- When reporting even a single `Critical`, show clear grounds for adverse impact (a bug, vulnerability, etc.)
- Severity determination for a perspective follows the severity guide in the corresponding `perspectives/<axis>.md`. Do not arbitrarily raise or lower severity across perspectives
- deep mode consumes tokens proportional to (number of perspectives × parallelism). In drive's orchestration mode, it forcibly falls back to quick (cost management)
- `Info` is suggestion-only. drive's review loop does not treat `Info` as something to fix
