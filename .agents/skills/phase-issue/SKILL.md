---
name: phase-issue
description: Generates a Phase-N tracking issue. Assembles a structured issue body containing cross-session handoff context, a decisions table, per-PR tasks, DoD, and the Phase N+1 outlook, then files it with gh issue create. Supports a non-interactive mode where all items are passed as arguments, and an interactive mode (Claude Code companion) that fills in whatever is missing.
---

# phase-issue - Phase-N tracking issue generation

Hardcodes the structure of the Phase-N tracking issue (cross-session handoff context + decisions table + per-PR tasks + DoD + Phase N+1 outlook) that recurs across ozzy-labs, and deterministically assembles the issue body from content gathered via arguments or interactively. Files it with `gh issue create --body-file`, or, when `--draft` is specified, outputs it to stdout.

This skill is self-contained through filing. It does not integrate with drive or auto-number the Phase number (out of scope).

## Input

```text
phase-issue <phase-number> "<title>"
  --description "..."         (project description)
  --refs "owner/repo1,owner/repo2"  (reference implementations, comma-separated)
  --donts "..."               (things not to do, newline-separated)
  --decisions-file <path>     (decisions YAML/Markdown file)
  --tasks-file <path>         (per-PR tasks file)
  --dod "..."                 (Definition of Done, newline-separated)
  --outlook "..."             (Phase N+1 outlook)
  --related "..."             (related issue/PR/ADR, newline-separated)
  --label "<label>"           (issue label; default: "chore")
  --repo "<owner/repo>"       (target repo to file in; defaults to the current repo)
  --draft                     (output the body to stdout instead of filing)
```

### Required arguments

- `<phase-number>`: an integer (e.g. `0`, `1`, `2`)
- `<title>`: a quoted string (e.g. `"agentic-watch foundation"`)

### Handling optional arguments (non-interactive mode)

The canonical SKILL.md operates on a **non-interactive premise**. If an optional argument is missing, the corresponding section is **omitted** from the body (not filled with a placeholder). If you want to interactively gather the missing items, use the Claude Code companion (`SKILL.claude-code.md`).

If `--decisions-file` and `--tasks-file` are specified, transcribe the file contents as-is into the corresponding section (no parsing or formatting — the user's content is expected to already be markdown-formatted).

## Hardcoded section structure

The issue body is built with the following section structure. **The order is fixed** and must not change:

```markdown
# Phase {{N}}: {{title}}

## Cross-session handoff

このセクションは新しいセッション/エージェントが本 issue を読んだだけで作業を引き継げるよう、必要な context を集約する。

- **プロジェクト概要:** {{description}}
- **参考実装:** {{refs (linked)}}
- **やってはいけないこと:** {{donts (bulleted)}}

## 決定事項

{{decisions-file の内容、または "(TBD)"}}

## タスク（PR ごと）

{{tasks-file の内容、または "(TBD)"}}

## Definition of Done

{{dod (bulleted)}}

## Phase {{N+1}} outlook

{{outlook、または "(未定)"}}

## 関連

{{related (bulleted)}}
```

### Per-section formatting rules

- **Cross-session handoff:**
  - If `--description` is absent, do not use `(未記入)` — instead **omit the line entirely** (do not emit the bulleted item)
  - Expand `--refs`'s comma-separated values into a bulleted list, and linkify `owner/repo` to `https://github.com/owner/repo`
  - Expand `--donts`'s newline-separated values into a bulleted list
  - If all three items are empty, omit the `## Cross-session handoff` section itself
- **決定事項 / タスク（PR ごと）:** If no file is specified, set the section body to `(TBD)` (keep the section itself). In a Phase issue, **decisions and tasks form the skeleton**, so leave a placeholder even when unfilled to prompt a later follow-up
- **DoD:** Expand newline-separated values into a `- [ ] item` style checkbox list. If empty, use `(TBD)`
- **Phase N+1 outlook:** Transcribe the string as-is. If empty, use `(未定)`
- **関連:** Expand newline-separated values into a bulleted list. `#N` / `owner/repo#N` / URL are all acceptable (do not linkify — keep the original text). If empty, omit the section

### Marker block note

Always embed the following HTML comment at the top of cross-session handoff. It functions as an anchor for future regeneration/updates by phase-issue:

```markdown
<!-- phase-issue:v1 phase=N -->
```

`v1` is the format version of the body this skill generates. Bump it when the schema changes.

## Steps

### 1. Argument parsing

1. Obtain `<phase-number>` and `<title>`. Both are required. If missing, display an error and abort
2. Parse the options. If the same option is specified more than once, use the last one
3. If `--decisions-file` / `--tasks-file` are specified, verify the file exists and is readable. On failure, display an error and abort

### 2. Body assembly

1. Assemble the body according to the hardcoded section structure
2. Replace the placeholders `{{N}}` / `{{title}}` / `{{N+1}}` with their actual values
3. Following the per-section formatting rules, appropriately distinguish between omitting an empty section / TBD / 未定
4. Insert the marker block at the top of cross-session handoff

### 3. Filing the issue or outputting to stdout

- When `--draft` is specified:
  - Output the body to stdout
  - Do not call the `gh` command
- When `--draft` is not specified:
  - Write the body to a temporary file
  - Run `gh issue create --title "Phase {{N}}: {{title}}" --label "<label>" --body-file <tmp>`
  - If `--repo` is specified, pass the `--repo` argument to gh
  - On successful filing, display the issue URL

### 4. Completion report

```text
phase-issue complete:
  Title: Phase <N>: <title>
  Filed to: <repo>
  Issue:    <URL>  (when --draft is specified: "(output to stdout)")
```

## Notes

- Optional items not passed as arguments are either omitted from the body or filled with TBD. Claude does not fill in content by imagination
- If the `gh` CLI is unauthenticated, display an error message and abort
- `--draft` mode has no external side effects (no file writes, no `gh` calls)
- Titles are assumed to be wrapped in double quotes. Shell escaping on the command side is the caller's responsibility
- The canonical SKILL.md operates on a non-interactive premise. If you want to gather items interactively, use the Claude Code companion
- **Does not learn style from past issues**: the section structure is fixed within SKILL.md (a learning mechanism would cost more to implement than it's worth)
- **Does not auto-number the Phase number**: the caller specifies `<phase-number>` explicitly
- **Does not integrate with drive**: phase-issue is self-contained through filing. Splitting/implementing the generated issue is handled separately via drive
