---
name: release
description: Detects release-please PRs (`gh pr list --author app/release-please --state open`), validates them against a fixed checklist (SemVer consistency between version bump and included commit types — feat→minor / fix→patch / `!` or BREAKING CHANGE→major —, CHANGELOG consistency, CI all green), then merges via `gh pr merge --squash` through an approval gate by default (externally visible / effectively irreversible). After merging, it monitors the publish workflow via polling (30s interval, 20-minute cap) and confirms rollout with `npm view <pkg> version` (npm-distributed repos only). `--auto` skips the gate only when all validations pass (stops if any fail). npm publish assumes OIDC Trusted Publishers (no `NPM_TOKEN` used).
---

# release - Validate release-please PR → gated merge → publish monitoring

The stage from merged onward to distribution (handling release-please PRs, monitoring npm OIDC publish) had not been turned into a skill, so it reverted to manual work every time at release. There was also no path to close health's draft release `要対応` (area 14). This skill unifies that whole sequence: it detects release-please PRs, validates them against a fixed checklist, merges them through an **approval gate by default**, and monitors the publish workflow through to confirming the npm rollout.

Releases are **externally visible and effectively irreversible** (a published version cannot be withdrawn), so the judgment is confined to a fixed checklist (deterministic) — Claude does not merge on its own just because it "looks good". The approval gate follows the central autonomy policy (the `policy` skill's `irreversible` gate).

**Scope**: Validating, merging, and monitoring publish for release-please PRs in a single repository. automation dependency PRs (renovate / dependabot) are the responsibility of `/deps`; PRs other than release-please are out of scope. cross-repo is a future consideration.

## Input

```text
release
  --repo owner/repo   (resolved from cwd's origin if omitted)
  --auto              (skips the approval gate only when all validations pass. Even with --auto, stops when validation fails)
```

- `--auto` is an opt-in for routine / `/loop` / `schedule` integration. Since unattended runs can't be interactive, the **fixed checklist** (below) and the policy gate are the only boundary.
- Even with `--auto`, **if even one validation fails, it will not merge** (see "Approval gate" below). Since releases are irreversible, `--auto` only "skips human confirmation" — it does not "skip validation".

## Procedure

### 1. Detection

```bash
gh pr list --author app/release-please --state open --json number,title,url,headRefName
```

- **If 0 results**: present "No releases pending" and also **note whether any draft release exists** (equivalent to visualizing health area 14):

  ```bash
  gh release list --limit 10   # note any entries where the draft column is true
  ```

  If a draft release remains, report "There is an unpublished draft release" (if there's a draft but no release-please PR, this may indicate a manual release or a workflow failure).

- **If 1 or more**: proceed to the validation in step 2 for each PR. Normally there is one release-please PR per repo. If there are multiple, handle them one at a time.
- **Fallback**: There are also configurations where, with 0 results for `app/release-please` as author, `github-actions[bot]` posts on behalf of the release-please-action. In that case, check whether it's a release-please PR by the title (e.g. `chore(main): release <version>`) and the `changelog-path` diff.

### 2. Validation checklist (fixed, deterministic)

Check **every item** in the table below. If even one fails, treat it as "validation failed", do not proceed to merge, and present the failing item(s) and stop (stops even with `--auto`).

| # | Item | Pass condition |
| --- | --- | --- |
| 1 | **SemVer consistency** | The PR's version bump matches the expected bump derived from the included commit types (see "SemVer consistency rules" below) |
| 2 | **CHANGELOG consistency** | The CHANGELOG entry reflects the included commits without excess or omission (no added commits are missing / no nonexistent entries) |
| 3 | **CI all green** | All checks on the PR are green (`gh pr checks <N>`. fail / cancel → red, running / queued → pending. Either is treated as a failure) |

How to obtain the material:

- **Included commits**: `gh pr view <N> --json commits`, or `git log origin/main..<headRefName>`. Extract each commit's Conventional Commits type (`feat` / `fix` / `perf` / …) and any `!` / `BREAKING CHANGE` in the body.
- **Version bump**: Determine from the PR title (`chore(main): release <version>`), the from→to in `.release-please-manifest.json`, and the version diff in `package.json`.
- **CHANGELOG**: Cross-check the PR's `CHANGELOG.md` diff against the included commits (of types that trigger a release) for excess or omission.
- **CI**: `gh pr checks <N>`. If even one is not green, it's a failure.

#### SemVer consistency rules (deterministic rules that can be turned into fixtures)

Determine the **expected bump** from the set of included commit types, in the following priority order (major > minor > patch > none):

| Condition of included commits | Expected bump |
| --- | --- |
| Any has `!` (e.g. `feat!:`) or `BREAKING CHANGE` in the body | **major** |
| (no breaking) any has `feat` | **minor** |
| (no breaking / feat) any has `fix` or `perf` | **patch** |
| No type that triggers a release exists at all (only `docs` / `chore` / `refactor` / `test` / `style` / `ci` / `build`) | **none** (no release PR is raised at all) |

This rule is deterministic, and `tests/release.test.mjs` reimplements and pins it with fixtures (commit type list → expected bump, including `!` / BREAKING CHANGE). If the rules are added to or reduced, revise this table and the test together (do not add conditions on Claude's own judgment).

> **Note on pre-1.0 (specific to this repo):** For 0.x packages where `release-please-config.json` sets `bump-minor-pre-major: true` / `bump-patch-for-minor-pre-major: true`, breaking→minor / feat→patch is **downgraded** while at `0.y.z` (the SemVer convention of treating breaking changes as minor before 1.0.0). When validating, check whether the target package's current major is 0, and if so, cross-check against the downgraded expected bump. The standard rules in the table above apply to major ≥ 1.

### 3. Approval gate (follows the central autonomy policy)

`gh pr merge --squash` is an **irreversible action**. Rather than hardcoding an individual gate in prose, it follows the central autonomy policy (the SSOT of the 3 classes / gate vocabulary defined by the `policy` skill). Classification and zero-config default:

| This skill's action | Class | policy reference | Zero-config default gate |
| --- | --- | --- | --- |
| release PR merge (`gh pr merge --squash`) | `irreversible` | `--action=merge` | `ask` (maintain the approval gate) |

The effective gate is looked up via the sibling `policy` skill's `policy-read.mjs` (user-scope: `~/.claude/skills/policy/policy-read.mjs`, dogfood: `<repo>/.claude/skills/policy/policy-read.mjs`, Codex/Gemini: `.agents/skills/policy/policy-read.mjs`):

```bash
node <policy skill directory>/policy-read.mjs --action=merge --repo-root="$PWD"
# => .resolved.gate (default ask)
```

The behavior is determined by the combination of the validation result and `--auto`:

- **Validation failed (even one item)**: does not merge. Presents the failing item(s) and stops. Same with `--auto` (since releases are irreversible, validation cannot be skipped).
- **All validations pass + `--auto` not specified** (default): presents a validation result summary (version / key changes / checklist pass status) and follows the policy gate:
  - gate=`ask` (zero-config default): requests approval, and only executes `gh pr merge <N> --squash` if approved.
  - gate=`batch-confirm`: presents the summary once for a single batch confirmation → merge on approval.
  - gate=`proceed`: merges without confirmation.
- **All validations pass + `--auto` specified**: **skips the approval gate** and executes `gh pr merge <N> --squash` directly (explicit opt-out of the irreversible gate).

**Does not break even without policy present:** `policy-read.mjs` is fail-safe by design — if it can't be read, or the value is invalid, it defaults to the stricter side (`ask`). In environments where the `policy` skill is not installed, apply the zero-config default gate in the table above directly (`irreversible`=`ask`).

### 4. Monitoring the publish workflow

After merging, identify and poll the corresponding release workflow run (**npm-distributed repos only**. For repos without a publish workflow, go to step 6):

```bash
# Identify the release workflow run triggered after the merge (e.g. name=Release)
gh run list --workflow release.yaml --branch main --limit 5 --json databaseId,status,conclusion,headSha,createdAt

# Poll the identified run until it's green (success)
gh run view <run-id> --json status,conclusion,jobs
```

- **30-second polling interval, 20-minute cap** (max 40 iterations). If the cap is reached, present it as a "workflow monitoring timeout" with the run URL and prompt for a subsequent manual check.
- Once the workflow becomes `success`, confirm the rollout to npm with `npm view <pkg> version` (`<pkg>` is the `name` in `package.json`, e.g. `npm view @ozzylabs/skills version`). If it matches the PR's version, **distribution is complete**.
- If the workflow becomes `failure`, proceed to the failure guidance in step 5.

Publishing for this repo is via OIDC Trusted Publishers (the `publish` job in `release.yaml` is gated by `needs: release-please` + `if: release_created`, and issued via `npm publish --provenance --access public`). See the "Prerequisites" section for details.

### 5. Guidance on failure

If the publish workflow is `failure`, summarize the failure log and give guidance on the cause (automatic fixing is out of scope):

```bash
gh run view <run-id> --log-failed   # fetch and summarize only the log of the failed step
```

Common causes (in the OIDC Trusted Publishers context):

| Symptom | Cause | Guidance |
| --- | --- | --- |
| `403 Forbidden — you don't have permission` | **Trusted Publisher not registered** / mismatch of workflow filename / repo name | Check Settings → Publishing on npmjs.com |
| `OIDC token not available` | **`permissions: id-token: write` missing** on the workflow / job | Add the permissions |
| provenance is not attached | publish from a private repo / CircleCI (provenance unsupported) | Check for a GitHub-hosted runner + public repo |
| npm CLI is outdated | npm CLI below v11.5.1 / Node below 22.14 | Check `npm install -g npm@latest` |

Automatic fixing is out of scope for this skill. If a CI rerun or fix is needed, note that it can be connected to `/ci-fix` etc.

### 6. Branch for repos without a publish workflow

For repos that don't have a distributed artifact (no npm publish workflow), completion is defined as **merge + confirming the tag / GitHub Release**:

```bash
gh release list --limit 5     # check the Release / tag created by release-please
```

If the tag and GitHub Release were created by the release-please merge, it's complete. Do not perform the npm rollout confirmation (the `npm view` in step 4).

## Prerequisites: npm publish uses OIDC Trusted Publishers

- npm publish uses **OIDC Trusted Publishers** (per the policy in knowledge `standards/npm-trusted-publishers`). It **does not use** a long-lived **`NPM_TOKEN`** (due to leak risk and rotation burden).
- The publish workflow has `permissions: id-token: write` and automatically attaches attestation via `--provenance` (verifiable with `npm view <pkg> dist.attestations`).
- Note that **publishing from a private repo does not attach provenance even for a public package** (to keep the source link private).

## Error handling

| Situation | Behavior |
| --- | --- |
| `--repo` not specified and no GitHub remote | Present an error and prompt to specify `--repo owner/repo` explicitly. Does not merge |
| `gh` not authenticated / rate limit / network | Present an error and abort (does not proceed to merge or publish monitoring) |
| 0 release-please PRs | End with "No releases pending" + noting whether a draft release exists |
| Validation failed (any of SemVer / CHANGELOG / CI) | Present the failing item(s) and stop (does not merge). Stops even with `--auto` |
| Merge failure (branch protection, etc.) | Present the failure. Prompt for manual merge |
| Publish workflow timeout (20 min) | Present the run URL and prompt for manual confirmation |
| Publish workflow failure | Summary of `gh run view --log-failed` + guidance on common causes |

## Out of scope

| Item | Reason for exclusion |
| --- | --- |
| 1. automation dependency PRs (renovate / dependabot) | Responsibility of `/deps`. This skill handles only release-please PRs |
| 2. Loosening the judgment criteria | Validation is only the fixed checklist. Does not decide mergeability by the LLM's free judgment (for reproducibility and the irreversibility of releases) |
| 3. Automatic fixing of publish failures | Only up through log summary + cause guidance. Fixing is connected to `/ci-fix` etc. |
| 4. cross-repo release | Currently single-repo only |
| 5. Generation of the release-please PR itself | Responsibility of release-please-action (CI). This skill only validates, merges, and monitors the generated PR |

## Notes

- Do not read or stage `.env` files.
- Releases are externally visible and effectively irreversible. Maintain the approval gate by default (`irreversible`=`ask`). `--auto` is an explicit opt-out, but **even with `--auto`, it stops when validation fails**.
- Validation is judged only by the fixed checklist (SemVer consistency / CHANGELOG / CI green). Claude does not re-judge (when in doubt, stop).
- npm publish uses OIDC Trusted Publishers (no `NPM_TOKEN` used).
- Do not add new runtime dependencies (Node stdlib + `gh` / `git` / `npm` only).
