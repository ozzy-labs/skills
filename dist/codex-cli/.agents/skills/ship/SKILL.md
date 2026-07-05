---
name: ship
description: Runs verification, commit, and PR creation all at once. An integrated pipeline that runs verify (build + type + test + lint) → commit → PR creation in sequence against the changes.
---

# ship - Run verification, commit, and PR all at once

An integrated pipeline that runs verify (verification) → commit → PR creation in sequence against the changes. If any step fails, abort and report the error content.

## Procedure

### Step 1: verify (verification)

1. Refer to `~/.agents/skills/verify/SKILL.md` and run the combined build + type + test + lint verification with the verify engine (verification commands are auto-discovered via the discovery chain)
2. If any command fails, report it and abort

### Step 2: commit

1. Get the list of changed files with `git status`
2. Stage changed files individually with `git add <file>`. Do not stage `.env` files
3. Refer to `~/.agents/skills/commit-conventions/SKILL.md` and generate a commit message following Conventional Commits
4. Commit with `git commit -m "<message>"`

If there are no changes, proceed to Step 3 if there are already-committed, unpushed commits. Otherwise, end.

### Step 3: pr

1. Check the current branch with `git branch --show-current` (abort if it is main)
2. Push to the remote with `git push -u origin <branch>`
3. Check for an existing PR with `gh pr view`
   - If no existing PR: create one with `gh pr create --title "<title>" --body "<body>"`
   - If an existing PR exists: push only (the PR updates automatically)

### Step 4: Completion report

```text
完了:
  コミット: abc1234 feat: add blog post
  ブランチ: feat/add-blog
  PR: <PR URL>
```
