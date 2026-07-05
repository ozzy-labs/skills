---
name: drive
description: Automatically cycles through implementation, PR creation, self-review, and fixes from an Issue or an instruction to produce a merge-ready PR. Supports single/multiple Issues/PRs and explicit dependency notation. Can optionally run through to merge. In orchestration, detects and self-resolves cross-cutting concerns before merge, leaving no follow-up within a single run.
---

# drive - Autonomously driving from an Issue to a merge-ready PR

Takes an Issue or an instruction and automatically repeats implement → ship → self-review → fix to produce a merge-ready PR. Supports parallel driving of multiple Issues/PRs, and can optionally complete all the way through to merge.

Determinism (argument parsing, target expansion, DAG/wave construction, cycle detection, concurrency/review-mode resolution, aggregating worker return values, and report formatting) is handled by the two bundled engines ([ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R1, following the precedent of `health-check.mjs` / `topics.mjs` / `review.mjs`):

- **`drive-plan.mjs`**: Input (argument string + optional target meta) → wave configuration JSON. Handles target expansion, `->` dependency parsing, DAG construction, topological wave splitting, circular dependency detection, mode branching, and concurrency/review mode resolution.
- **`drive-report.mjs`**: Aggregates worker return-value JSON → formats the single-mode Phase 5 completion report / the orchestration Phase Final-6 aggregate report. Handles review aggregation (by_axis / total), cross-cutting gaps display, and the output decision for the `再開: /drive <元の引数>` line.

This SKILL.md is confined to the judgment layer — when to call the engine, the meaning of each Phase, the per-axis exit determination for the review loop, the folding decision for cross-cutting concerns, and where to confirm with a human. This file is the SSOT for the behavioral contract (the semantics of Phase 1-5 / Phase Final-1–6, failure semantics, and the meaning of `--merge` / `--review` / `--concurrency`).

## Input parsing

Argument parsing is handled by `drive-plan.mjs` (in the same directory as this SKILL.md; on Claude Code it's `~/.claude/skills/drive/drive-plan.mjs`, and for dogfooding it's `<repo>/.claude/skills/drive/drive-plan.mjs`):

```bash
node <この skill のディレクトリ>/drive-plan.mjs "<元の引数>" [--meta-file <path>] [--json]
```

Content resolved by the engine (behavioral contract):

- **Target expansion:** single `#42` / `42`, comma-separated `#1,#2`, range `#3-5` → `#3,#4,#5`, whitespace-separated `#1 #2`, mixed `#1,#3-5`. An argument matching none of these is treated as a text instruction (single target).
- **Explicit dependency notation `->`:** `#1,#2 -> #3` (#1 and #2 run in parallel → #3 runs after both complete), `#1 -> #2 -> #3` (fully sequential).
- **DAG construction:** explicit dependencies (highest priority) + PR base↔head matching (stacked) + best-effort detection of "depends on #X" in the issue body (when issue/PR meta is passed via `--meta-file`).
- **Wave splitting / cycle detection:** splits into topological levels. If a circular dependency exists, returns `error` + `cycle` (→ report and abort).
- **Mode branching:** 1 target with no dependencies → single mode; 2 or more targets, or dependencies present → orchestration mode.
- **Concurrency / review mode:** default `min(4, task count)`, overridable via `--concurrency` (>8 only warns). Orchestration forces `--review=quick` (`final-deep`/`deep` are downgraded with a warning).

The `resume_command` in the engine output (`--json`) is already assembled according to the "Argument restoration (resume command)" convention.

### Options

- `--merge`: Attempts an automatic merge. The merge follows the central autonomy policy's `irreversible` gate (see "Merge and the autonomy policy" below). **The `--merge` flag itself is an explicit opt-in** — it treats the user as having already delegated autonomous merging, overriding the gate to `proceed` (merge without confirmation)
- `--concurrency N`: Overrides the concurrency level (default `min(4, task count)`, N > 8 only warns)
- `--review=<mode>`: review mode (default `quick`). The value is one of the following:
  - `quick` (default): quick mode for every review pass (up to 3 iterations)
  - `final-deep`: loops in quick mode up to 2 times, then upgrades only the final pass to deep (quick 2 + deep 1)
  - `deep`: deep mode for every pass (up to 1 iteration; prevents cost blowup)

  In orchestration mode, `--review=quick` is forced; if `final-deep` / `deep` is specified, a warning is shown and it falls back to `quick`.

- usage-guard: pauses work just before the Claude Code Usage Limit is exceeded, and automatically resumes once the budget recovers. **Enabled by default (opt-out)**. Add `--no-usage-guard` to disable it. Takes effect **only in the Claude Code environment** (same treatment as `review --deep`; it depends on the OAuth usage-rate endpoint + `ScheduleWakeup`, so it's a no-op on other adapters). It's ON by default, but only takes effect on the claude-code adapter — other adapters (codex/gemini/copilot) do nothing, as before. Since the pause/resume wiring is host-dependent, it is absorbed into "usage-guard wiring (default ON, disabled via `--no-usage-guard`)" in `SKILL.claude-code.md`.
  - `--no-usage-guard`: disables usage-guard and runs a plain drive with no checkpoints inserted at all.
  - `--usage-guard`: a **deprecated no-op alias** kept for backward compatibility (no longer needs to be explicit since it's now enabled by default). Accepted, but behaves identically to the default ON state.
  - Pauses occur only at the **entry to a resumable unit** (single mode: before Phase 1 begins / before each review-loop iteration; orchestration: before each wave begins / before worker dispatch). It does not pause mid-implement (before PR creation).
  - The pause granularity for orchestration is the **wave boundary**. A mid-unit overage in an already-running worker cannot be stopped by this flag; the PreToolUse hook (#123) serves as the ceiling.
  - On overage, it waits until the budget resets, then re-enters via the continuation command `/drive <元の引数>` (continuing via drive's idempotent resume). `--no-usage-guard` is carried over to the continuation command only if the user specified it explicitly (`--usage-guard` is never force-added).
  - Even in environments where the usage-guard skill / `usage-check.mjs` is not installed, drive is not stopped with an error. If the skill's absence is detected, a one-line warning is shown and it proceeds normally (treated as fail-open).

### Merge and the autonomy policy (irreversible gate)

Merging (single-mode Phase 4 / orchestration Phase Final-4) is an **irreversible, destructive action**. Rather than hardcoding an individual approval gate in prose, it follows the central autonomy policy (the SSOT for the 3 action classes and gate vocabulary, defined by the `policy` skill. [ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R3, [#181](https://github.com/ozzy-labs/skills/issues/181)). Classification and zero-config default:

| Action in this skill | Class | policy reference | zero-config default gate |
|---|---|---|---|
| PR merge (`gh pr merge`) | `irreversible` | `--action=merge` | `ask` (explicit approval before merging) |

The effective gate is looked up via `policy-read.mjs` in the sibling `policy` skill (in Claude Code's user-scope it's `~/.claude/skills/policy/policy-read.mjs`, for dogfooding it's `<repo>/.claude/skills/policy/policy-read.mjs`, and on Codex/Gemini it's `.agents/skills/policy/policy-read.mjs`):

```bash
node <policy skill のディレクトリ>/policy-read.mjs --action=merge --repo-root="$PWD"
# => .resolved.gate（既定 ask）
```

- **Default is `ask`:** when `--merge` is not specified, the merge follows gate=`ask` and executes only after **confirming with a human** (single mode: Phase 4; orchestration: the "After completion" confirmation in Phase Final-4).
- **`--merge` is an explicit opt-in that overrides to `proceed`:** the moment the user adds `--merge`, it is treated as having delegated autonomous merging, overriding the gate to `proceed` (merge without confirmation + audit trail). This is an extension of the same "drive has been delegated autonomous execution" principle as implement's `reversible-local`=`proceed` (plan approval is skipped under drive).
- **Doesn't break even without a policy present (fail-safe):** `policy-read.mjs` is fail-safe by design — unreadable or invalid values always fall to the stricter side (`ask`). In environments where the `policy` skill isn't installed, the default gate (`irreversible`=`ask`) is applied directly. The explicit opt-in of `--merge` remains effective in this case too.
- **Architectural enforcement (Claude Code) and how `--merge` gets through:** in environments where the execution-engine-side gate for `gh pr merge` (the PreToolUse `policy-hook.mjs`, wired via `npx @ozzylabs/skills hooks add policy`) is in place, a merge with gate=`ask` (the default) is denied (exit 2) by the hook. **Since `--merge` is an explicit opt-in that overrides the merge to `proceed` at the prose layer, when actually running `gh pr merge`, export `POLICY_GUARD_PROCEED=merge` before running it** (the hook allows this pre-authorized action without re-gating it; resolves the [#195](https://github.com/ozzy-labs/skills/issues/195) gap). This ensures that even in environments with the hook wired up, drive's own legitimate merges aren't blocked by the enforcement net. In environments without the hook wired, this is just a harmless env prefix. Likewise, when a human approves the merge during the "After completion" confirmation when `--merge` is not specified, that one command is also run with `POLICY_GUARD_PROCEED=merge` prefixed (since the explicit approval via AskUserQuestion satisfies the `ask` gate's requirement).

### Argument restoration (resume command)

**The original argument list is saved** at parse time. The resume line in the failure-time report (single-mode Phase 5 / orchestration Phase Final-6) and usage-guard's continuation command both assemble `/drive <元の引数>` from these saved arguments. The restoration convention is identical to usage-guard's continuation-command convention:

- Restates the original arguments as-is. drive's idempotent resume (detecting an existing PR / branch / already-merged PR) resumes from where it left off
- `--no-usage-guard` is carried over only if the user specified it
- `--usage-guard` is a deprecated no-op alias, so it is neither saved nor added (nor force-added)

### Mode branching

Follows the `mode` output from `drive-plan.mjs`:

- 1 target with no dependency notation → **single mode**
- 2 or more targets, or dependency notation present → **orchestration mode**

## Single mode

### Phase 1: implement

Runs the implement skill's workflow. However, the following points differ:

- **Skip plan approval:** since the user has already delegated autonomous execution by running drive, the plan is self-approved and implementation proceeds
- **Ignore the completion report and next-action confirmation:** transitions between phases are controlled by this skill

**Abort condition:** if behavior verification repeatedly fails → report the error and abort

### Phase 2: ship

Runs the ship skill's workflow (verify → commit → create PR). Ignores the completion report and next-action confirmation.

- Records the PR number (used in Phase 3)
- **Idempotency:** if an existing PR is detected, it's treated as a resume — instead of creating a new one, it resumes from Phase 3. Criteria:
  - target is a PR number → adopt that PR
  - target is an issue number → adopt the latest single result from `gh pr list --search "in:body #<N>" --state open`, or the PR matching the current branch name

**Abort condition:** if verify (validation) fails and can't be fixed → report the error and abort

### Phase 3: review loop (determined by per-axis exit criteria)

Aggregates the review skill's per-axis `exit_criteria.drive_loop` to determine when to exit. The loop cap switches based on the `--review` mode:

| `--review` | max quick iterations | max deep iterations | notes |
| --- | --- | --- | --- |
| `quick` (default) | 3 | 0 | quick for every review pass |
| `final-deep` | 2 | 1 (final pass only) | loops in quick, then only the final pass is deep |
| `deep` | 0 | 1 | deep for every pass. Capped at 1 to prevent cost blowup |

Steps for each pass:

1. **Run the review:** review the PR with the review skill and post the result as a PR comment. At this point, embed JSON in the HTML comment `<!-- review-json:v<N> ... -->` at the end of the PR comment ([ADR-0025](https://github.com/ozzy-labs/handbook/blob/main/adr/0025-skills-review-multi-perspective.md) Schema v1)
2. **Determination:**
   - If the JSON can be parsed → determine whether **all** per-axis `exit_criteria.drive_loop` are satisfied. `exit_criteria` refers to the `exit_criteria.drive_loop` of the corresponding `perspectives/<axis>.md` (the acceptable critical/warning thresholds differ per axis)
   - If all applicable axes satisfy `exit_criteria` → end the loop (merge-ready)
   - If even one axis is unmet → proceed to fixing
   - If JSON parsing fails / `unknown_review_version` → fail-soft, handling only the human-readable portion, determined by whether Critical or Warning counts are 0 (legacy-behavior compatible)
   - If the loop cap is reached → end the loop (include remaining findings in the report)
3. **Fix:** fix only the Critical and Warning findings for unmet axes. Info is not fixed (reported only). After fixing, run verify → commit → push, and return to step 1

For `--review=final-deep`, only the last pass (either right before the quick cap is reached, or the final single iteration) is re-reviewed in deep mode.

If `unknown_review_version` is detected, the JSON is ignored and the determination uses only the human-readable portion, with the loop continuing as-is (maintaining compatibility after a schema bump).

#### Resume compatibility with existing PR comments

- If a past PR comment doesn't include `<!-- review-json:v<N> -->`, that PR is treated as a **legacy comment**, and a new review pass is run (the old comment isn't deleted)
- The same applies for `<!-- review-json:v<unknown> -->` — a new pass is run

### Phase 4: merge (optional)

**When single mode is executed as an orchestration worker, Phase 4 is not run.** The worker stops at `merge-ready` (review passed, not yet merged) and returns `status` capped at `merge-ready`. Merging is centrally managed by the parent in Phase Final-4 (to secure a window for folding in cross-cutting concerns before merge — if a worker were to self-merge, it would already be merged and unfoldable, leaving follow-up behind).

The merge follows the central policy's `irreversible` gate (see "Merge and the autonomy policy"; default `ask`). The following runs only when **single mode is executed directly (not as a worker) and `--merge` is specified** (`--merge` is an explicit opt-in that overrides the gate to `proceed`):

1. **Enable auto-merge:** run `POLICY_GUARD_PROCEED=merge gh pr merge --auto --squash --delete-branch` (`POLICY_GUARD_PROCEED=merge` conveys `--merge`'s proceed override to the PreToolUse `policy-hook.mjs`; see "Merge and the autonomy policy")
2. **Check success/failure:**
   - Success (auto-merge was set, or it was merged immediately) → proceed
   - Failure (e.g., auto-merge disabled on the repository) → notify the user and prompt for a manual merge (set the state to `merge-ready`)
3. **Cleanup (if merged immediately):**
   - Confirm the local branch has been deleted and it's switched to the base branch (e.g., main)
   - Run `git pull` on the base branch to sync to the latest state

### Phase 5: completion report

Formatting the completion report is handled by `drive-report.mjs single`. Passing the worker/single-mode return-value JSON (`target` / `title` / `branch` / `pr_url` / `status` / `review` / `original_args`) via stdin or `--input` returns the following formatting (including by_axis aggregation and the output decision for the resume line):

```bash
echo '<result-json>' | node <この skill のディレクトリ>/drive-report.mjs single
```

```text
drive 完了:
  Issue:    #<number> <title>
  ブランチ: <branch-name>
  PR:       <PR URL>
  レビュー: N 回実施 (mode: <quick|final-deep|deep>)
            総計 Critical: 0, Warning: 0, Info: N
            by_axis: correctness:C0W0I0 security:C0W0I0 ...
  状態:     <merged | merge-ready | auto-merge enabled | failed>
  再開:     /drive <元の引数>
```

The `再開:` line is **always** output when the status is `failed` or `merge-ready` (for discoverability — so it's known that resume works without having to read the SKILL.md). The arguments are restored following the "Argument restoration (resume command)" convention, and shown as a single `再開: /drive <元の引数>` line. Re-running triggers idempotent resume, which detects the existing PR / branch and resumes from Phase 3. It's not shown when the status completes as `merged` / `auto-merge enabled`. This output decision and argument restoration are implemented by `drive-report.mjs`.

## Orchestration mode

### Phase 0: input expansion and DAG construction

Target expansion, DAG construction, wave splitting, and cycle detection are handled by `drive-plan.mjs` (the judgment layer only fetches meta from GitHub and calls the engine):

1. For each target, fetch meta from GitHub (used for the DAG's PR-base matching / issue-body detection):
   - issue: `gh issue view <N> --json number,title,body`
   - PR: `gh pr view <N> --json number,title,body,baseRefName,headRefName`
   - If it's ambiguous whether it's an issue or a PR, try both and adopt whichever hits
   - Assemble the fetched meta into JSON of the form `{"#N": {kind,title,body,baseRefName,headRefName}, ...}` and write it to a temp file
2. Run `drive-plan.mjs "<元の引数>" --meta-file <path> --json`. Adopt the `waves` / `deps` / `mode` / `concurrency` / `review` / `cycle` returned by the engine:
   - **DAG:** explicit dependency `->` (highest priority) + PR base↔head matching (stacked) + best-effort detection of "depends on #X" / "blocked by #X" / "after #X" in the issue body (misses fall back to parallel treatment rather than being an error)
   - **Circular dependency:** if the engine returns `error: "circular dependency detected"` + `cycle`, report the error and abort
3. Present the output of `drive-plan.mjs` (without `--json`) as-is. Formatting is handled by the engine (do not reformat it):

```text
drive 開始:
  Targets:  #1, #2, #3, #4, #5
  並列度:    4 (既定: min(4, タスク数))
  --merge:  有効
  Waves:
    Wave 1: #1, #2 (並列)
    Wave 2: #3 (← #1, #2)
    Wave 3: #4, #5 (並列, ← #3)
```

### Phase 1..N: wave parallel execution

Runs the waves in order.

#### Concurrency

- Default: `min(4, tasks in wave)`
- Overridable with `--concurrency N`
- If N > 8, show a warning and continue (no hard cap)

#### worker dispatch

For each target, launch a worker (a unit of parallel execution). Launches proceed up to the concurrency level at a time, dispatching the next as slots free up. The worker launch mechanism, and the prohibitions/tool constraints for protecting the parent repository's git state, **depend on the parallel-execution mechanism**, so follow the host-specific procedure (Claude Code: "subagent dispatch" in `SKILL.claude-code.md`).

- **Isolation:** workers must always be launched in an isolated working copy (mandatory — prevents working-directory collisions during parallel execution). A worker stays self-contained within its own working copy and branch, and never writes to the parent's base branch, refs, or working copy
- **Delegation granularity:** have the worker read this SKILL.md and run the single-mode workflow (Phase 1-3) for target #N. **The worker does not run Phase 4 (merge)** — it stops at `merge-ready`, and merging is centrally managed by the parent in Phase Final-4 (to secure a window for folding in cross-cutting concerns before merge)
- **Merge prohibition:** the worker never calls `gh pr merge` at all (neither `--auto` nor `--delete-branch`). If it were to self-merge, it would already be merged and the gap couldn't be folded in, leaving follow-up behind. Cleanup of local branches / working copies is also handled in bulk by the parent in Phase Final-5
- **Minimal cross-scope-impact check:** if a schema enum / field / CLI flag was added within its own issue's scope, grep the whole repo for the corresponding help strings / error messages / samples/docs and check whether they're in sync (e.g., `rg -n '<old-enum-list>' src/ docs/`). If not in sync, **include the fix in its own PR if feasible** (as a natural extension of its own scope). If it's a judgment call or clearly beyond its own scope, don't fix it — instead record it in the return value's `cross_cutting_gaps` in the form `<file>:<line> — <symbol> not synced`, to be aggregated into the parent's Phase Final-2 audit ([Issue #70](https://github.com/ozzy-labs/skills/issues/70))
- **Base branch:**
  - target with no upstream wave dependency → branch from main
  - target with an upstream wave dependency → branch based on the upstream PR's `headRefName` (stacked PR). Since the worker doesn't self-merge, the upstream remains unmerged during the run. So regardless of `--merge`, **stacked structure is the default** (the parent reassigns the base to main when merging in dependency order in Phase Final-4)
- **Return value:** each worker returns the following JSON on completion

```json
{
  "target": "#<N>",
  "title": "<issue/PR title>",
  "branch": "<branch-name>",
  "pr_url": "<URL>",
  "pr_number": <N>,
  "status": "merge-ready" | "failed",
  "review": {
    "mode": "quick" | "final-deep" | "deep",
    "axes_applied": ["security", "..."],
    "by_axis": {"security": {"critical": 0, "warning": 0, "info": 0}, ...},
    "total": {"critical": 0, "warning": 0, "info": 0},
    "iterations": <N>
  },
  "cross_cutting_gaps": [
    "src/cli/foo.ts:213 — help text missing new kind 'html-js'",
    "src/cli/foo.ts:299 — validation error message lists old enum set"
  ],
  "final_head_state": {
    "symbolic_ref": "<git symbolic-ref HEAD 出力、例: refs/heads/feat/foo>",
    "rev_parse_HEAD": "<git rev-parse HEAD 出力>",
    "status_short": "<git status --short 出力、clean なら空文字列>"
  },
  "error": "<message if failed>"
}
```

`status` is capped at `merge-ready` for workers (review passed, unmerged). `merged` is only confirmed by the parent in Phase Final-4 (immediate squash merge), and `auto-merge enabled` only appears in Phase 4 (`--auto`) when single mode is run directly. Neither appears in a worker's return value (the parent accepts them anyway, for backward compatibility).

`cross_cutting_gaps` is an optional field recording items the worker noticed during its "minimal cross-scope-impact check" but did not fix in its own PR (an empty array is fine). A return value missing this field is treated as `[]`, not an error, for backward compatibility. The parent aggregates these as a starting point in Phase Final-2's **pre-merge** audit, combining them with its own independently detected gaps, and folds them into the originating PR in Phase Final-3 reconciliation.

`final_head_state` is a field that always reports the git HEAD state of the worker's own working copy at completion. Since discrepancies between self-reported state and actual state have been observed, the actual measured values are submitted in the return value for cross-checking on the parent side in Phase Final-1. If the field is missing, it's treated as `null` for backward compatibility and the cross-check is skipped (see the host-specific procedure for the discrepancy criteria).

#### Observability and interrupt/resume

The **execution mechanism** for progress observation and interrupt/resume **is host-dependent** (since it's integrated into the parallel-execution mechanism). The canonical only defines the semantics; the how of the mechanism (progress display, concrete resume steps) is delegated to host-specific procedures (Claude Code: "Observability and interrupt/resume" in `SKILL.claude-code.md`):

- A worker may not be able to give streaming intermediate reports while running. The parent visualizes progress, but **finalizes state via the final JSON return value once all workers complete** (the return value is the SSOT for finalization; intermediate display is merely auxiliary)
- Even if interrupted, drive can resume from where it left off via idempotent resume (detecting completed workers / existing PRs / already-merged PRs). **The how of the resume mechanism is host-dependent** (on Claude Code it's the Workflow's journal resume `resumeFromRunId`; the Agent tool fallback is `gh pr list` polling + manual re-run)

#### Waiting for wave completion

- The wave is complete once all workers have completed
- Since workers don't self-merge, regardless of `--merge`, wave completion = the point at which every PR in the wave has reached `merge-ready` or better (unmerged). The following wave creates its PRs stacked on the base of the preceding PR's `headRefName`
- The actual merge is performed centrally by the parent in dependency order in Phase Final-4, after all waves complete

#### Handling failed / merge-ready tasks

Since workers don't merge during the run, from a downstream perspective, an upstream is only ever one of two values: `merge-ready` (success) or `failed`:

| Upstream state | downstream treatment |
|---|---|
| merge-ready | proceed (create a stacked PR based on the preceding PR's headRefName) |
| failed | excluded as `skipped (upstream failed: #N)` |

- Failed targets are recorded
- Other independent tasks (with no dependency relationship) are not affected

### Phase Final: cross-cutting self-resolution, merge, and aggregate report

Phase Final consists of the following 6 steps, run in order. **The core of the design**: placing cleanup (Final-5) last, and running audit (Final-2) and reconciliation (Final-3) **before the merge**, folds cross-cutting gaps into the originating PR while the worker's working copy still remains. This ensures no follow-up is left behind after a single run.

#### Phase Final-1: parent working-copy consistency check

A fail-safe that verifies workers haven't polluted the parent repository's git state (`HEAD` / `index` / base-branch ref). The specific verification axes and recovery sequence depend on the parallel-execution mechanism, so follow the host-specific procedure (Claude Code: "Phase Final-1: parent worktree consistency check" in `SKILL.claude-code.md`).

At minimum, verify the following invariants regardless of host:

1. The parent's HEAD points to the base branch (usually `main`) and is not detached
2. The parent's index / working tree is clean
3. The base-branch ref matches `origin/<base-branch>`
4. There's no discrepancy between the worker return value's `final_head_state` and the actually measured git state

If any of these don't match, output a warning and host-specific recovery steps at the end of the aggregate report.

#### Phase Final-2: cross-cutting audit (pre-merge, parallel within worker working copies)

Since multiple workers run in parallel, each confined to its own sub-issue scope, **cross-cutting impact spanning scopes can structurally leak through** (an enum/field/CLI flag not reflected in help/error messages/samples, leftover status wording, lockfile drift, etc.). This is detected **before merging** and folded into the originating PR in Phase Final-3 (originating from [Issue #70](https://github.com/ozzy-labs/skills/issues/70) / [#166](https://github.com/ozzy-labs/skills/issues/166)).

**Why this can be detected before merge, within the worktree**: the essence of a cross-cutting gap is "PR-A adds enum X → help/docs (an existing file nobody touched) doesn't reflect X." This existing file can be grepped in **PR-A's own working copy (which includes X)**, so "no X = gap" can be detected there, determinable before merging into main (equivalent to a post-merge grep of main).

**Parallel**: since each PR's inspection is independent, **run it in parallel per PR (by default)**. Each inspection is performed within that worker's working copy (workers aren't cleaned up until Phase Final-5, so they remain).

##### 0. Aggregate reports from workers

As a starting point for inspection, aggregate the `cross_cutting_gaps` field from every worker's return value. This includes gaps the worker itself noticed but did not fix in its own PR.

##### 1. Sync check for cross-cutting symbols (heuristic)

For each worker's `pr_number`, fetch the diff with `gh pr diff <N>` (even for stacked PRs, `base...head` = that PR's own diff only, no double-counting), and heuristically extract newly added enum values, field names, and CLI-flag-looking symbols:

```bash
gh pr diff <N> | grep -E '^\+' | grep -oE '(case\s+["'\'']\w[\w-]+["'\''])|(--[a-z][a-z0-9-]+)|(["'\''][a-z][a-z0-9-]+["'\''])' | sort -u
```

Grep the extracted symbols across the whole repo within that worker's working copy, and check whether they're reflected in help strings / error messages / samples / docs (false positives are acceptable; the AI judges).

##### 2. Detecting remnants of stale wording

If a status keyword (`alpha`, `beta`, `Phase \d+`, `pending`, etc.) has been removed in a PR, grep within the working copy for whether the same string remains as a remnant in other files. Legitimate uses as proper nouns are excluded by the AI's judgment.

##### 3. lockfile drift

Detect, from each PR's diff, cases where a lockfile (`pnpm-lock.yaml` / `package-lock.json` / `uv.lock`, etc.) was changed in the PR but the corresponding manifest (`package.json` / `pyproject.toml`, etc.) was not — or vice versa.

##### 4. docs ⇄ code grep consistency (reduced-scope version)

Extract newly added CLI invocation strings from the diff of docs-related PRs (with a `docs:` title, etc.), and grep within the working copy for whether the corresponding string exists on the code side. No "execution-based" verification is performed.

##### Audit output (attribution)

Output each detected gap **attributed to its originating PR** in the following form. Phase Final-3 uses this `source_pr` to decide where to fold it:

```text
gap:        <target_file:line — symbol / message>
source_pr:  #<N>（symbol を導入した PR）
category:   enum-flag-sync | stale-text | lockfile-drift | docs-code
```

Worker reports and independently detected ones are deduplicated. The dedup key is based on `file:line`; if the same `file:line` has multiple messages, both are listed (no information is discarded). If there are 0 gaps, Final-3 is skipped.

#### Phase Final-3: reconciliation (folding into the originating PR, parallel per PR)

Group the gaps detected in Final-2 by `source_pr`, and **fix and push in the originating PR's working copy** (since it's before the merge, this naturally folds into the PR, leaving no follow-up behind).

- **Parallel**: groupBy gaps per PR → **parallel per PR** (no collision, since each uses a separate working copy). **Multiple gaps within the same PR are sequential** (they share the same working copy)
- **Steps**: edit the target file in the originating PR's working copy → lint (auto-fix) → commit (`fix(sync): ...`) → push
- **No full review loop is run** (since this is mechanical synchronization). Only a lint pass is confirmed

Edge cases:

| Case | Handling |
|---|---|
| The target file is already being edited by a different PR-B, causing a folding conflict | Give up folding into the originating PR and fall back to a **dedicated reconciliation PR** (below) |
| Multiple PRs introduce the same symbol | Dedicated reconciliation PR |
| Reconciliation's lint/folding fails | **Fail-soft**: leave only that gap as a warning and continue the run (same as for things that can't be mechanically fixed at the design level) |
| Folding introduces a new cross-cutting issue | audit→reconciliation is **fixed at 1 pass** (not recursive). The remainder is a warning. Guarantees convergence and a cost ceiling |
| Folding into an upstream stacked PR → downstream base drift | Subsumed into Phase Final-4's dependency-order merge procedure |

**Dedicated reconciliation PR**: a corrective PR created when a single gap can't be folded into one PR (conflict / spanning multiple PRs). Since a GitHub PR's base is singular, "stacked onto every tip" isn't possible. So **it merges last, with main as the base, after all content PRs have merged** (built into the tail of Phase Final-4). This PR is also merged within the run, so no follow-up is left behind.

Gaps resolved via reconciliation are recorded in the aggregate report as "resolved within the run (folded)". Only gaps left over via fail-soft are treated as warnings.

#### Phase Final-4: dependency-order merge (centralized by the parent)

Since workers don't self-merge, the actual merge is centrally managed here by the parent. The merge follows the central policy's `irreversible` gate (see "Merge and the autonomy policy"; default `ask`). It runs when `--merge` is specified (`--merge` is an explicit opt-in that overrides the gate to `proceed`; when not specified, it follows the default `ask` and goes through the "After completion" confirmation below).

Merge each PR in topological order (upstream → downstream):

1. `POLICY_GUARD_PROCEED=merge gh pr merge <上流> --squash` (**remote-only merge; do not add `--delete-branch`** — at this point the worker's working copy still holds the branch and remains, so deleting the local branch would fail with `fatal: '<branch>' is already used by worktree`. Deletion of the remote/local branch and the working copy is consolidated into Final-5 cleanup. `POLICY_GUARD_PROCEED=merge` conveys `--merge`'s proceed override to the PreToolUse `policy-hook.mjs`; see "Merge and the autonomy policy")
2. Reassign the downstream PR's base with `gh pr edit <下流> --base main` (switching the base from the upstream head → main) before merging the next one. Since the upstream's squash-merge has already introduced changes into main, if the base reassignment alone causes a phantom conflict, run `git rebase origin/main` in the downstream's working copy before continuing (the parent-side ref is left untouched)
3. **If a dedicated reconciliation PR was created in Phase Final-3, it merges last, with main as the base, after all content PRs have merged** (this PR too is merged within the run, leaving no follow-up)
4. If auto-merge is disabled on the repository / an immediate merge isn't possible due to branch protection, etc. → leave that PR as `merge-ready` and mark its downstream dependents as `skipped`, with a warning
5. Confirm each PR's merge completion with `gh pr view --json mergedAt,state` before proceeding to the next (waiting for the squash merge to take effect)

Even if the parent dies partway through, drive can continue the rest via idempotent resume (detecting already-merged PRs).

#### Phase Final-5: cleanup of worker working copies

Cleans up the working copies and related local branches for **workers launched in this drive run**. Since this runs after Final-4's merge, successful workers are all already merged and become cleanup targets (working copies that used to be "left as merge-ready" are now also cleaned up here, resolving the leftover problem). Orphans outside this run's scope are out of scope (delegated to `/health` area #7. [Issue #71](https://github.com/ozzy-labs/skills/issues/71)).

Cleanup policy by status (common across hosts):

- **`merged`** (merge completed in Final-4): cleanup target
- **`merge-ready`** (left in place in Final-4 due to auto-merge being unavailable): **do not** clean up (leave it until the user merges manually)
- **`failed`**: **do not** clean up (leave it so it can be resumed by re-running)

The specific deletion steps and known pitfalls (loss of cwd, lock release, leftover synthetic branches) depend on the isolation mechanism, so follow the host-specific procedure (Claude Code: "Phase Final-5: subagent worktree cleanup" in `SKILL.claude-code.md`). If any working copy other than `merged` remains, or cleanup itself fails, output a list of leftovers and manual cleanup steps as a warning at the end of the aggregate report.

#### Phase Final-6: aggregate report

Formatting the aggregate report is handled by `drive-report.mjs aggregate`. Passing the array of worker return values and the meta collected in Final-1 through Final-5 (`{results, targets_order, original_args, cross_cutting, cleanup, integrity_warnings}`) via stdin or `--input` returns formatted per-status counts, review aggregation, cross-cutting/cleanup lines, and the output decision for the resume line:

```bash
echo '<aggregate-json>' | node <この skill のディレクトリ>/drive-report.mjs aggregate
```

Based on the results of the consistency check, audit, reconciliation, merge, and cleanup, output the aggregate report:

```text
drive 完了 (4/5 merged, 1 skipped):
  #1 feat: ...        | PR #100 | merged
  #2 fix:  ...        | PR #101 | merged       (Review: C0 W0 I2)
  #3 feat: ...        | PR #102 | merged
  #4 chore: ...       | skipped (upstream failed: #5)
  #5 refactor: ...    | failed (test loop)

集計:
  merged:           3
  skipped:          1
  failed:           1
  総レビュー反復:    5 回
  cross-cutting:    2 gaps resolved (folded into PR #100, #102)
  cleanup:          3/5 removed (2 preserved: 1 failed, 1 skipped)

再開: /drive <元の引数>
```

The `cross-cutting:` line displays the number of gaps resolved via reconciliation in Phase Final-3 and the PRs they were folded into, in the form `<N> gaps resolved (folded into ...)`. If a dedicated reconciliation PR was created and merged, it also appears as one line in the merged list, and the PR number is included in `folded into`. If there are 0 gaps, it's `cross-cutting: none`. If gaps remain via fail-soft, it's shown as `<N> resolved, <M> unresolved (warning)`, with a warning block listing the unresolved items and a recommendation for manual handling.

The `再開:` line is **always** output as a single line right after the tally block — `再開: /drive <元の引数>` — whenever there's 1 or more `failed` / leftover `merge-ready` / `skipped` (following the "Argument restoration (resume command)" convention). Re-running triggers idempotent resume, which detects already-merged PRs / existing PRs, skips completed targets, and continues from the remaining targets. It's not shown when all targets complete as merged.

## Failure semantics

| Situation | Treatment | Impact on downstream |
|---|---|---|
| Per-axis exit_criteria still unmet even after the review loop cap | partial success (merge-ready) | none |
| Auto-merge unavailable in Phase Final-4 (branch protection, etc.) | leave that PR as merge-ready | downstream marked skipped |
| implement / ship aborted (test failure, etc.) | failed | skipped |
| Reconciliation folding fails | fail-soft (gap left as a warning) | none (the PR itself is still merge-ready) |
| Independent task failure | doesn't affect other parallel tasks | - |

For any failure or leftover, the resume method is the same — just re-run the `再開: /drive <元の引数>` at the end of the report (see Phase 5 / Phase Final-6). Idempotent resume detects the existing PR / branch / already-merged PR, skips completed targets, and resumes from where it left off.

## Notes

- Never read or stage `.env` files
- If the `gh` CLI is unauthenticated, display an error message and abort
- Merging follows the central autonomy policy's `irreversible` gate (default `ask`; see "Merge and the autonomy policy"). It is not performed by default, and runs only when `--merge` is specified (`--merge` is an explicit opt-in that overrides the gate to `proceed`; single mode auto-merges in Phase 4, orchestration has the parent centrally merge in dependency order in Phase Final-4)
- Orchestration workers don't self-merge (they stop at `merge-ready` and the parent merges in Final-4). This allows cross-cutting concerns to be folded in before the merge
- Info findings are not fixed, only reported (design-related changes aren't made mechanically)
- In orchestration mode, workers are always launched in an isolated working copy (the isolation mechanism is host-dependent)
- Exceeding a concurrency of 8 only warns. Be mindful of GitHub Actions concurrent-run limits / API rate limits / observability / cost
- If a circular dependency is detected, report the error and abort
