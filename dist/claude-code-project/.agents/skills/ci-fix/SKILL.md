---
name: ci-fix
description: A thin wrapper that collects logs from a failed CI run, formats the context, and connects to `/drive`. Input resolution (explicit run id > latest failure on an explicit branch > latest failure on the current branch) → flaky determination (one `gh run rerun --failed` + polling; skipped with `--no-rerun`) → log extraction (`gh run view --log-failed`; the ANSI-stripping + error-line extraction regex is the same as health's same-error determination) → assembling the instruction text → launching `/drive`. `--dry-run` outputs only the instruction text (no rerun, no drive launch). A failure on the main branch is called out as high priority at the top of the report.
---

# ci-fix - Format context for a failed CI run → connect to drive

A **thin wrapper responsible only for collecting logs from a failed CI run and formatting the context**. Since implementation, fixing, and PR creation are `/drive`'s responsibility, this skill goes only as far as determining "which run to target," "whether it's flaky," and "what failed," and then passing the formatted **instruction text** to `/drive` in single mode. This establishes a skill-level path to close health's Recent failed actions (area 13).

The deterministic processing (input resolution priority / flaky determination flow / error extraction regex) is a fixed contract in this SKILL.md, and Claude does not change the order or regex on its own judgment.

## Input

```text
ci-fix [<run-id> | --branch <name>]
  --no-rerun   skips the flaky determination (rerun) (use when you want to avoid consuming credits)
  --dry-run    outputs only the instruction text (no rerun, no drive launch; no side effects)
  --auto       skips confirmation before launching drive (see the Claude Code companion)
```

`<run-id>` and `--branch` are not specified together (run id takes priority).

## Input resolution priority (fixed)

The target run is resolved in the order in the table below. Once a higher-priority entry resolves, lower-priority entries are not evaluated (fixed order; Claude does not reinterpret it).

| Rank | Input | Resolution method |
| --- | --- | --- |
| 1 | Explicit run id (`<run-id>`) | Target that run |
| 2 | Explicit branch (`--branch <name>`) | The latest failure from `gh run list --branch <name> --status failure --limit 1` |
| 3 | Current branch (no input) | The latest failure from `gh run list --branch <current-branch> --status failure --limit 1` |

If there is no matching failed run, report "**no failed run**" and end (drive is not launched).

**A failure on the main branch is treated as high priority** (= broken merged code) and called out at the top of the report. If the target run's branch is `main`, output `⚠️ main branch failure (merged code broken)` as the first line.

## Flaky determination (up front)

To avoid passing a non-reproducing failure (flaky) to drive, it is rerun once **before** log extraction to determine this. When `--no-rerun` is specified, this entire step is skipped and it proceeds directly to log extraction.

1. Run `gh run rerun <id> --failed` **only once** (reruns only the failed jobs).
2. Poll until completion: **30-second interval, 15-minute cap**. Wait for `status=completed` via `gh run view <id> --json status,conclusion`.
3. Determination:
   - If the rerun completes as `success` → report "**flaky (no fix needed)**" and end (drive is not launched).
   - If the rerun fails again (`failure`) → treat it as a reproducing failure and proceed to the "Log extraction" step below.
   - If polling reaches the 15-minute cap → end as `要確認` (undeterminable) (drive is not launched).

With `--no-rerun`, no rerun is performed, and the most recent failed run's log is used directly as the extraction target (whether it is flaky is not determined).

## Log extraction

Only for reproducing failures, extract an error summary from the failure log.

```bash
gh run view <id> --log-failed | tail -200
```

Extraction has two stages:

1. **ANSI stripping:** replace `/\[[0-9;]*m/g` with an empty string.
2. **Error-line extraction:** match `/(error|Error|failed)[\s:].*$/` against each line, and use the matched portion of the **last matching line** as the summary key.

These two regexes are **identical to health `--deep`'s same-error determination** (the SSOT is `.agents/skills/health/health-check.mjs`'s `stripAnsi` and `extractCiErrorKey`). `tests/ci-fix.test.mjs` enforces the regex match between health-check.mjs and this SKILL.md via a sync assertion (to prevent drift). If the regex changes, revise both the health side and this SKILL.md together.

## Instruction text (template)

The instruction text passed to drive is assembled in the following format. Omit items that are unknown (do not fill them with blanks).

```text
CI failure on <workflow-name> (branch: <branch>, run: <run-id>)

  Job:   <failed-job>
  Step:  <failed-step>
  Error: <extracted error summary>
  Workflow file: <path to the file under .github/workflows/xxx.yaml>
  Repro: <reproduction command, if known. e.g. pnpm test / pnpm run lint>

Investigate the above CI failure, fix the cause, and create a PR.
```

Fill `<workflow-name>` / `<failed-job>` / `<failed-step>` from the output of `gh run view <id> --json`, and the workflow file path from the corresponding file under `.github/workflows/`.

## Connecting to drive

- **Default:** present the assembled instruction text for confirmation, and after approval launch single-mode `/drive "<instruction text>"` (the confirmation UI wiring is host-dependent — for Claude Code it's the AskUserQuestion in `SKILL.claude-code.md`). Since launching drive is an **externally-visible action** (PR creation), confirmation is inserted by default.
- **`--auto`:** skips confirmation before launching and launches `/drive` directly (an explicit opt-out of the externally-visible action).
- **`--dry-run`:** only outputs the instruction text and **performs neither the rerun nor the drive launch** (see "Boundary of side effects" below).

## Boundary of side effects

| Flag | rerun (`gh run rerun`) | drive launch |
| --- | --- | --- |
| (default) | Yes (once) | After confirmation |
| `--no-rerun` | No | After confirmation |
| `--auto` | Yes (once) | Without confirmation |
| `--dry-run` | **No** | **No** |

`--dry-run` has **no side effects** (neither credit consumption from rerun nor PR creation by drive occurs). Even when `--dry-run` is specified together with other flags, `--dry-run`'s "output only" takes priority.

## Out of scope

| Item | Reason for exclusion |
| --- | --- |
| 1. Actual fixing and PR creation | drive's responsibility. This skill only does input resolution and context formatting |
| 2. Multiple reruns for flakiness | Rerun happens only once (to limit credit consumption). If it passes once, it's flaky; if not, it's treated as reproducing |
| 3. Batch processing of multiple runs | Only 1 run is targeted. Multiple failures are launched individually |

## Notes

- Do not read or stage `.env` files
- If the `gh` CLI is not authenticated, display an error message and abort
- The SSOT for the error-extraction regex is health (`health-check.mjs`'s `extractCiErrorKey`). This skill documents the identical regex and enforces the match via tests (it does not extend the regex itself on its own, to prevent drift from restating it)
- If the target run's branch is `main`, call it out as high priority at the top of the report
