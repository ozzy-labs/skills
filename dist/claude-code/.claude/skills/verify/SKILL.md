---
description: An integrated skill that runs the combined validation of build / typecheck / test / lint in one shot. The `verify.mjs` engine auto-discovers validation commands via a discovery chain (AGENTS.md's 「検証」 section → package.json scripts → justfile/Makefile/lefthook → language heuristics), executes them serially with their source attached, and returns a result summary. If a higher-priority stage produces a hit, only that stage is executed (no crossing stages).
argument-hint: "[--dry-run] [--json] [--repo-root=<dir>]"
allowed-tools: Bash, Read
---

# verify

Read `~/.agents/skills/verify/SKILL.md` and follow the workflow procedure.

**Important:** The discovery chain of validation commands, serial execution, and rendering of the result summary are handled by the `verify.mjs` engine. Present the engine's stdout as-is; do not reformat or reinterpret it.

## Claude Code-specific additions

### Running the engine

Execute `verify.mjs` in the same directory via Bash (passing `$ARGUMENTS` as-is). In user-scope it's `~/.claude/skills/verify/verify.mjs`, in dogfood it's `<repo>/.claude/skills/verify/verify.mjs`:

```bash
node ~/.claude/skills/verify/verify.mjs $ARGUMENTS
```

### Argument parsing

Determine the presence of `--dry-run` (alias `--discover`) / `--json` / `--repo-root=<dir>`. Since the engine interprets all of these, it's sufficient to simply pass `$ARGUMENTS` as-is.

### Completion report / next-action suggestion

End once the engine output has been presented. Even if there are failed commands, do not automatically fix or re-run here (leave that to the caller's judgment). Do not suggest next actions either.
