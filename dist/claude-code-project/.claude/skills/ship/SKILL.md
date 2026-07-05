---
description: Runs verification, commit, and PR creation all at once. An integrated pipeline that runs verify (build + type + test + lint) → commit → PR creation in sequence against the changes.
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob, AskUserQuestion
---

# ship

Read `.agents/skills/ship/SKILL.md` and follow the workflow steps.

**Important:** while executing each step, **ignore entirely** the "next action suggestion" section and the "completion report" section within the loaded skill. This skill controls the transitions between steps.

## Claude Code-specific additions

**If it fails:** report the error content, suggest fixing it and running `/ship` again, then abort.

Immediately after the completion report, call AskUserQuestion (do not set the `answers` parameter):

- **「PR をレビューする」** → Read `.claude/skills/review/SKILL.md` and follow its steps
- **「PR をマージする」** → run the merge with `gh pr merge --squash --delete-branch` and report the result
