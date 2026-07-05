---
argument-hint: "[<run-id> | --branch <name>] [--no-rerun] [--dry-run] [--auto]"
disable-model-invocation: true
allowed-tools: Bash, Read, AskUserQuestion, SlashCommand
---

# ci-fix

Read `.agents/skills/ci-fix/SKILL.md` and follow its workflow steps.

**Important:** the input resolution priority / flaky determination flow / error extraction regex are a fixed contract in SKILL.md. The regex is identical to health (`health-check.mjs`'s `extractCiErrorKey`), and tests enforce the match. Claude does not change the order or regex on its own.

## Claude Code-specific additions

### Running commands

Use the `gh` CLI (Bash) to resolve, rerun, and fetch logs for the run. Execute in the order of SKILL.md's "Input resolution priority" → "Flaky determination" → "Log extraction":

```bash
# Input resolution (if there's no explicit run id, pull the latest failure from the branch)
gh run list --branch <name> --status failure --limit 1 --json databaseId,workflowName,headBranch,conclusion

# Flaky determination (skipped when --no-rerun is specified)
gh run rerun <id> --failed
# Wait for completed at a 30-second interval, capped at 15 minutes
gh run view <id> --json status,conclusion

# Log extraction for a reproducing failure
gh run view <id> --log-failed | tail -200
```

ANSI stripping (`/\[[0-9;]*m/g`) and error-line extraction (the last match of `/(error|Error|failed)[\s:].*$/`) strictly follow the regex in SKILL.md.

### Confirmation before launching drive (AskUserQuestion wiring, default)

Launching drive is an **externally-visible action** — PR creation. By default, present the assembled instruction text and confirm whether to launch via `AskUserQuestion` (do not enumerate options as text):

1. Present the formatted instruction text and a summary of the target run (workflow / job / step / error summary / a high-priority callout if it's a main branch failure).
2. Confirm via `AskUserQuestion`:
   - **"Launch drive"** → launch `/drive "<instruction text>"` in single mode via `SlashCommand`.
   - **"Cancel"** → display the instruction text and end.

### `--auto` (skip confirmation)

When `--auto` is specified, the above `AskUserQuestion` is **not inserted**, and `/drive "<instruction text>"` is launched directly via `SlashCommand` (an explicit opt-out of the externally-visible action). This is intended for unattended execution via routine / `/loop` / `schedule`.

### `--dry-run` (no side effects)

When `--dry-run` is specified, **neither the rerun nor the drive launch is performed**; only the instruction text is output before ending. Neither `AskUserQuestion` nor `SlashCommand` is called. Even when `--dry-run` is specified together with other flags, "output only" takes priority.

### Ending on flaky / no failed run

- flaky (rerun succeeds) → report "flaky (no fix needed)" and end. drive is not launched.
- No failed run → report "no failed run" and end.
- Polling cap (15 minutes) reached → end as `要確認` (undeterminable). drive is not launched.

### Completion report and next-action suggestions

End once the instruction text presentation / launched drive / flaky or no-failed-run report have been displayed. If drive was launched, defer to its own report. Do not suggest next actions.
