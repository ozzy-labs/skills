---
description: Reviews code changes or PRs across 11 perspectives, reporting via JSON structured output plus a human-readable report. Supports switching between quick and deep modes. Takes a PR number or working-tree diff as input.
argument-hint: <#PR-number | (blank for working tree changes)> [--axes=<axis,...>] [--deep]
disable-model-invocation: true
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Agent, AskUserQuestion, Workflow
---

# review

Read `~/.agents/skills/review/SKILL.md` and follow its workflow steps.

## Claude Code-specific additions

### Argument parsing

Parse `$ARGUMENTS`:

- A number or `#N` → treated as a PR number
- `--axes=<axis,...>` → explicit specification of perspectives to apply
- `--deep` → run in deep mode (launch `Agent({subagent_type: "code-reviewer"})` per perspective in parallel, via **multiple tool calls in the same message**)

### Parallel launch in deep mode

In deep mode, launch a worker per perspective in parallel. **Prefer the Workflow approach when the Workflow tool is available**, falling back to the Agent tool approach when it is not.

#### Workflow approach (recommended)

Pass the perspectives via `args.axes`, and structurally validate findings with `schema` (mismatches are automatically retried, so there is no dropped output from parse failures):

```js
export const meta = {
  name: 'review-deep',
  description: 'review: 観点別 worker を並列起動して findings を収集する',
  phases: [{ title: 'Review' }],
}

// canonical の findings JSON schema（Schema v1）を JSON Schema 化したもの
const FINDINGS_SCHEMA = { /* axis / findings[]: {file, line, severity, message, ...} */ }

const results = await parallel(args.axes.map(axis => () =>
  agent(
    `axis: ${axis}\nmode: deep\ncontext:\n  base: ${args.base}\n  head: ${args.head}\n  pr_number: ${args.pr_number ?? ''}\n\n${args.diff}`,
    { label: axis, phase: 'Review', agentType: 'code-reviewer', schema: FINDINGS_SCHEMA }
  )
))
return { findings: results.filter(Boolean) }
```

- Reuse the existing subagent definition via `agentType: 'code-reviewer'`
- Aggregation (duplicate merging, cross-perspective conflicts, grouping) is not done inside the workflow; after return, the caller passes the findings to `review.mjs render` and leaves it to the engine (canonical step 3). Do not add an aggregation agent inside the workflow
- Pass the diff via `args` (do not have the worker fetch it)

#### Agent tool approach (fallback)

```text
Agent({
  subagent_type: "code-reviewer",
  prompt: "axis: <axis>\nmode: deep\ncontext:\n  base: <base>\n  head: <head>\n  pr_number: <N>\n\n<diff>"
})
```

- Independent subagents within the same wave are launched in parallel via **multiple tool calls in a single message**
- Aggregation is done by the caller passing findings to `review.mjs render` (do not add an LLM call)
- Merge the subagents' return values (JSON) and push them into `findings[]`

### After the completion report

Call AskUserQuestion immediately after the completion report (do not set the `answers` parameter).

**When there are findings:**

- **"Fix the findings"** → Fix the code based on Critical / Warning findings (Info is out of scope)
- **"Proceed as-is"** → exit

**When there are no findings:**

- **"Run through commit and PR in one go"** → Read `~/.claude/skills/ship/SKILL.md` and follow its steps
- **"Proceed as-is"** → exit
