---
argument-hint: "<candidate-list> [--repo owner/repo] [--apply | --dry-run]"
disable-model-invocation: true
allowed-tools: Bash, Read, AskUserQuestion
---

# topics

Read `.agents/skills/topics/SKILL.md` and follow the workflow procedure.

**Important:** All determinism (official constraint validation / popularity retrieval / broad+narrow 5x / singular-plural comparison / hardcoding of ozzy-labs conventions) is handled by the bundled **`topics.mjs` engine**. The SKILL is dedicated to the judgment layer of "call the engine, present the output as-is, and confirm application via the policy gate". Do not expand conventions on Claude's own judgment (do so together in the engine + SKILL.md).

## Claude Code-specific additions

### Running the engine

```bash
node ~/.claude/skills/topics/topics.mjs <candidate-list> [--repo owner/repo] [--dry-run]
```

In dogfood (within this repo) it's `<repo>/.claude/skills/topics/topics.mjs`. The output is formatted text (structured JSON with `--json`). Pass the arguments as the user entered them, as-is.

- `<candidate-list>`: `,`-delimited or multiple arguments
- `--repo owner/repo`: if omitted, the engine extracts it from `git remote get-url origin`
- `--apply`: explicitly opts out of the policy's batch-confirm, and the engine applies without confirmation
- `--dry-run`: analysis only, does not apply
- If both `--apply` and `--dry-run` are specified, the engine prioritizes `--dry-run`

### Application confirmation (policy's `externally-visible` gate = batch-confirm)

If neither `--apply` nor `--dry-run` is specified (`plan` mode), the engine does not apply and returns `apply_command` (the command to be executed) and `final_topics`. Follow the policy's gate. With gate=`batch-confirm` (zero-config default), present the final topics list all at once, then call AskUserQuestion **exactly once** (do not set the `answers` parameter):

- **"Apply"** → re-run `topics.mjs` with the same arguments plus `--apply` (the engine executes `gh repo edit --add-topic` and verifies with `gh repo view`)
- **"Don't apply"** → display the analysis result only and end
- **"Edit candidates"** → end, and prompt the user to re-run

If gate=`ask` has been tightened, confirm one topic at a time. Treat `--apply` as an explicit opt-out of `batch-confirm`, and apply without confirmation.

### Completion report / next-action suggestion

End once the applied result (`apply.verified_topics`) or the dry-run / plan result has been displayed. Do not suggest next actions.
