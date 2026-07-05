---
argument-hint: "[--repo owner/repo] [--limit N] [--dry-run | --auto]"
disable-model-invocation: true
allowed-tools: Bash, Read, AskUserQuestion
---

# deps

Read `.agents/skills/deps/SKILL.md` and follow its workflow steps.

**Important:** All determinism (automation PR enumeration / author determination / semver classification / CI judgment / lockfile consistency / peer & engines detection / the fixed-vocabulary judgment table / merge execution) is handled by the bundled **`deps.mjs` engine**. The SKILL confines itself to the judgment layer: "call the engine, present its output as-is, and confirm merges via the policy gate." Claude does not merge based on its own judgment that it "looks safe" (the judgment is determined by the engine's fixed vocabulary).

## Claude Code-specific additions

### Running the engine

```bash
node ~/.claude/skills/deps/deps.mjs [--repo owner/repo] [--limit N] [--dry-run | --auto]
```

For dogfooding (within this repo), it's `<repo>/.claude/skills/deps/deps.mjs`. Output is formatted text (structured JSON with `--json`). Pass the user's input through as the arguments.

- `--repo owner/repo`: if omitted, the engine extracts it from `git remote get-url origin`
- `--limit N`: enumeration limit (default 50)
- `--dry-run`: judge only. No merge, no confirmation
- `--auto`: merge without confirmation (an explicit opt-out of the irreversible gate)
- If `--dry-run` and `--auto` are both specified, the engine prioritizes `--dry-run` (to prevent accidental merges)

### Merge confirmation (policy's `irreversible` gate = ask)

When neither `--dry-run` nor `--auto` is specified (`plan` mode), the engine does not merge and instead returns a `merge_plan` (the scheduled `gh pr merge <N> --squash`) and the auto-merge candidates. Since merging is an irreversible action, it follows the policy's gate. Look up the gate with `policy-read.mjs --action=merge --repo-root="$PWD"` (user-scope: `~/.claude/skills/policy/policy-read.mjs`; dogfood: `<repo>/.claude/skills/policy/policy-read.mjs`).

- gate=`ask` (zero-config default): confirm auto-merge candidates **one at a time** via AskUserQuestion (do not enumerate `Y/n` as text). Only approved PRs get `gh pr merge <N> --squash` executed (the corresponding command from `merge_plan`). The `要確認` group is not merged; it is only presented with reasons
- If loosened to gate=`batch-confirm`: present auto-merge candidates together once and confirm them all via AskUserQuestion → if approved, re-run `deps.mjs` with `--auto` appended to the same arguments
- gate=`proceed`: re-run with `--auto` without confirmation

When `--auto` is specified, **AskUserQuestion is not inserted** (an explicit opt-out of the irreversible gate). The engine merges serially, noting the result (`merge_results`) alongside each row.

### Integration with scheduled execution

Launching in the form `/deps --auto` from `schedule` (cron routine) or `/loop` closes the loop of "consume automation PRs every morning" (ADR-0028 R5). Since AskUserQuestion cannot be inserted during scheduled execution, the engine's conservative judgment table (`要確認` when in doubt) and the policy gate become the sole boundary.

### Completion report and next-action suggestions

End once the triage table / merged PRs / `要確認` breakdown have been displayed. Do not suggest next actions.
