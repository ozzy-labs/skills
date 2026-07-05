---
name: skill-observability
description: Defines the skill observability event contract (event.schema.json) and emit substrate (obs-emit.mjs). The SSOT for the measurement layer of the skill improvement loop. Referenced by other skills and hooks.
user-invocable: false
---

# skill-observability - Measurement event contract and emit substrate

A referenced companion that defines the contract and tools underpinning the **measurement layer** of the skill improvement loop (install → use → reflect). Provides the **SSOT for the shape of events (schema) and the convention for writing them (emit)**, along with the **trace-derivation hook (obs-derive.mjs)** that derives invocations after the fact from the transcript. Aggregation (`/skill-metrics`) and reflection are built separately on top of this contract.

## Principles

- **Trace derivation as the main axis**: Measurement is derived after the fact, as much as possible, from `gh`/`git` ground truth and transcript traces (avoiding self-report bias). Inline emit from within a skill prompt is secondary, limited to semantic signals that don't show up in traces (fallback, HITL rejection, loop cap reached, etc.).
- **fail-open**: A failed emit must not stop the skill being measured. `obs-emit.mjs` never throws — whether absent, failing, or hitting a validation error — it prints a warning to stderr and exits 0.
- **privacy (strictest mode)**: Events are metadata only. `event.schema.json`'s `additionalProperties: false` **mechanically rejects** unknown fields such as payload / diff / token / path. Repo identifiers are never stored raw — only a hash (`repo_hash`). Sending (reflection) is always explicit opt-in / HITL (this skill has no send path of its own).
- **Count-based reasoning**: Because a single author's low-frequency data volume doesn't reach statistical significance, this contract does not force rates or confidence intervals. The aggregation side is built primarily around counts + notable events.

## Event log

```text
~/.agents/observability/events.jsonl   # append-only, 1 line per event, self-contained without OTel dependency
```

HOME-anchored (outside the skills dir). Survives a dogfood mirror rebuild. Readable by any consumer / hook.

## Event contract (event.schema.json is the SSOT)

`event.schema.json` (a sibling of this skill) is the sole SSOT. Both `obs-emit.mjs` and the tests validate by **reading this file**, so doc and code never drift apart. Field names lean toward the **shape** of the OpenTelemetry GenAI semantic conventions (`skill`≈`gen_ai.agent.name` / `operation`≈`gen_ai.operation.name`). Since the conventions are experimental, this skill does not couple tightly to them.

Required fields: `schema_version`(=1) / `ts`(ISO 8601) / `adapter` / `session_id` / `skill` / `event`.

Types of `event`:

| event | Purpose | Additional required field |
| --- | --- | --- |
| `start` | Skill invocation | — |
| `phase` | Phase transition (implement / ship / review, etc.) | — |
| `outcome` | End state | `status` ∈ {completed, aborted, fallback} |
| `signal` | Semantic counter (a transition that doesn't show up in traces) | `name` (fixed vocabulary) |
| `heartbeat` | Records that "observation ran" (prevents misreading absent data as success) | — |

Fixed vocabulary (initial) for `signal.name`: `review.loop_iter` / `review.deep_to_quick_fallback` / `usage_guard.fail_open` / `hitl.rejected` / `loop.hit_cap`.

privacy: `repo_hash` is 12-digit hex (a sha256 prefix) only. The contract makes it impossible to write raw repo names, cwd, or raw PR numbers (`additionalProperties: false`).

## Emit substrate (obs-emit.mjs)

`obs-emit.mjs` (sibling, a CLI that runs on all adapters) is the build→validate→append write primitive. Both the trace-derivation hook and inline emit ultimately go through this to append a single event.

```bash
# Examples
node obs-emit.mjs --skill=drive  --event=outcome --status=completed
node obs-emit.mjs --skill=review --event=signal  --name=review.loop_iter --value=2
node obs-emit.mjs --skill=drive  --event=heartbeat
node obs-emit.mjs --skill=drive  --event=outcome --status=merged --repo="$(git rev-parse --show-toplevel)"
```

Arguments: `--skill` / `--event` (effectively required), `--status` / `--name` / `--value` / `--phase` / `--operation` / `--reason` / `--run` (optional), `--repo` (hashed and stored in `repo_hash`), `--adapter` / `--session` (resolved from env by default).

Any event that fails validation, and any other failure, is **not appended — it warns and exits 0** (fail-open). Does not break callers chained with `&&`.

## Trace-derivation hook (obs-derive.mjs)

`obs-derive.mjs` (sibling, a SessionEnd hook) is the **primary capture path**. After a session ends, it reads the transcript, derives after the fact **which skill fired**, and records it via the obs-emit substrate. Because it reconstructs from traces rather than asking the model for a mid-run self-report, it avoids **self-report bias** (the worst-case runs that abort being exactly the ones that drop the emit).

The reliable core it derives:

- One `heartbeat` per session (a record that "observation ran." Makes an empty window distinguishable between "zero invocations" and "the hook didn't fire").
- One `start` per skill invocation found in the transcript. 2 channels:
  - A model-invoked `Skill` tool_use → `operation: invoke_agent`
  - A user-entered `/slash-command` → `operation: slash_command` (**only for skills that actually exist**. Built-in commands with no sibling skill dir, such as `/clear` `/compact`, are excluded to prevent data contamination)

The skill's arguments (which may be sensitive) are **not recorded** (only the skill name and channel).

**Deferred (not derived by this hook)**: the merge/abort **outcome**. The merge state at session end is not yet settled — it requires session→PR linkage plus deferred re-evaluation, and abort inference ("ended without a PR") is hard to distinguish from a human interruption or an idempotent resume, and is noisy. To keep things reliable and low-noise, this is split off into a separate increment.

### Enabling the SessionEnd hook (manual opt-in)

This repo does not distribute settings/hooks (same policy as the usage-guard hook). Add a SessionEnd entry to `~/.claude/settings.json` (or `settings.local.json`). `command` must be the **absolute path** to `obs-derive.mjs` (differs between user-scope `~/.claude/skills/skill-observability/...` and dogfood `<repo>/.claude/skills/skill-observability/...` — fill in your own path):

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "node /home/<you>/.claude/skills/skill-observability/obs-derive.mjs" }
        ]
      }
    ]
  }
}
```

Receives the SessionEnd JSON on stdin (`session_id` / `transcript_path` / `cwd` / `reason`), always exits 0, and stays lightweight (lines are pre-filtered by substring before `JSON.parse`).

## Scope of application

This skill provides the **contract + emit substrate + trace-derivation hook (invocation capture)**. Layers built on top of this contract (capture → aggregate → reflect → consume):

- **`/skill-metrics`** (aggregation, shipped): read-only aggregation of events.jsonl into counts + notable events.
- **Reflection channel** (reflection, shipped): the metrics-primed version of `lessons-triage`. Privacy-cleansed rollups are reflected into a backlog-pointer issue via HITL (sending is opt-in).
- **`backlog`** (consumption, shipped): passes that issue to `drive` as a priority index.
- **outcome derivation** (separate PR, pending): folds merge/abort state into the rollup using `gh`/`git` merge ground truth + session→PR linkage (the next increment of the trace-derivation hook).

## Notes

- Does not read `.env` files.
- Events must not include verbatim logs, secrets, or raw private repo names/paths/PR values (the schema mechanically rejects these).
