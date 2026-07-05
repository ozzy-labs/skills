---
name: implement
description: Creates a branch, plans the implementation, and makes code changes based on an Issue or an instruction. Accepts an Issue number or a text instruction.
---

# implement - Create a branch and implement from an Issue/instruction

Based on reading an Issue or a direct instruction, this performs everything from branch creation through implementation planning to code changes.

## Input

- **If an Issue number** (`#N` or a bare number): fetch the content with `gh issue view <N>` and organize the requirements
- **If a text instruction**: treat it as-is as the requirements
- **If no argument**: confirm what to implement

## Action classification and policy reference

This skill does not hardcode individual approval gates into prose; instead it follows the central autonomy policy (the SSOT for the 3 classes, gate vocabulary, and `policy.yaml` hierarchy defined by the `policy` skill). It classifies its own actions into the following classes, resolves the effective gate, and then executes:

| Action in this skill | Class | policy reference | Zero-config default gate |
| --- | --- | --- | --- |
| Implementation on the branch (file edit/add/safe delete) | `reversible-local` | `--action=branch-edit` | `proceed` (present the plan and continue + audit trail) |
| Changes involving migration / data deletion / CI or release config changes | `irreversible` | `--class=irreversible` | `ask` (explicit approval before starting) |

Resolve the effective gate with `policy-read.mjs` in the sibling `policy` skill (for Claude Code user-scope this is `~/.claude/skills/policy/policy-read.mjs`, for dogfooding `<repo>/.claude/skills/policy/policy-read.mjs`, and for Codex/Gemini `~/.agents/skills/policy/policy-read.mjs`):

```bash
node <policy skill のディレクトリ>/policy-read.mjs --action=branch-edit --repo-root="$PWD"
# => .resolved.gate（既定 proceed）
node <policy skill のディレクトリ>/policy-read.mjs --class=irreversible --repo-root="$PWD"
# => .resolved.gate（既定 ask）
```

The gate vocabulary has only 3 values:

- `proceed`: execute without waiting for approval, and leave the plan/changes in the report as an audit trail
- `batch-confirm`: confirm once, all together, before starting
- `ask`: obtain explicit approval (Approval Gate) for each action

**Does not break even if policy is absent:** `policy-read.mjs` is fail-safe by design — unreadable or invalid values always fall back to the stricter side (`ask`). In environments where the `policy` skill itself is not deployed and `policy-read.mjs` cannot be called, apply the zero-config default gates from the table above directly (`reversible-local`=`proceed` / `irreversible`=`ask`).

**Consistency under drive:** drive is delegated autonomous execution by the user, and the `reversible-local` default of `proceed` (skip plan approval and continue) is consistent with this delegation. Standard branch implementation proceeds with proceed, and only changes judged `irreversible` require approval with gate=`ask`.

## Procedure

### 1. Create a branch

1. Check the current state with `git status` and `git branch --show-current`
2. Determine a branch name in `<type>/<slug>` format from the requirements
3. Create the branch with `git checkout -b <branch-name>`

If already on a feature branch, confirm whether to continue working on that branch.

### 2. Implementation plan and action classification

1. Investigate the codebase
   - Identify relevant files
   - Understand existing implementation patterns
   - Check the scope of impact
2. Present the implementation plan:
   - Files to change and their content
   - Scope of impact
3. Classify the change into a class using the table in "Action classification and policy reference," and resolve the effective policy gate:
   - Only ordinary implementation on the branch → `reversible-local` (default `proceed`): present the plan and continue (do not wait for approval; the plan is kept as an audit trail)
   - Includes migration / data deletion / CI or release config changes → `irreversible` (default `ask`): obtain explicit approval before proceeding to implementation

### 3. Implementation

Execute code changes according to the gate resolved by policy (`proceed` starts without waiting for approval, `batch-confirm` confirms all at once before starting, `ask` starts after approval). Report progress as each file's changes are completed.

### 4. Verification (verify)

After implementation is complete, refer to `~/.agents/skills/verify/SKILL.md` and run the combined verification (build + type + test + lint) with the verify engine. verify auto-discovers verification commands through a discovery chain (AGENTS.md's 「検証」 section → package.json scripts → task runner → language heuristics) and runs them serially, each with its source attributed.

If errors occur, fix them on the spot and run verify again.

### 5. Completion report

```text
実装完了:
  ブランチ: <branch-name>
  変更ファイル:
    A path/to/new-file
    M path/to/modified-file
```

## Notes

- Do not read or stage `.env` files
- If the `gh` CLI is not authenticated, display an error message and abort
- Classify actions into the 3 classes and resolve policy before executing. Do not hardcode individual approval gates into prose
- For changes judged `irreversible` (migration / data deletion / CI or release config changes), always obtain explicit approval under gate=`ask` before starting
