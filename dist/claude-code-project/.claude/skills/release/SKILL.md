---
description: Detects release-please PRs (`gh pr list --author app/release-please --state open`), validates them against a fixed checklist (SemVer consistency between version bump and included commit types — feat→minor / fix→patch / `!` or BREAKING CHANGE→major —, CHANGELOG consistency, CI all green), then merges via `gh pr merge --squash` through an approval gate by default (externally visible / effectively irreversible). After merging, it monitors the publish workflow via polling (30s interval, 20-minute cap) and confirms rollout with `npm view <pkg> version` (npm-distributed repos only). `--auto` skips the gate only when all validations pass (stops if any fail). npm publish assumes OIDC Trusted Publishers (no `NPM_TOKEN` used).
argument-hint: "[--repo owner/repo] [--auto]"
disable-model-invocation: true
allowed-tools: Bash, Read, AskUserQuestion
---

# release

Read `.agents/skills/release/SKILL.md` and follow the workflow procedure.

**Important:** Releases are externally visible and effectively irreversible (a published version cannot be withdrawn). Whether to merge is judged only by SKILL.md's **fixed checklist** (SemVer consistency / CHANGELOG / CI green) — do not merge on Claude's own free judgment of "looks good". Approval follows the central autonomy policy's `irreversible` gate.

## Claude Code-specific additions

### Detection, validation, monitoring

Execute via Bash as per SKILL.md's procedure:

```bash
gh pr list --author app/release-please --state open --json number,title,url,headRefName
gh pr checks <N>            # confirm CI all green
gh pr view <N> --json commits   # extract included commit types / breaking (SemVer consistency)
```

- `--repo owner/repo`: if omitted, resolved from `git remote get-url origin`
- `--auto`: skips the approval gate only when all validations pass (stops when validation fails)

### Approval gate (policy's `irreversible` gate = ask) — wired via AskUserQuestion

**Presenting the validation result summary and obtaining approval** is the core of this gate. Never enumerate `Y/n` in text output — always use `AskUserQuestion`.

1. First, check every item in SKILL.md's validation checklist. **If even one item fails, do not show AskUserQuestion — present the failing item(s) and stop** (does not merge. Stops even with `--auto`).
2. If all validations pass, since merge is an irreversible action, follow the policy's gate. Look up the gate with `policy-read.mjs --action=merge --repo-root="$PWD"` (user-scope: `~/.claude/skills/policy/policy-read.mjs`, dogfood: `<repo>/.claude/skills/policy/policy-read.mjs`).
   - gate=`ask` (zero-config default): present a **validation result summary** (version bump / key changes / checklist pass status / CI status) and use `AskUserQuestion` to confirm "whether to merge this release PR". Only execute `gh pr merge <N> --squash` if approved.
   - gate=`batch-confirm`: present the validation result summary all at once and confirm in a batch with `AskUserQuestion` → `gh pr merge <N> --squash` on approval.
   - gate=`proceed`: `gh pr merge <N> --squash` without confirmation.
3. When `--auto` is specified (and all validations pass), **do not interpose AskUserQuestion** (explicit opt-out of the irreversible gate). Directly execute `gh pr merge <N> --squash`.

After merging, proceed to SKILL.md step 4 (polling the publish workflow — 30s interval, 20-minute cap) → confirm rollout with `npm view <pkg> version` (npm-distributed repos only). For repos without a publish workflow, complete at step 6 (tag / Release confirmation).

### Integration with scheduled runs

Launching from `schedule` (cron routine) or `/loop` in the form `/release --auto` closes the loop of "when a release-please PR is raised, validate it and carry it through to distribution". Since AskUserQuestion cannot be interposed in scheduled runs, SKILL.md's fixed checklist (stop if failed) and the policy gate are the only boundary.

### Completion report / next-action suggestion

End once the validation result summary / merged PR / publish workflow result / npm rollout (or tag / Release confirmation) has been displayed. Do not suggest next actions.
