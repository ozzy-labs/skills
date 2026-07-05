---
name: verify
description: An integrated skill that runs the combined validation of build / typecheck / test / lint in one shot. The `verify.mjs` engine auto-discovers validation commands via a discovery chain (AGENTS.md's 「検証」 section → package.json scripts → justfile/Makefile/lefthook → language heuristics), executes them serially with their source attached, and returns a result summary. If a higher-priority stage produces a hit, only that stage is executed (no crossing stages).
---

# verify - Integrated validation (discovery chain + execution)

Performs the combined validation of "does build + typecheck + test + lint pass" in one shot. From an agent's perspective these are always needed together, so the former `lint` / `test` / `lint-rules` have been integrated into `verify` ([ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R4).

The determinism (the validation command discovery chain, source attribution, serial execution, and rendering of the result summary) is handled by the bundled **`verify.mjs` engine** (ADR-0028 R1, following the precedent of `health-check.mjs` / `usage-check.mjs` / `skill-metrics.mjs`). This SKILL.md is confined to the judgment layer — **when to call the engine, how to report the results, and where to confirm with a human**.

## Principles

- **A single combined validation:** verify always has the same intent (whether build + typecheck + test + lint pass). Selecting individual commands is left to the engine's discovery chain.
- **Discovery chain, no crossing stages:** If a command is found at a higher-priority stage, only that stage is executed — it does not descend to lower stages. All commands found within the same stage are executed.
- **Explicit source attribution:** Always include, in the report, which stage (source) each command was found at.
- **Works in consumer repos:** Rather than relying solely on AGENTS.md assumptions, it falls back as far as package.json / task runners / language heuristics ([#179](https://github.com/ozzy-labs/skills/issues/179) is absorbed by this).

## Validation command discovery chain

The engine evaluates the following 4 stages in order from top to bottom, and **settles on the first stage that produces a command** (no crossing stages; everything within the same stage is executed):

| Stage | Source (`source`) | Discovery target |
|---|---|---|
| 1 | `agents-md` | Fenced code blocks / inline `command`s in AGENTS.md's 「検証」 section |
| 2 | `package-json` | Among `package.json`'s scripts: `build` / `typecheck` / `test` / `lint` (whichever exist; the package manager is determined from the lockfile to form `<pm> run <script>`) |
| 3 | `task-runner` | The corresponding target (`build` / `typecheck` / `test` / `lint`; for lefthook, `pre-commit` / `pre-push`) in whichever of `justfile` > `Makefile` > `lefthook.yaml` exists first |
| 4 | `language-heuristic` | `go.mod`→`go build ./...` + `go test ./...` / `pyproject.toml`+`uv.lock`→`uv run pytest` / `Cargo.toml`→`cargo build` + `cargo test` |

If none of the stages find anything, report it as "not found" (do not execute).

## Procedure

1. Execute the `verify.mjs` **in the same directory as this SKILL.md** via Bash. In Claude Code that's `~/.claude/skills/verify/verify.mjs` (dogfood: `<repo>/.claude/skills/verify/verify.mjs`):

   ```bash
   node <this skill's directory>/verify.mjs [--dry-run] [--json] [--repo-root=<dir>]
   ```

2. By default the engine **executes the discovered commands (with source attached) serially** and outputs a formatted result summary to stdout. **Present that output as-is** (do not reformat or reinterpret it — rendering is the engine's responsibility).
3. `--dry-run` only discovers (does not execute). Use it when you want to check "which commands are selected, from which source".
4. If any command fails, present that fact as-is (command, source, error summary). Do not perform automatic fixing (if a lint auto-fix is needed, that's the responsibility of the discovered lint command itself).

## Input

- No arguments → serially executes the commands of the stage settled on by the discovery chain, and presents a result summary
- `--dry-run` (alias `--discover`) → discovery only. Does not execute
- `--json` → outputs structured JSON instead of a human-readable report (for programmatic integration / debugging use; can be used for mechanical judgment from `drive` / `implement`)
- `--repo-root=<dir>` → validates a directory other than cwd

## Output (key points of the JSON schema v1)

- `discovery.stage` — the settled stage (`agents-md` / `package-json` / `task-runner` / `language-heuristic` / `null`)
- `discovery.commands[]` — `{ command, source, kind }` (`source` is the source, `kind` is `build` / `typecheck` / `test` / `lint` / `other`)
- `results[]` — only when executed. `{ command, source, kind, status, ok, error }`
- `ok` — `true` if all commands pass, `false` if any fail, `null` if not executed (`--dry-run` / not found)

## Per-extension lint rules (absorbed from the former lint-rules)

The discovery chain finds project-level commands. Per-file lint / format rules are absorbed into the engine as `LINT_RULES` (absorbing the former `lint-rules` skill):

| Extension | Command |
|--------|---------|
| `.ts` / `.tsx` / `.js` / `.jsx` / `.json` | `biome check --write <file>` |
| `.md` | `markdownlint-cli2 --fix <file>` |
| `.yaml` / `.yml` | `yamlfmt <file> && yamllint -c .yamllint.yaml <file>` |
| `.toml` | `taplo format <file>` |
| `.sh` | `shfmt -w <file> && shellcheck <file>` |

## Notes

- Does not read `.env` files.
- The discovery chain is deterministic. Changes to the stage order / selection rules should be made together in the engine + this SKILL.md.
- verify only selects and executes commands. It does not perform destructive operations (commit / push / merge).
- It also works in consumer repos without an AGENTS.md 「検証」 section, since it falls back as far as package.json / task runner / language heuristics.
