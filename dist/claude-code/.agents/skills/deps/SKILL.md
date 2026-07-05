---
name: deps
description: Enumerates automation PRs (renovate / dependabot etc.) with the `deps.mjs` engine and makes fixed-vocabulary judgments based on semver classification (from PR title / branch / manifest diff; grouped PRs use the maximum bump), CI status, lockfile consistency, and peer / engines changes. patch/minor + CI green + lockfile consistent → auto-merge candidate; major / CI red / pending / peer / engines → 要確認. Author judgment uses the same pattern as health area 15 (`*[bot]` / `app/*`; release-please is excluded — that's `/release`'s responsibility). `--dry-run` judges only; `--auto` executes without confirmation. Merging follows the central autonomy policy's irreversible gate (`--auto` overrides the policy).
---

# deps - Policy-based triage for automation PRs

Automation PRs such as renovate / dependabot were merely piled up by health (area 15) as `要対応`, and handling them was manual every time. This is one of the largest sources of steady-state HITL, and it can be mechanically judged using semver classification + CI status. This skill consolidates that triage: it enumerates automation PRs, classifies them into `auto-merge` (candidate) / `要確認` using fixed vocabulary, and merges according to policy.

The deterministic logic (PR enumeration, author determination, semver classification, CI judgment, lockfile consistency, peer / engines detection, the fixed-vocabulary judgment table, merge execution, and rendering) is handled by the bundled **`deps.mjs` engine** ([ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R1, following the precedent of `health-check.mjs` / `backlog.mjs` / `topics.mjs` / `policy-read.mjs`). This SKILL.md confines itself to the judgment layer — **when to call the engine, how to present the triage, and where to confirm with a human (policy gate)**. Claude does not merge just because it "looks safe" on its own judgment (the judgment is determined by the engine's fixed vocabulary).

**Scope**: automation PR triage for a single repository. Release PRs are out of scope (that's `/release`'s responsibility). cross-repo is a future consideration.

## Input

```text
deps
  --repo owner/repo   (resolved from cwd's origin if omitted)
  --limit N           (enumeration limit; default 50)
  --dry-run           (judge only; no merge, no confirmation)
  --auto              (merge without confirmation; explicit opt-out of the policy's irreversible gate)
```

- If `--dry-run` and `--auto` are both specified, `--dry-run` takes priority (to prevent accidental merges; the same rule as topics; enforced by the engine)
- When neither is specified (`plan` mode): the engine judges and returns a `merge_plan` (the scheduled `gh pr merge --squash`) without merging. Confirms with a human according to the gate

## Steps

1. Run `deps.mjs` **in the same directory as this SKILL.md** via Bash (pass the arguments through as-is). In Claude Code this is `~/.claude/skills/deps/deps.mjs` (dogfood: `<repo>/.claude/skills/deps/deps.mjs`; Codex/Gemini: `~/.agents/skills/deps/deps.mjs`):

   ```bash
   node <this skill's directory>/deps.mjs [--repo owner/repo] [--limit N] [--dry-run | --auto]
   ```

   By default the engine outputs **formatted text** (a triage table + auto-merge candidates / 要確認 + merge plan) to stdout. Use `--json` to get structured JSON.

2. **Present the engine's output as-is** (do not reformat, reinterpret, or re-judge it — enumeration, classification, and the judgment table are all the engine's responsibility). Each PR's reason (bump size / CI status / lockfile / peer / engines) is noted alongside the `要確認` group.
3. If `repo_error` is set (no GitHub remote), present that fact and prompt for an explicit `--repo owner/repo`. If `fetch_error` is set (gh not authenticated / rate limit / network), relay the engine's classification as-is.
4. Merging follows the **policy's `irreversible` gate** below.

## Author determination (same pattern as health area 15; release-please excluded)

Author determination for automation PRs uses **the same pattern as health skill's area 15 (`health-check.mjs`'s `isBotAuthor`)**: logins ending in `*[bot]` / `app/*` (GitHub Apps) / the `is_bot` flag. The match between the two is enforced by a sync assertion in `tests/deps.test.mjs`, preventing drift (changing only one side breaks CI).

**release-please is excluded**: release-please is a bot, but its PRs are `/release`'s responsibility and out of scope for deps triage. The engine always excludes it via `isReleasePlease`.

## Judgment table (fixed vocabulary; the engine judges deterministically)

The engine judges using the fixed vocabulary in the table below. Claude **does not reinterpret or override** this judgment.

| Condition | Judgment |
| --- | --- |
| semver **patch / minor** + CI **green** + lockfile consistent + no peer + no engines | **`auto-merge`** (candidate) |
| semver **major** | `要確認` |
| CI **red** / **pending** / **no checks** / status unobtainable | `要確認` |
| semver **unclassifiable (unknown)** | `要確認` (conservative side) |
| **lockfile drift** (manifest changed but lockfile not updated) | `要確認` |
| **peer dependency** change / **engines** change | `要確認` |

How the judgment inputs are obtained:

- **semver classification**: determined from the PR title / branch name / the `from→to` version pair in the manifest diff. **Grouped PRs are judged by the maximum bump they contain** (if even one major is included, it's major). If unclassifiable, conservatively `unknown` → `要確認`
- **CI**: green only when all checks from `gh pr checks <N>` are green. fail / cancel → red; running / queued → pending. If there are no checks at all, `no-checks` (all of these are `要確認`)
- **lockfile consistency**: if the manifest (`package.json` / `pyproject.toml` / `go.mod` etc.) is changed but the corresponding lockfile is not updated, that's drift (`要確認`). PRs that change only the lockfile (lockfile-maintenance / transitive) or that touch neither manifest nor lockfile (e.g. a GitHub Actions version bump) are treated as consistent

This fixed vocabulary is implemented in `deps.mjs`. To add or remove vocabulary or judgment conditions, revise both `deps.mjs` and this table together (Claude does not add conditions on its own judgment).

## Merging (follows the policy's `irreversible` gate)

`gh pr merge --squash` is an **irreversible action**. Rather than hardcoding an individual approval gate in prose, it follows the central autonomy policy (the SSOT for the 3 classes and gate vocabulary, defined by the `policy` skill). Classification and zero-config default:

| This skill's action | Class | Policy reference | Zero-config default gate |
| --- | --- | --- | --- |
| PR merge (`gh pr merge --squash`) | `irreversible` | `--action=merge` | `ask` (confirms auto-merge candidates one at a time) |

The effective gate is looked up via the sibling `policy` skill's `policy-read.mjs` (user-scope: `~/.claude/skills/policy/policy-read.mjs`; dogfood: `<repo>/.claude/skills/policy/policy-read.mjs`; Codex/Gemini: `~/.agents/skills/policy/policy-read.mjs`):

```bash
node <policy skill's directory>/policy-read.mjs --action=merge --repo-root="$PWD"
# => .resolved.gate (default ask)
```

Flags are kept consistent with policy:

- When `--dry-run` is specified: the engine outputs judgments only, with no merge and no confirmation (it does not call `gh pr merge`)
- When `--auto` is specified: an **explicit opt-out of the irreversible gate**. The engine runs `gh pr merge <N> --squash` serially against each auto-merge candidate without confirmation (required for unattended execution via routine / `/loop` / `schedule`)
- When neither is specified (`plan` mode): the engine does not merge and returns a `merge_plan` (the commands scheduled for execution). Confirms with a human according to the gate:
  - gate=`ask` (zero-config default): confirms auto-merge candidates **one at a time**. Only approved PRs get `gh pr merge <N> --squash` executed
  - gate=`batch-confirm`: presents auto-merge candidates together once for a single batch confirmation; if approved, re-runs with `--auto` appended to the same arguments
  - gate=`proceed`: re-runs with `--auto` without confirmation

**Does not break even if policy is absent:** `policy-read.mjs` is fail-safe by design — unreadable or invalid values fall to the stricter side (`ask`). In environments where the `policy` skill is not deployed, the zero-config default gate in the table above (`irreversible`=`ask`) is applied directly.

## Error handling (the engine puts this in the JSON)

| Situation | Engine behavior |
| --- | --- |
| `--repo` not specified and no GitHub remote | Sets `repo_error`. No merge is performed |
| `gh` not authenticated / rate limit / network (PR enumeration) | Puts the classification in `fetch_error`. Candidates are empty |
| Failure to fetch a PR's individual CI status / diff | Only that PR is downgraded to `要確認` (`ci: error` / `diff_error`). Other PRs continue |
| Merge failure (branch protection etc., under `--auto`) | Only that PR is downgraded to `要確認` and continues (recorded in `merge_results`) |
| 0 automation PRs | `candidates: []`. merge plan is empty |

## Integration with `/loop` / `schedule`

Launching `--auto` from `schedule` (cron routine) or `/loop` closes the loop of "consume automation PRs every morning" ([ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R5). Example: `/deps --auto`. Since unattended execution cannot be interactive, the judgment table (conservative side = `要確認` when in doubt) and the policy gate become the sole boundary.

## Out of scope

| Item | Reason for exclusion |
| --- | --- |
| 1. Handling release PRs | `/release`'s responsibility. release-please authors are always excluded |
| 2. Making judgment conditions freeform | Judgment uses only fixed vocabulary. The LLM does not merge just because it "looks safe" on its own judgment (for reproducibility and reliability) |
| 3. cross-repo triage | Single repo only for now. Crossing multiple repos will be considered in a separate issue |
| 4. `--delete-branch` / `--auto` (GitHub auto-merge) | This skill only does immediate squash merges. It does not delete branches or use GitHub auto-merge |

## Notes

- Do not read or stage `.env` files
- Author determination uses the same pattern as health area 15 (a sync assertion in `tests/deps.test.mjs` prevents drift). release-please is always excluded
- Judgment is determined by the engine using the fixed vocabulary (table above). Claude does not re-judge (`要確認` when in doubt)
- Merging follows the policy's `irreversible` gate (default `ask`). Since `--auto` is an explicit opt-out that skips confirmation, it's recommended to first check the content with `--dry-run` before using it
- Do not add new runtime dependencies (only Node stdlib + `gh` / `git`)
