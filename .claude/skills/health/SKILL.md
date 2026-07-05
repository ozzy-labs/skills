---
description: Checks, in one shot via the `health-check.mjs` engine, for state unintentionally left behind during repository work (working tree, stash, branch, worktree, PR, issue, actions, etc.) and skill-catalog consistency, presenting a 16-area status table and fixed-vocabulary recommended actions. With `--deep`, does additional read-only investigation of `要確認` items; with `--fix`, executes safe-vocabulary actions (prune / delete / fetch, and `drop` when promoted by `--deep`) following the central policy's gate (reversible-local=proceed / irreversible=ask). Read-only by default.
argument-hint: "[--deep] [--fix] [--yes]"
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, AskUserQuestion
---

# health

Read `.agents/skills/health/SKILL.md` and follow its workflow steps.

**Important:** rendering (the status table, non-clean sections, execution results) is handled by the `health-check.mjs` engine. Present the engine's stdout as-is; don't reformat or reinterpret it.

## Claude Code-specific additions

### Running the engine

Run `health-check.mjs`, in the same directory, via Bash (passing `$ARGUMENTS` as-is). In user-scope it's `~/.claude/skills/health/health-check.mjs`; for dogfooding, `<repo>/.claude/skills/health/health-check.mjs`:

```bash
node ~/.claude/skills/health/health-check.mjs $ARGUMENTS
```

### Argument parsing

Determine the presence of `--deep` / `--fix` / `--yes`. When `--fix` is absent (no arguments / `--deep`), the engine completes read-only, so present the output as-is and end. Any other flags are ignored (reserved for future extension).

### `--fix` confirmation-gate wiring (follows the central policy)

When `--fix` is specified and `--yes` is **absent**, the engine resolves each action's gate via the central policy (`policy-read.mjs`). The host side branches the UI **per gate** (gate determination belongs to the engine — the host never re-determines the vocabulary/class):

1. **Execute + list:** run `node ~/.claude/skills/health/health-check.mjs --fix [--deep]`. The engine **executes on the spot** `proceed` (reversible-local) actions and outputs the "execution results" (`✔ done` / `✖ failed` on each line) (audit trail, no confirmation needed). `ask` (irreversible stash drop) actions are output as "actions requiring confirmation (gate=ask)" and are **not executed**.
2. **Individual confirmation of `ask` items:** only when there's an `ask` list, confirm with `AskUserQuestion` **per action** whether it's OK to execute (don't enumerate options as text).
   - Approved → run `node ~/.claude/skills/health/health-check.mjs --fix --yes [--deep]` to execute the rest (the approved `ask` items), and present the execution results and the post-execution status table as-is.
   - Rejected → end without executing anything additional.
   - The `ask` list is empty (everything already executed via `proceed`) → present the execution results and post-execution status table, and end.

For `--fix --yes` (with `--yes` from the start), run the engine once, as-is, without inserting a confirmation. `--yes` is an **explicit opt-out that overrides the policy**, executing all safe actions, including those with gate `ask` (unattended execution via routine / `/loop` / `schedule`).

The engine's `--fix` safe boundary (executing only `prune` / `delete` / `fetch` / the `--deep`-promoted `drop`, with `push` / `要確認` / `要対応` / `abort or continue` out of scope) and gate resolution (reversible-local=proceed / irreversible=ask, falling back fail-safe to ask when a policy is absent) are enforced on the engine side, per the SKILL.md contract. The host side never re-determines the vocabulary or gate.

### Completion report and next-action suggestions

End once the engine output has been presented. AskUserQuestion is not used other than for `--fix`'s individual confirmation. No next-action suggestion is made either.
