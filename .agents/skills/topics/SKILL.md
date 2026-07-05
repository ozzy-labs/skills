---
name: topics
description: Selects GitHub topic candidates by having the `topics.mjs` engine perform constraint validation, popularity measurement, broad+narrow / singular-plural comparison, and hardcoded ozzy-labs conventions, then applies them via `gh repo edit --add-topic` following the policy's `externally-visible` gate (default batch-confirm). Scope is limited to use within ozzy-labs.
---

# topics - research-driven GitHub topics setup (ozzy-labs scope)

Selecting GitHub topics involves repeating, for every repo, the manual work of "enumerate candidates → validate against official constraints → check popularity → compare broad+narrow / singular-plural → align with ozzy-labs conventions → apply with `gh repo edit --add-topic`". This skill unifies the judgment of the selection stage and the work of the application stage.

The determinism (official constraint validation, popularity retrieval, broad+narrow 5x judgment, singular-plural comparison, ozzy-labs convention conversion / exclusion / hardcoded retention, final selection, rendering) is handled by the bundled **`topics.mjs` engine** ([ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R1, following the precedent of `usage-check.mjs` / `skill-metrics.mjs` / `policy-read.mjs` / `health-check.mjs`). This SKILL.md is confined to the judgment layer — **when to call the engine, how to present the results, and where to confirm with a human (policy gate)**.

**Scope**: Limited to use in repositories under ozzy-labs. Cross-org generalization, persistent caching, and conventions for other orgs are out of scope (see [Out of scope](#out-of-scope)).

## Input

```text
topics <candidate-list>
  --repo owner/repo  (resolved from cwd's origin if omitted)
  --apply            (explicitly opts out of policy's batch-confirm and applies without confirmation)
  --dry-run          (analysis only, does not apply)
```

- `<candidate-list>` is `,`-delimited, or multiple arguments
- If both `--apply` and `--dry-run` are specified, `--dry-run` takes priority (to prevent accidental application; enforced by the engine)
- If `--repo` is not specified, the engine extracts `owner/repo` from `git remote get-url origin`. If no GitHub remote is found, it's recorded in the result JSON's `repo_error`

## Procedure

1. Execute the `topics.mjs` **in the same directory as this SKILL.md** via Bash (passing the arguments as-is). In Claude Code that's `~/.claude/skills/topics/topics.mjs` (dogfood: `<repo>/.claude/skills/topics/topics.mjs`, Codex/Gemini: `.agents/skills/topics/topics.mjs`):

   ```bash
   node <this skill's directory>/topics.mjs <candidate-list> [--repo owner/repo] [--dry-run]
   ```

   By default the engine outputs **formatted text** (candidate count / constraint filter results / popularity table / broad+narrow and singular-plural judgment / convention conversion / final topics / apply plan) to stdout. Structured JSON can be obtained with `--json`.

2. **Present the engine's output as-is** (do not reformat or reinterpret it — constraint validation, 5x judgment, singular-plural, and ozzy-labs conventions are all the engine's responsibility). Candidates with unknown popularity (API failure) are explicitly marked in the table as `人気度不明` and excluded from the 5x / singular-plural comparison.
3. If `repo_error` is raised (no GitHub remote), present that fact and prompt for `--repo owner/repo` to be specified explicitly.
4. Application (`gh repo edit --add-topic`) follows the **policy's `externally-visible` gate** below.

## Application (follows the policy's `externally-visible` gate)

Applying `gh repo edit --add-topic` is an **externally visible action**. Rather than hardcoding an individual approval gate in prose, it follows the central autonomy policy (the SSOT of the 3 classes / gate vocabulary defined by the `policy` skill). Classification and zero-config default:

| This skill's action | Class | policy reference | Zero-config default gate |
| --- | --- | --- | --- |
| Applying topics (`gh repo edit --add-topic`) | `externally-visible` | `--action=topics-apply` | `batch-confirm` (present the final list once for a single batch confirmation) |

The effective gate is looked up via the sibling `policy` skill's `policy-read.mjs` (user-scope: `~/.claude/skills/policy/policy-read.mjs`, dogfood: `<repo>/.claude/skills/policy/policy-read.mjs`, Codex/Gemini: `.agents/skills/policy/policy-read.mjs`):

```bash
node <policy skill directory>/policy-read.mjs --action=topics-apply --repo-root="$PWD"
# => .resolved.gate (default batch-confirm)
```

Align the flags with the policy:

- When `--dry-run` is specified: the engine only outputs the analysis, and neither applies nor confirms (does not call `gh repo edit`)
- When `--apply` is specified: an **explicit opt-out of `batch-confirm`**. The engine executes `gh repo edit <owner/repo> --add-topic <topic1>,<topic2>,...` without confirmation, and even verifies with `gh repo view --json repositoryTopics`
- When neither is specified (`plan` mode): the engine does not apply and returns `apply_command` (the command to be executed). Confirms with the human per the gate:
  - gate=`batch-confirm` (default): present the final topics list all at once for a single batch confirmation (the host's confirmation UI. Do not enumerate `Apply? [Y/n]` in text output. In Claude Code, use AskUserQuestion — see `SKILL.claude-code.md`). If approved, **re-run with the same arguments plus `--apply`**
  - gate=`proceed`: re-run with `--apply` without confirmation
  - gate=`ask`: confirm one topic at a time

**Does not break even without policy present:** `policy-read.mjs` is fail-safe by design — if it can't be read, or the value is invalid, it defaults to the stricter side (`ask`). In environments where the `policy` skill is not installed, apply the zero-config default gate in the table above directly (`externally-visible`=`batch-confirm`).

After applying, the engine returns the actually applied values (`apply.verified_topics`). Include the diff between the expected value (`final_topics`) and the actually applied value in the final report.

## Error handling (the engine puts this in the JSON)

| Situation | Engine behavior |
| --- | --- |
| `gh` CLI not authenticated | `gh_available:false`. Each candidate's popularity is `null` + a reason in `popularity_errors`. Excluded from the 5x / singular-plural comparison (not treated as 0). The SKILL judgment layer presents "reliable comparison is not possible due to unknown popularity" |
| GitHub Search API rate limit / network error | Only the affected candidate gets `popularity=null` + a reason. Other candidates continue |
| `--repo` not specified and no GitHub remote | Raises `repo_error`. Does not apply |
| 100% constraint-violating candidates | `error: no applicable candidates`. The popularity API is not called |
| `gh repo edit --add-topic` fails (during `--apply`) | `apply.applied:false` + `apply.error`. The SKILL judgment layer presents the failure |

## Out of scope

| Item | Reason for exclusion |
| --- | --- |
| 1. Cross-org generalization | Currently ozzy-labs only. Generalization is considered in a separate issue |
| 2. Persistent caching | Only within a session (the engine queries each topic only once per execution). Optimization spanning multiple sessions is out of scope |
| 3. Other repos' responsibility for the topics application part | `commons/init-templates.sh`'s `--topics` is responsible only for "applying the specified list". This skill supports selection, commons handles application — the responsibilities are separated. The two are connected via a human operator |

## Notes

- Do not read or stage `.env` files
- The hardcoded ozzy-labs conventions (the `claude-code` exception, `*-cli` removal, fixing the `multi-agent` form, retaining both `claude`+`claude-code`) are implemented within the engine and take priority over mechanical judgment (broad+narrow 5x / singular-plural). If adding more exceptions, do so together in `topics.mjs` + this SKILL.md (do not expand conventions on Claude's own judgment)
- Applying topics follows the policy's `externally-visible` gate (default `batch-confirm`). Do not hardcode an individual approval gate in prose
- Since `--apply` skips confirmation as an explicit opt-out of `batch-confirm`, it's recommended to always check the content with `--dry-run` first before using it
