---
description: Collects open issues with the `backlog.mjs` engine, orders them by dependency graph (reusing drive's dependency-notation SSOT) and fixed-vocabulary priority rules, and presents start candidates output in drive argument format (e.g. `#12,#15 -> #18`). Default is presentation only; `--drive[=N]` hands off to drive after confirmation; `--auto` hands off to drive without confirmation, but only for issues labeled `auto-ok` (HATL). Single repo only.
argument-hint: "[--repo owner/repo] [--label <filter>] [--limit N] [--drive[=N] | --auto]"
disable-model-invocation: true
allowed-tools: Bash, Read, AskUserQuestion, SlashCommand
---

# backlog

Read `~/.agents/skills/backlog/SKILL.md` and follow its workflow steps.

**Important:** All determinism (issue collection / dependency extraction / priority sorting / `auto-ok` gating / drive argument formatting) is handled by the bundled **`backlog.mjs` engine**. The SSOT for dependency notation is drive (`drive-plan.mjs`), which the engine imports and reuses. The SKILL confines itself to the judgment layer: "call the engine, present its output as-is, and confirm launching drive via the policy gate." Claude does not create priority ordering on its own judgment.

## Claude Code-specific additions

### Running the engine

```bash
node ~/.claude/skills/backlog/backlog.mjs [--repo owner/repo] [--label <filter>] [--limit N] [--drive[=N] | --auto]
```

For dogfooding (within this repo), it's `<repo>/.claude/skills/backlog/backlog.mjs`. Output is formatted text (structured JSON with `--json`). Pass the user's input through as the arguments.

- `--repo owner/repo`: if omitted, the engine extracts it from `git remote get-url origin`
- `--label <filter>`: label filter passed to `gh issue list`
- `--limit N`: collection limit (default 20)
- `--drive[=N]`: hands off the top N + dependency closure to drive (omit N for all candidates)
- `--auto`: goes to drive without confirmation. However, only targets issues labeled `auto-ok` (HATL)

### Candidate selection and launching drive (policy's `externally-visible` gate = batch-confirm)

Launching drive is an externally-visible action. Look up the gate with `policy-read.mjs --action=drive-launch --class=externally-visible --repo-root="$PWD"` (user-scope: `~/.claude/skills/policy/policy-read.mjs`; dogfood: `<repo>/.claude/skills/policy/policy-read.mjs`). Confirm according to the gate.

**present mode (default)** — neither `--drive` nor `--auto`:

1. Present the engine output (priority-ordered candidate table + `drive_args`) as-is.
2. Use AskUserQuestion (`multiSelect: true`) to have the user select the candidates to start on (candidates are `handoff.selected`). Do not enumerate `Y/n` as text.
3. Present the drive arguments corresponding to the selected subset (including the dependency closure) and confirm whether to launch:
   - **"Launch drive"** → launch `/drive <drive_args>` via `SlashCommand`
   - **"Just output the arguments"** → display `drive_args` and end

**drive mode** — `--drive[=N]`:

1. Present the top N + dependency closure selected by the engine (`handoff.selected` / `handoff.drive_args`).
2. With gate=`batch-confirm` (default), confirm the drive arguments to be launched **just once** via AskUserQuestion as a batch (do not set `answers`):
   - **"Launch"** → launch `/drive <drive_args>` via `SlashCommand`
   - **"Cancel"** → end
3. If the gate is tightened to `ask`, confirm the drive arguments one at a time (one wave at a time).

**auto mode** — `--auto`:

1. Present the handoff set the engine narrowed down to only `auto-ok`-labeled issues (`handoff.selected`), and the exclusion breakdown (`excluded_no_label` / `excluded_unapproved_dep`).
2. Since the `auto-ok` label functions as standing approval (a boundary condition), **no individual confirmation is done**. With gate=`batch-confirm` (default), present the handoff set once and launch `/drive <drive_args>` via `SlashCommand`.
3. If the handoff set is empty (0 issues with `auto-ok`), do not launch drive; report that fact and end.
4. Only when the gate is tightened to `ask` does `--auto` also fail-safe escalate to individual confirmation.

### Integration with scheduled execution

Launching in the form `/backlog --auto --limit 3` from `schedule` (cron routine) or `/loop` closes the loop of "attach `auto-ok` and it gets consumed automatically" (ADR-0028 R5). Since AskUserQuestion cannot be inserted during scheduled execution, `--auto`'s `auto-ok` gating and the policy gate become the sole boundary (the human sets the boundary solely by applying the label).

### Completion report and next-action suggestions

End once the candidate presentation / launched drive arguments / auto exclusion breakdown have been displayed. After launching drive, defer to its own report. Do not suggest next actions.
