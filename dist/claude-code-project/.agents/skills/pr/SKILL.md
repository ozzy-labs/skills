---
name: pr
description: Pushes committed changes to the remote and creates or updates a PR.
---

# pr - Push & PR creation

Pushes committed changes to the remote and creates or updates a PR.

## Prerequisites

- Do not push directly to the main branch
- If there are uncommitted changes, commit them first
- If there are no commits to push, stop

## Steps

### 1. Check state

- Check the current branch with `git branch --show-current`
- Check uncommitted changes with `git status`
- Check unpushed commits with `git log --oneline origin/<branch>..HEAD 2>/dev/null || git log --oneline -5`

### 2. Push & create PR

1. Push to the remote with `git push -u origin <branch>`
2. Create the PR:
   - Check for an existing PR with `gh pr view`
   - **If no existing PR:** create the PR with `gh pr create --title "<title>" --body "<body>"`. Use the first line of the most recent commit message as the title
   - **If an existing PR exists:** just push (the PR updates automatically)

PR body format:

```markdown
## Summary

- <bulleted list of changes>

Closes #N <!-- only when originating from an Issue -->
```

### 3. Completion report

```text
Done:
  Branch: <branch-name>
  PR: <PR URL>
```
