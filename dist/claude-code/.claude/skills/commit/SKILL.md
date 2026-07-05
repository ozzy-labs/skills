---
description: Stages changes and commits them following Conventional Commits. Does not push or create a PR.
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob, AskUserQuestion
---

# commit

Read `~/.agents/skills/commit/SKILL.md` and follow the workflow steps.

## Claude Code-specific additions

Present the list of changed files to the user:

```text
変更ファイル:
  M src/pages/index.astro
  A src/content/blog/new-post.md
```

Immediately after the completion report, call AskUserQuestion (do not set the `answers` parameter). Do not end the skill with just the report output:

- **"Create a PR"** → Read `~/.claude/skills/pr/SKILL.md` and follow its steps
- **"Make additional changes"** → end
