---
name: backlog
description: Collects open issues with the `backlog.mjs` engine, orders them by dependency graph (reusing drive's dependency-notation SSOT) and fixed-vocabulary priority rules, and presents start candidates output in drive argument format (e.g. `#12,#15 -> #18`). Default is presentation only; `--drive[=N]` hands off to drive after confirmation; `--auto` hands off to drive without confirmation, but only for issues labeled `auto-ok` (HATL). Single repo only.
---

# backlog - Prioritize open issues and connect to drive

drive presupposes that "a human hands it the issue number to start on," so the **upstream** of the autonomous loop (selecting what to start on) had not been made into a skill. This skill fills that gap: it collects open issues, orders them by dependency graph and priority, and presents/connects start candidates in drive argument format.

The deterministic logic (issue collection, dependency extraction, priority sorting, `auto-ok` gating, drive-argument formatting, and rendering) is handled by the bundled **`backlog.mjs` engine** ([ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R1, following the precedent of `drive-plan.mjs` / `topics.mjs` / `health-check.mjs` / `policy-read.mjs`). This SKILL.md confines itself to the judgment layer — **when to call the engine, how to present the candidates, and where to confirm with a human (policy gate)**. Claude does not create priority ordering on its own judgment (the ordering is determined by the engine's fixed vocabulary).

**Scope**: single repository only. cross-repo backlog is a future consideration (see [Out of scope](#out-of-scope)).

## Input

```text
backlog
  --repo owner/repo   (resolved from cwd's origin if omitted)
  --label <filter>    (label filter passed to gh issue list)
  --limit N           (collection limit; default 20)
  --drive[=N]         (hand off top N + dependency closure to drive after confirmation; omit N for all candidates)
  --auto              (hand off to drive without confirmation, but only for issues labeled `auto-ok`)
```

The `--dry-run` equivalent (presentation only, no side effects) is the **default behavior**, so no flag is needed.

## Steps

1. Run `backlog.mjs` **in the same directory as this SKILL.md** via Bash (pass the arguments through as-is). In Claude Code this is `~/.claude/skills/backlog/backlog.mjs` (dogfood: `<repo>/.claude/skills/backlog/backlog.mjs`; Codex/Gemini: `~/.agents/skills/backlog/backlog.mjs`):

   ```bash
   node <this skill's directory>/backlog.mjs [--repo owner/repo] [--label <filter>] [--limit N] [--drive[=N] | --auto]
   ```

   By default the engine outputs **formatted text** (a priority-ordered candidate table + blocker list + drive argument format) to stdout. Use `--json` to get structured JSON.

2. **Present the engine's output as-is** (do not reformat, reinterpret, or re-sort it — collection, dependency extraction, and priority rules are all the engine's responsibility).
3. If `repo_error` is set (no GitHub remote), present that fact and prompt for an explicit `--repo owner/repo`. If `fetch_error` is set (gh not authenticated / rate limit / network), relay the engine's classification as-is.
4. Connecting to drive follows the mode branching below and the **policy's `externally-visible` gate**.

## Dependency notation (SSOT is drive)

The grammar for dependency extraction (the `depends on #X` family) and its extraction rules, along with the logic that splits dependencies into waves, are **SSOT'd on the drive side** (`drive-plan.mjs`'s `detectBodyDeps` / `topoWaves`; the canonical source is drive SKILL.md's "Explicit dependency notation" / "Phase 0"). `backlog.mjs` **imports and reuses** them. Neither this SKILL.md nor `backlog.mjs` **restates the rules** (to prevent drift). Refer to drive SKILL.md to check the meaning of the dependency graph.

"blocker" = an issue that other collected issues depend on (a depended-upon target detected by `detectBodyDeps`). The engine reflects this in both priority rule (a) and the wave order of the drive arguments.

## Priority rules (fixed vocabulary, listed in priority order from top)

The engine sorts deterministically using the fixed vocabulary in the table below. Claude **does not reinterpret or override** this ordering.

| Rank | Rule | Criterion |
| --- | --- | --- |
| (a) | **blocker** (depended on by other issues) | Depended-upon targets go first |
| (b) | **milestone due date ascending** | Earliest `milestone.dueOn` first. No due date / no milestone goes last |
| (c) | **labels such as `priority:high`** | Issues with the fixed vocabulary `priority:high` / `priority: high` / `p0` / `p1` (case-insensitive) go first |
| (d) | **updatedAt ascending (oldest first)** | Issues with an older (neglected) last update go first |
| tie-break | **issue number ascending** | If all of the above tie, lower numbers go first (fully deterministic) |

This fixed vocabulary is implemented in `backlog.mjs`. To add or remove vocabulary, revise both `backlog.mjs` and this table together (Claude does not add label vocabulary on its own judgment).

## Output (drive argument format)

The engine returns the selection result as an argument string that drive can interpret directly (`handoff.drive_args`):

- A group of candidates with no dependencies → comma-separated list `#1,#2,#3`
- A clean dependency structure (where each wave's nodes (transitively) depend on all preceding nodes) → expressed as waves using drive's dependency notation `->`: `#12,#15 -> #18` (#18 comes after #12, #15 complete)

Wave splitting reuses drive's `topoWaves`. However, when independent and dependent nodes are mixed and the wave notation would **fabricate false dependency edges** (drive interprets `A,B -> C` as "C depends on both A and B", so an unrelated wave-mate's failure could cause C to be incorrectly skipped), it falls back to a **flat, priority-ordered comma list** instead of using `->`. In this case, no false edges arise because drive's Phase 0 reconstructs the real DAG from the issue body using the same `detectBodyDeps` (`drive-plan.mjs`). Either format can be passed directly to `/drive <drive_args>` (`handoff.faithful` indicates which one was output).

## Connecting to drive (mode branching)

| Mode | Trigger condition | Behavior |
| --- | --- | --- |
| **present** (default) | Neither `--drive` nor `--auto` | Only presents the candidate table + `drive_args`. drive is not launched. Once the user selects via the host's confirmation UI, either output the drive arguments for that subset or launch `/drive` |
| **drive** | `--drive[=N]` | Presents the top N (expanded to include the dependency closure) in the confirmation UI → launches `/drive <drive_args>` after approval |
| **auto** | `--auto` | Goes to drive without individual confirmation. However, targets are limited to issues labeled `auto-ok` (HATL below). Follows the policy gate |

## `--auto`'s HATL gating (requires the `auto-ok` label)

`--auto` "launches drive without confirmation", but **its scope is limited to issues labeled `auto-ok`**. This is HATL (human-at-the-loop): **the human does not give individual approval, but instead sets the boundary condition via the label**.

- Label convention: `auto-ok` is applied **only by a human**. Who applies it and when is fixed by operational practice, and no automatic-application path is created. Applying the label = standing approval that this issue may be passed to drive without confirmation.
- Engine enforcement: under `--auto`, the engine **always excludes** issues without the `auto-ok` label from the handoff set (`handoff.excluded_no_label`). Furthermore, if an `auto-ok` issue **depends on an issue that is not `auto-ok`**, that issue is also excluded (`excluded_unapproved_dep`, cascading). drive never starts work on an unapproved issue.
- **There is no ungated `--auto`**. If there are zero issues with the `auto-ok` label, the handoff set is empty and drive is not launched.

## Policy reference at connection time (`externally-visible` gate)

When backlog launches drive, drive performs **externally-visible, irreversible actions** such as creating a PR and (with `--merge`) merging. Therefore, **the act of launching drive from backlog itself is classified as an externally-visible action**, and rather than hardcoding an individual approval gate in prose, it follows the central autonomy policy (the SSOT for the 3 classes and gate vocabulary, defined by the `policy` skill). Classification and zero-config default:

| This skill's action | Class | Policy reference | Zero-config default gate |
| --- | --- | --- | --- |
| Launching drive (`--drive` / `--auto`) | `externally-visible` | `--action=drive-launch --class=externally-visible` | `batch-confirm` (presents the drive arguments to be launched once, for a single batch confirmation) |

The effective gate is looked up via the sibling `policy` skill's `policy-read.mjs` (in Claude Code's user-scope this is `~/.claude/skills/policy/policy-read.mjs`; dogfood: `<repo>/.claude/skills/policy/policy-read.mjs`; Codex/Gemini: `~/.agents/skills/policy/policy-read.mjs`):

```bash
node <policy skill's directory>/policy-read.mjs --action=drive-launch --class=externally-visible --repo-root="$PWD"
# => .resolved.gate (default batch-confirm)
```

Behavior per gate:

- gate=`batch-confirm` (zero-config default):
  - `--drive`: presents the drive arguments to be launched once for a single batch confirmation → launches `/drive` after approval
  - `--auto`: since the `auto-ok` label functions as standing approval (a boundary condition), the handoff set (= `auto-ok` issues only) is presented once and launched. No individual confirmation is done
- gate=`proceed`: launches without confirmation
- gate=`ask`: confirms drive arguments one at a time (even with `--auto`, it fails safe and is escalated to individual confirmation)

**Does not break even if policy is absent:** `policy-read.mjs` is fail-safe by design — unreadable or invalid values fall to the stricter side (`ask`). In environments where the `policy` skill is not deployed, the zero-config default gate in the table above (`externally-visible`=`batch-confirm`) is applied directly. In either case, `--auto`'s `auto-ok` gating always takes effect.

## Integration with scheduled execution (`schedule` / `/loop`)

Launching `--auto` + `--limit` from `schedule` (cron routine) or `/loop` closes the loop of "attach `auto-ok` and it gets consumed automatically" ([ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R5). Example: `/backlog --auto --limit 3`. Human involvement converges to a single point: "applying the `auto-ok` label".

## Error handling (the engine puts this in the JSON)

| Situation | Engine behavior |
| --- | --- |
| `--repo` not specified and no GitHub remote | Sets `repo_error`. Prompts for an explicit value rather than relying on gh's default repo resolution |
| `gh` not authenticated / rate limit / network | Puts the classification in `fetch_error`. Candidates are empty |
| 0 open issues | `issues: []`. handoff is empty |
| Circular dependency | Falls back to a flat comma list for the drive arguments and records it in `warnings` |

## Out of scope

| Item | Reason for exclusion |
| --- | --- |
| 1. cross-repo backlog | Single repo only for now. Selection across multiple repos will be considered in a separate issue |
| 2. Making priority rules freeform | Ranking uses only fixed vocabulary. The LLM does not create rankings on its own judgment (for reproducibility and reliability) |
| 3. The internals of drive execution | This skill only selects and launches. Implementation, review, and merging are drive's responsibility |

## Notes

- Do not read or stage `.env` files
- The SSOT for dependency notation is drive (`drive-plan.mjs`). backlog reuses it via import and does not restate the rules
- **Requires the `drive` skill at the same level**: `backlog.mjs` imports the sibling `drive/drive-plan.mjs` (to avoid duplicating dependency rules). Since backlog is a skill that hands off to drive, drive is always assumed to coexist with it. Standalone install (backlog only) is not supported
- Priority is determined by the engine using the fixed vocabulary (table above). Claude does not re-sort
- `--auto` is always gated by the `auto-ok` label (there is no ungated, unconfirmed launch)
- Launching drive follows the policy's `externally-visible` gate (default `batch-confirm`)
