---
name: policy
description: Defines the contract (policy.schema.json) and read substrate (policy-read.mjs) for the central autonomy policy. The SSOT for the 3 action classes, gate vocabulary, policy.yaml hierarchy, and zero-config defaults. Referenced by other skills and hooks.
user-invocable: false
---

# policy - Central autonomy policy contract and read substrate

A referenced companion (ADR-0028 R3) that consolidates HITL gates — previously scattered across each skill's prose — into a **single-file declaration**. Provides the **SSOT for the contract governing action classification and gate decisions (policy.schema.json), and the all-adapter CLI that reads its effective values (policy-read.mjs)**. Aggregation and application (on the side of each skill / hook) are built separately on top of this contract.

## Principles

- **Unify the contract**: Declare "which actions require approval" in a single policy file rather than in each skill's prose. Each skill simply classifies its own actions into one of the 3 classes and looks up the policy.
- **fail-safe (not fail-open)**: A broken or adversarial policy must **never loosen** the level of autonomy. `policy-read.mjs` does not throw, but always falls back to the **stricter side (`ask`)** for values it cannot trust. This is the opposite direction of safe-side fallback from observability's fail-open (pass through even on failure).
- **Zero-config = equivalent to current behavior**: When policy.yaml is absent, the default is equivalent to current behavior (acceptance criterion). Adding configuration doesn't break things via "configure and forget."

## The 3 action classes

Each skill classifies its own actions into one of the following fixed vocabulary terms:

| Class | Examples | Zero-config default |
| --- | --- | --- |
| `reversible-local` (reversible/local) | Edits on a branch, safe branch delete, worktree prune | `proceed` (+ audit trail) |
| `externally-visible` (externally visible) | Filing an issue, creating a PR, applying topics, PR comments | `batch-confirm` (one batch confirmation) |
| `irreversible` (irreversible/destructive) | merge, publish, stash drop, force operations | `ask` (always an Approval Gate) |

## Gate vocabulary

Only the following 3 values can be assigned to each class / action:

| gate | Meaning |
| --- | --- |
| `proceed` | Execute as-is and leave an audit trail (no confirmation) |
| `batch-confirm` | Confirm once, in a batch, before execution |
| `ask` | Pass through an Approval Gate (explicit approval) for every single operation |

## policy file hierarchy

```text
~/.agents/policy.yaml          # user default (HOME-anchored)
<repo>/.agents/policy.yaml     # repo override (overrides user)
```

repo overrides user, and user overrides the zero-config default. File format (`policy.schema.json` is the SSOT):

```yaml
schema_version: 1
classes:
  reversible-local: proceed
  externally-visible: batch-confirm
  irreversible: ask
actions:
  merge: ask            # per-action override (takes precedence over the class default)
  issue-create: proceed
```

`classes` declares the gate for the 3 classes, and `actions` overrides the gate per kebab-case action name (takes precedence over the class default). Unknown **top-level keys** are mechanically rejected by `additionalProperties: false`. Action names are open, since each skill declares its own; only the value (gate vocabulary) and key shape are validated.

## Contract (policy.schema.json is the SSOT)

`policy.schema.json` (a sibling of this skill) is the sole SSOT. Both `policy-read.mjs` and the tests validate by **reading this file**, so doc and code never drift apart. Following the same approach as skill-observability's `event.schema.json`, `additionalProperties: false` (at the top level) mechanically prevents "unintended loosening of autonomy" caused by typos or unknown keys. `schema_version` is fixed at `1`.

## Read substrate (policy-read.mjs)

`policy-read.mjs` (sibling, a CLI that runs on all adapters) reads and merges the user + repo policy.yaml, and **returns the merged effective values as JSON to stdout**. To avoid a new runtime dependency, YAML is parsed with a hand-rolled parser covering only the minimal subset policy.yaml requires (nested mappings + `key: value` + comments).

```bash
# Return the merged effective policy (classes / actions / sources / degraded) as JSON
node policy-read.mjs

# Resolve the effective gate for a single action (per-action override → class default → stricter side)
node policy-read.mjs --action=merge          # => resolved.gate (default ask)
node policy-read.mjs --action=issue-create   # => resolved.gate (default batch-confirm)
node policy-read.mjs --class=reversible-local

# Specify the repo root explicitly (default is cwd)
node policy-read.mjs --repo-root=/path/to/repo
```

Output (example, under zero-config):

```json
{
  "schema_version": 1,
  "classes": { "reversible-local": "proceed", "externally-visible": "batch-confirm", "irreversible": "ask" },
  "actions": {},
  "sources": { "user": false, "repo": false },
  "degraded": false
}
```

fail-safe conventions:

- **File absent** → zero-config default (equivalent to current behavior). `degraded: false`.
- **Invalid gate value** (schema mismatch) → the effective value for that class / action falls back to `ask`. It never falls through to a looser, lower-priority value.
- **Unparseable file** → ignore that file and set `degraded: true`. Resolve using the other file + defaults (the default for the dangerous class is already `ask`).
- Never throws on any failure; always exits 0. Does not break callers chained with `&&`.

## PreToolUse enforcement hook (Claude Code / `policy-hook.mjs`)

The prose layer (each skill "classifying its own action and looking up the policy") is ultimately a **request**, which the model could ignore or bypass. `policy-hook.mjs` (a sibling PreToolUse hook of the same shape as `usage-guard-hook.mjs`) is **gate enforcement on the execution-engine side**, and physically closes off that gap. It fires before every tool call (including inside subagents), and only looks up the policy to decide deny/allow when it detects a **specific irreversible command**.

| Detected command | Action looked up (class) | Zero-config default gate | Hook behavior |
| --- | --- | --- | --- |
| `gh pr merge …` | `merge` (`irreversible`) | `ask` | deny (exit 2) |
| `gh release create …` | `release-create` (`irreversible`) | `ask` | deny |
| `git push --force` / `-f` / `--force-with-lease` | `force-push` (`irreversible`) | `ask` | deny |
| `npm` / `pnpm` / `yarn publish` | `publish` (`irreversible`) | `ask` | deny |

- **gate → decision:** If the resolved gate is `ask`, deny (exit 2 + reason to stderr); if `proceed` / `batch-confirm`, allow. The hook only hard-blocks on `ask` (batch confirmation is the responsibility of the caller / prose layer).
- **Narrow gating (preventing an all-tool-deny accident):** The policy is looked up **only when it matches an irreversible command in the table above**. Everything else (reads, edits, safe git/gh/npm, non-Bash tools) passes through untouched. Even if the matcher has a bug, it can only fail in the direction of "missing a dangerous command" — it never denies every tool and wedges the session.
- **Doesn't hard-stop on a transient blip (carried over from `usage-guard-hook.mjs`):**
  - **(a) file kill-switch:** If `~/.claude/policy-guard/DISABLE` exists, it's an immediate no-op allow at the very start. Running `touch` from a `!` shell releases it instantly within the session, with no config edit needed.
  - **(b) Policy unreadable / unparseable → allow + stderr warning:** When `policy-read.mjs` returns `degraded`, or the resolver throws, etc. — i.e., whenever **the gate cannot be trusted** — allow rather than deny. Even if the gated command can be detected, if the gate value can't be trusted, let it through. Since the **resumable prose-layer checkpoint (drive / health / lessons-triage) is the primary gate that looks up the same `policy-read.mjs` (fail-safe to `ask`)**, and the hook is a secondary net, it falls to the side of not stopping the session over a broken policy.
  - **(c) proceed override (equivalent to `--merge`):** A caller that has already resolved the gate and been delegated autonomy (e.g., `drive --merge` overrides merge to `proceed` in prose) exports `POLICY_GUARD_PROCEED=<action>[,<action>…]` (`all` / `*` also work). The hook allows that action without re-gating it. This ensures legitimate opt-in merges aren't blocked by the enforcement net.
- **subagent:** Appends the payload's `agent_id` to the deny message as `[origin: subagent <id>]` (functions as a mid-unit ceiling for a running worker).

### Wiring (recommended: `hooks add policy`)

The hook script is bundled in every adapter's payload. Wiring into settings is handled by the CLI ([#174](https://github.com/ozzy-labs/skills/issues/174) PR 3 added support for `hooks add policy`; same shape as `usage-guard` / `observability`):

```bash
# Wire the PreToolUse policy gate into ~/.claude/settings.local.json (absolute path resolved automatically)
npx @ozzylabs/skills hooks add policy

# Check wiring status
npx @ozzylabs/skills hooks status

# Unwire (removes only the entry it wrote)
npx @ozzylabs/skills hooks remove policy
```

The CLI resolves the absolute path of `policy-hook.mjs` from the installed skill dir, shows a diff, and writes it after confirmation (`--yes` for non-interactive, `--dry-run` for plan-only, `--scope=user` for `settings.json`). It is idempotent (re-running `add` is a no-op) and never touches entries other than the one it wrote. The policy that **the repo does not distribute settings / hooks** remains unchanged — the CLI merely writes to local settings with the user's consent.

A policy.yaml template can be generated with `npx @ozzylabs/skills policy init` (`--scope=repo` for `<repo>/.agents/policy.yaml`); an existing file is skipped, not overwritten.

**Fallback (manual wiring):** If not using the CLI, manually add one entry to `~/.claude/settings.local.json` (settings reload mid-session, so no restart is needed):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node /home/<you>/.claude/skills/policy/policy-hook.mjs"
          }
        ]
      }
    ]
  }
}
```

> **Fill in the hook script path as an absolute path by hand** (skill-dir-relative references don't work inside settings). The path varies by environment:
>
> - **user-scope** (`npx @ozzylabs/skills install`): `~/.claude/skills/policy/policy-hook.mjs` (`~` is not expanded, so write it out in full as `/home/<you>/.claude/…`)
> - **dogfood** (inside the skills/commons repo): `<repo>/.claude/skills/policy/policy-hook.mjs`
>
> Both point to "the `policy-hook.mjs` at the same level as `policy-read.mjs`." Since irreversible commands go through Bash, `"Bash"` is sufficient as the matcher (`"*"` also works — non-Bash tools have no command and pass through).

**Disabling:** `touch ~/.claude/policy-guard/DISABLE` (instant, no config edit needed), or remove the above entry from settings (permanent).

## Scope of application

This skill provides the **contract (schema) + read substrate + PreToolUse enforcement hook**. The following are built in separate PRs on top of this contract (not included in this PR):

- **Application by each skill** (replacing the gate descriptions in implement / lessons-triage / topics etc. with "classify your own action and look up the policy." Already implemented in R3 PR2/PR3).
- **Automatic hook wiring** (`hooks add policy`. Already implemented in [#174](https://github.com/ozzy-labs/skills/issues/174) PR 3. See "Wiring" above).

## Notes

- Does not read `.env` files.
- This skill is read-only. It does not generate or rewrite policy.yaml (that is handled by `policy init` in a separate PR).
- fail-safe means "fall back to the stricter side," the opposite direction from observability's fail-open (pass through). Do not confuse the two.
