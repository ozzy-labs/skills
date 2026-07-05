---
name: health
description: Checks, in one shot via the `health-check.mjs` engine, for state unintentionally left behind during repository work (working tree, stash, branch, worktree, PR, issue, actions, etc.) and skill-catalog consistency, presenting a 16-area status table and fixed-vocabulary recommended actions. With `--deep`, does additional read-only investigation of `要確認` items; with `--fix`, executes safe-vocabulary actions (prune / delete / fetch, and `drop` when promoted by `--deep`) following the central policy's gate (reversible-local=proceed / irreversible=ask). Read-only by default.
---

# health - Checking repository state and presenting recommended actions

Checks, across 16 areas, for state unintentionally left behind during repository work (an interrupted git op, an unpushed commit, a stale branch, an open PR/issue, failed CI, etc.) and skill-catalog consistency, attaching a **fixed-vocabulary recommended action** to each item and reporting it.

Determinism (checking the 16 areas, fixed-vocabulary determination, section sorting, rendering the status table/non-clean sections, and running `--fix`) is handled by the bundled **`health-check.mjs` engine** ([ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R1, following the precedent of `usage-check.mjs` / `skill-metrics.mjs` / `policy-read.mjs`). This SKILL.md is confined to the judgment layer — **when to call the engine, how to present the results, and where to confirm with a human**.

## Principles

- **Read-only by default:** the no-argument / `--deep`-only paths never mutate anything (inspection and presentation only). Execution is limited to the safe vocabulary, and only when `--fix` is explicit.
- **fail-open:** even if one check fails (gh unauthenticated / absent, a missing command, network issues, etc.), the other checks continue. The engine records the failed area in the JSON's per-check `error`, and git-based checks always continue.
- **Fixed vocabulary only:** recommended actions are limited to the 8 vocabulary items described below. Since the engine makes the determination, no free-form wording is generated.
- **Separation of responsibilities between health and skill-metrics:** `health` covers repo state, `skill-metrics` covers skill behavior.

## Input

- No arguments → Phase 1 only (routine-compatible, deterministic, read-only)
- `--deep` → after Phase 1 completes, additionally investigates `要確認` items with read-only commands, upgrading the label wherever a machine determination is possible
- `--fix` → resolves the gate for each safe action via the central autonomy policy (`policy-read.mjs`). `reversible-local` (prune / delete / fetch) = `proceed` is executed on the spot, leaving an audit trail. `irreversible` (a stash drop promoted by `--deep`) = `ask` is left as a listed-but-unexecuted item pending individual confirmation. See "`--fix` safe boundary" for details
- `--yes` → effective only when combined with `--fix`. As an **explicit opt-out that overrides the policy**, executes all safe actions without confirmation (required for unattended execution via routine / `/loop` / `schedule`)
- `--json` → outputs structured JSON instead of a human-readable report (for program integration / debugging)

`--deep` / `--fix` take effect only when explicit.

## Procedure

1. Run `health-check.mjs`, **in the same directory as this SKILL.md**, via Bash (passing the arguments as-is). On Claude Code it's `~/.claude/skills/health/health-check.mjs` (for dogfooding, `<repo>/.claude/skills/health/health-check.mjs`):

   ```bash
   node <この skill のディレクトリ>/health-check.mjs [--deep] [--fix] [--yes]
   ```

2. By default, the engine outputs a **status table + non-clean sections** as pre-formatted text to stdout. **Present that output as-is** (don't reformat or reinterpret it — rendering is the engine's responsibility).
3. For `--fix` (without `--yes`), the engine resolves each action's gate via the policy; `proceed` (reversible-local) actions are executed on the spot, with the result (`✔ done` / `✖ failed`) noted alongside. `ask` (irreversible stash drop) actions are listed as "actions requiring confirmation" and **not executed**. Present this `ask` list to the human and obtain individual confirmation (the confirmation-gate wiring is host-dependent — see `SKILL.claude-code.md` for Claude Code). Once approved, re-run with `--fix --yes` to execute the rest.
4. If a Triage-related section is `error` due to gh being unauthenticated / absent, etc., present that as-is (the git-based results remain valid).

## Recommended-action vocabulary (fixed, human-readable contract)

The engine outputs nothing other than these 8 vocabulary items.

| Label | Meaning / recommended command | Applicable condition (representative example) |
|---|---|---|
| `delete` | `git branch -d <name>` (safe; force `-D` is not used) | a local branch tied to a merged PR with no additional commits |
| `drop` | `git stash drop` | a stash with no tied branch, or one that `--deep` determined can't cleanly apply to HEAD |
| `prune` | `git remote prune origin` / `git worktree remove` / `git branch -D` for an orphan synthetic branch | a gone tracking ref / an orphaned worktree / a drive synthetic branch whose parent worktree has disappeared |
| `push` | `git push` | ahead and unpushed, no PR created |
| `fetch` | `git fetch --tags` | a tag that exists on remote but hasn't been fetched locally |
| `要確認` | not machine-determinable, needs human eyes | an old stash / an old branch / a conflict marker / a failed CI run |
| `要対応` | needs a human decision | an open PR / open issue / review request / draft release / automation PR |
| `abort or continue` | resolving a broken state | MERGE_HEAD / REBASE_HEAD / CHERRY_PICK_HEAD / BISECT_LOG |

The threshold for "old" is 14 days. The section order (Broken state → Local artifacts → Triage(mine) → Triage(automation) → Catalog) represents an implicit priority.

## `--fix` safe boundary (human-readable contract)

What `--fix` executes automatically is limited to **deterministic, reversible, low-risk** safe vocabulary (the HITL Audit Trail with Lazy Review pattern).

| Label | `--fix` target | Rationale |
|---|---|---|
| `prune` | ○ | remote prune / orphan worktree remove / `-D` on an orphan synthetic branch are deterministic |
| `delete` | ○ | `git branch -d` (safe) only. git itself refuses an unmerged branch |
| `fetch` | ○ | harmless, being read-direction |
| `drop` | △ | **only a stash promoted to `drop` by `--deep` Phase 2 (can't cleanly apply to HEAD)**. Phase 1's threshold-based `drop` (the original branch has disappeared) is out of scope |
| `push` / `要確認` / `要対応` / `abort or continue` | × | an outward-facing side effect or human-judgment territory. The engine never targets these for execution |

### The confirmation gate follows the central policy (action classification and policy reference)

The confirmation gate follows not skill-specific prose, but the central autonomy policy (the SSOT for the 3 action classes and gate vocabulary defined by the `policy` skill) ([ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R3, [#181](https://github.com/ozzy-labs/skills/issues/181)-PR3; replacing #173's single confirmation). Each safe label is classified into the following classes, and the engine resolves the effective gate by reading `policy-read.mjs` from within `health-check.mjs`:

| `--fix` label | Class | policy reference | zero-config default gate | Behavior |
|---|---|---|---|---|
| `prune` / `delete` / `fetch` | `reversible-local` | `--action=worktree-prune` / `--action=branch-delete` / `--class=reversible-local` | `proceed` | executed on the spot with the result noted (audit trail, no confirmation) |
| `drop` (stash drop promoted by `--deep`) | `irreversible` | `--action=stash-drop` | `ask` | executed only after individual confirmation (never executed without confirmation) |

The gate vocabulary has only 3 values: `proceed` (execute without confirmation + audit trail) / `batch-confirm` (a single bulk confirmation) / `ask` (explicit approval per action).

- **`--yes` is an explicit opt-out:** it **overrides** the policy and executes all safe actions without confirmation (unattended execution via routine / `/loop` / `schedule`). It executes even when the gate is `ask`.
- **Doesn't break even without a policy present (fail-safe):** `policy-read.mjs` is fail-safe by design — unreadable or invalid values always fall to the stricter side (`ask`). In an environment where the `policy` skill itself isn't installed and `policy-read.mjs` can't be imported, `health-check.mjs` falls back to `ask` (equivalent to the old single confirmation, the safe side) for all actions. **It never falls in the direction of loosening autonomy.**
- **Execution is sequential, continuing per action:** since it changes git state, it's not parallelized. A failure in an individual action doesn't stop the run — it continues, with the result noted on each line (audit trail).
- **The default is unchanged:** the no-argument / `--deep`-only paths are completely read-only. If the policy has tightened `reversible-local` to `ask`, `--fix` (without `--yes`) auto-executes nothing at all.

## Checked items (16 areas)

The details of the determination logic live in the engine (`health-check.mjs`). The areas and section order are fixed as follows:

1. Interrupted git ops (MERGE/REBASE/CHERRY_PICK/BISECT) — `abort or continue`
2. Conflict markers (`git diff --check`) — `要確認`
3. Working tree (`git status -s`) — informational only
4. Stash (elapsed days / whether the original branch exists / apply feasibility via `--deep`) — `drop` / `要確認`
5. Local branches (synthetic / merged PR / upstream / ahead) — `prune` / `delete` / `push` / `要確認`
6. Remote tracking (gone ref) — `prune`
7. Worktrees (drive orphan / locked / merged) — `prune`
8. Submodules (`+` / `-` / `U`) — `要確認`
9. Tags (local-only / remote-only) — `push` / `fetch`
10. My open PRs (draft / otherwise) — `要確認` / `要対応`
11. Issues assigned to me — `要対応`
12. Review requests on me — `要対応`
13. Recent failed actions (same-error grouping via `--deep`) — `要確認` / `要対応`
14. Draft releases — `要対応`
15. Automation PRs (bot author) — `要対応`
16. Perspective MD frontmatter (the review skill's perspective MD schema / SSOT⇄distribution-target drift) — `要確認`

## Explicitly excluded items

| Item | Reason for exclusion |
|---|---|
| lockfile drift | a correctness issue. An area caught by verify / CI. Language-specific |
| gitignored-but-tracked file | too rare, a source of noise |
| GitHub Actions caches / artifacts | a storage-management area, a distinct concept from leftover state |

## Notes

- Never read `.env` files.
- The default and `--deep`-only paths are read-only. Execution is limited to `--fix`'s safe vocabulary (`push` / `要確認` / `要対応` / `abort or continue` are never executed).
- No severity label (blocker / warning / info) is attached. The section order represents an implicit priority.
- The recommended-action vocabulary is fixed. Adding a new one requires revising both the engine and this SKILL.md together.
- When using `--fix` via a routine path (`/loop` / `schedule`), interaction isn't possible, so `--yes` is required.
