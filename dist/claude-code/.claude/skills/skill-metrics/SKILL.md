---
description: Aggregates the local observability event log (~/.agents/observability/events.jsonl) and presents, read-only, per-skill invocation counts and notable events (fallback / HITL rejection / loop cap reached / abort). Fires on "show me the skill metrics," "aggregate the observability results," "which skills get used the most?" Does not send anything.
argument-hint: "[--since=<ISO 8601>] [--skill=<name>] [--snapshot]"
disable-model-invocation: true
allowed-tools: Bash, Read
---

# skill-metrics

Read `~/.agents/skills/skill-metrics/SKILL.md` and follow the workflow steps.

## Claude Code-specific additions

### Running the aggregation engine

Run the `skill-metrics.mjs` in the same directory via Bash to obtain the JSON rollup (pass `$ARGUMENTS` through as-is). User-scope: `~/.claude/skills/skill-metrics/skill-metrics.mjs`; dogfood: `<repo>/.claude/skills/skill-metrics/skill-metrics.mjs`:

```bash
node ~/.claude/skills/skill-metrics/skill-metrics.mjs $ARGUMENTS
```

Format the resulting JSON into something human-readable and present it (read-only, no sending).
