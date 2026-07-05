---
name: commit-conventions
description: Rules for generating Conventional Commits messages (Type/Scope decision table, format). Referenced by other skills.
---

# commit-conventions - Commit message generation rules

Conforms to Conventional Commits 1.0.0 (validated by commitlint).

## Automatic Type determination

| Nature of change | Type |
|---------|------|
| Adding a new feature | `feat` |
| Bug fix | `fix` |
| Documentation change | `docs` |
| Formatting (no behavior change) | `style` |
| Refactoring | `refactor` |
| Performance improvement | `perf` |
| Adding/fixing tests | `test` |
| Build / dependencies | `build` |
| CI/CD configuration | `ci` |
| Other | `chore` |

## Scope determination

If the change is concentrated in a specific directory or feature, attach a scope. Choose a concise scope from the directory name or feature name:

- Example: `feat(blog):`, `fix(auth):`, `ci(deploy):`
- If the change spans multiple directories, omit the scope

## Message body

- Line 1: `type[(scope)]: description` (in English, roughly 50 characters or fewer)
- If there are multiple logical changes, elaborate in the body

## General notes

- **Never force push**
- **Do not read or stage `.env` files** (exclude from `git add` targets)
- Do not add `Co-Authored-By` to commit messages (this is a personal project)
