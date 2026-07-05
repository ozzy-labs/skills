---
name: commit
description: Stages changes and commits them following Conventional Commits. Does not push or create a PR.
---

# commit - Stage and commit

Stages changes and commits them following Conventional Commits. Does not push or create a PR.

## Procedure

### 1. Check the state

Grasp the current state with the following commands:

- Get the list of changed files with `git status`
- Check unstaged changes with `git diff`
- Check staged changes with `git diff --staged`
- Check recent commit history with `git log --oneline -5`

If there are no changes, state that there is nothing to commit and end.

### 2. Stage and commit

1. **Staging:** stage changed files individually with `git add <file>`. Do not stage `.env` files
2. **Generate the commit message:** refer to `.agents/skills/commit-conventions/SKILL.md` and generate the message following the rules
3. **Execute the commit:** `git commit -m "<message>"`

### 3. Completion report

Report the execution result:

```text
完了:
  コミット: abc1234 feat: add blog post
```
