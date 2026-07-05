---
argument-hint: "[--since=<ISO 8601>] [--skill=<name>] [--snapshot]"
disable-model-invocation: true
allowed-tools: Bash, Read
---

# skill-metrics

Read `.agents/skills/skill-metrics/SKILL.md` and follow the workflow steps.

## Claude Code-specific additions

### Running the aggregation engine

Run the `skill-metrics.mjs` in the same directory via Bash to obtain the JSON rollup (pass `$ARGUMENTS` through as-is). User-scope: `~/.claude/skills/skill-metrics/skill-metrics.mjs`; dogfood: `<repo>/.claude/skills/skill-metrics/skill-metrics.mjs`:

```bash
node ~/.claude/skills/skill-metrics/skill-metrics.mjs $ARGUMENTS
```

Format the resulting JSON into something human-readable and present it (read-only, no sending).
