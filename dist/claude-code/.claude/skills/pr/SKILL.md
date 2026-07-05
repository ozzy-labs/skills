---
description: Pushes committed changes to the remote and creates or updates a PR.
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob, AskUserQuestion
---

# pr

Read `~/.agents/skills/pr/SKILL.md` and follow its workflow steps.

## Claude Code-specific additions

Immediately after the completion report, call AskUserQuestion (do not set the `answers` parameter):

- **「PR をレビューする」** → Read `~/.claude/skills/review/SKILL.md` and follow its steps
- **「PR をマージする」** → run `gh pr merge --squash --delete-branch` to perform the merge and report the result
