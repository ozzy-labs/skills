---
description: Creates a branch, plans the implementation, and makes code changes based on an Issue or an instruction. Accepts an Issue number or a text instruction.
argument-hint: <#issue-number | instruction>
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch, AskUserQuestion
---

# implement

Read `~/.agents/skills/implement/SKILL.md` and follow the workflow steps.

## Claude Code-specific additions

### Input parsing

Parse `$ARGUMENTS` and identify the requirements.

- **If no argument:** confirm with AskUserQuestion, "What would you like to implement? (Issue number or description)" (do not set the `answers` parameter)
- **On `gh` CLI error:** if it's an authentication error, guide the user to run `gh auth login` and abort

### Confirming the implementation plan (follow policy's gate)

Branch according to the gate resolved in "Action classification and policy reference":

- **gate=`proceed` (default for `reversible-local`):** do not show AskUserQuestion; present the plan and proceed with implementation (leave the plan/changes in the report as an audit trail)
- **gate=`ask` (`irreversible`: migration / data deletion / CI or release config changes):** after presenting the implementation plan, confirm with AskUserQuestion (do not set the `answers` parameter):
  - **"Implement with this plan"**
  - **"Revise the plan"**
  - **"Cancel"**
- **gate=`batch-confirm`:** confirm once, all together, before starting

**Under drive:** since autonomous execution has already been delegated, proceed as before, skipping approval, via `reversible-local`'s `proceed`. Only confirm for actions judged `ask`.

### Next action after completion

Immediately after the implementation completion report, call AskUserQuestion (do not set the `answers` parameter):

- **"Run verification, commit, and PR all at once"** → Read `~/.claude/skills/ship/SKILL.md` and follow its steps
- **"Run verification (verify)"** → Read `~/.claude/skills/verify/SKILL.md` and follow its steps
- **"Make additional changes"** → end
