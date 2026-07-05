---
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob, AskUserQuestion
---

# lessons-triage

Read `.agents/skills/lessons-triage/SKILL.md` and follow the workflow steps.

## Claude Code-specific additions

### How to read the transcript

- Claude Code's transcript is at `~/.claude/projects/<project-slug>/<session_id>.jsonl` (1 line = 1 event, JSONL)
- Traces of skill invocations can be identified via the `Skill` tool's tool_use events, or the `<command-name>` tag
- For a large transcript, use Grep to narrow down to skill-related event lines, then Read the surrounding context

### Determining past triage sessions (outcome: self)

Since the currently running session hasn't fired SessionEnd yet, it doesn't exist in the queue. The prefilter's `self` determination target is **a session in which lessons-triage was run in the past**, identified via an execution marker in the transcript:

- The `<command-name>lessons-triage</command-name>` tag (a trace of `/lessons-triage` being invoked)
- A `Skill` tool invocation event for `lessons-triage`

Any session whose transcript contains either of these is treated as `outcome: self` and made a discard candidate (identifiable via Grep).

### HITL approval (policy's `externally-visible` gate = batch-confirm)

The batch confirmation in step 4 is done via AskUserQuestion (do not set the `answers` parameter). With gate=`batch-confirm` (default), present all lessons as the options of a single question, and use `multiSelect: true` to have the user select as a batch which lessons to file. If the number of lessons exceeds the option limit for a single question, it's fine to split across multiple rounds, but treat all of them as "one batch-confirmation round" — do not revert to per-lesson sequential approval. Only run `gh issue create` for the selected lessons; discard the unselected ones.

Only fall back to per-lesson confirmation (file / file with edits / discard) when gate=`ask` (tightened by policy).
