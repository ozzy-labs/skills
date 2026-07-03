English | [日本語](docs/README.ja.md)

# @ozzylabs/skills

Canonical OzzyLabs agent skill bundle for Claude Code, GitHub Copilot, Gemini CLI, and Codex CLI.

`.agents/skills/{name}/SKILL.md` is the single source of truth. `pnpm build` produces per-agent outputs under `dist/{adapter-id}/` (`claude-code`, `codex-cli`, `gemini-cli`, `copilot`). End users install these skills as **user skills** (e.g. `~/.claude/skills/`) via the CLI installer shipped in the npm package.

This package backs the [OzzyLabs handbook ADR-0016](https://github.com/ozzy-labs/handbook/blob/main/adr/0016-create-skills-repo.md) decision to extract skills out of the `commons` repository into their own SSOT. Distribution is **user skills by default** (see handbook ADR-0027, in preparation): consumers install via `npx @ozzylabs/skills install`, and project-scope skills (`.claude/skills/` under each consumer repo) are no longer pushed automatically. The supported exception is **Claude mobile / web (cloud) sessions**, which run "repo only" and never see `~/.claude/skills/`: for repos developed that way, `npx @ozzylabs/skills add --target <repo>` opts in to a relative-ref project-scope payload (`dist/claude-code-project/`) — see [the CLI section](#cli) below. Project-scope skills otherwise remain in use only inside the `skills` / `commons` repos themselves for dogfooding, where the build pipeline emits them from the SSOT.

## Skills in v0.x

20 skills total: 15 generic workflow skills shared across all OzzyLabs repositories (including the reference-only `policy` companion), 2 Claude-Code-only skills (`usage-guard`, `skill-observability`), plus 3 internal-use skills (`health`, `topics`, `phase-issue`) bundled in the package. (The legacy `migrate` subcommand that cleaned up the old project-scoped layout has been removed — see [#151](https://github.com/ozzy-labs/skills/issues/151).)

> **Breaking change (ADR-0028 R4):** the former `lint`, `test`, and `lint-rules` skills were removed and unified into **`verify`** (build + type + test + lint via a discovery engine). Replace any `/lint` or `/test` usage with `/verify`; existing installs drop the retired skills with `npx @ozzylabs/skills update --prune`. See [#182](https://github.com/ozzy-labs/skills/issues/182).

| Skill | Description |
| --- | --- |
| `backlog` | Collect open issues via the `backlog.mjs` engine and hand them off to `drive`: dependency extraction REUSES the drive engine's rule (`drive-plan.mjs` `detectBodyDeps` / `topoWaves`, the single SSOT — never re-encoded), then a fixed-vocabulary priority sort ((a) blocker / (b) milestone due asc / (c) `priority:high` label / (d) updatedAt oldest, deterministic tie-break) orders candidates and emits a drive-ready arg string (`#12,#15 -> #18`). Default presents only; `--drive[=N]` hands the top-N dependency closure to drive after confirmation; `--auto` runs confirmation-free but ONLY over `auto-ok`-labelled issues (HATL) and gated by the central autonomy policy (drive launch = `externally-visible` → batch-confirm). Single-repo scope |
| `ci-fix` | Thin wrapper that collects a failed CI run's logs, shapes them into a drive instruction, and hands off to `/drive`. Input resolution (explicit run id > explicit branch's latest failure > current branch's latest failure via `gh run list --branch <b> --status failure --limit 1`) → flaky check (one `gh run rerun --failed` + polling at 30s / 15min cap; `--no-rerun` skips it) → log extraction (`gh run view --log-failed`, ANSI strip + error-line regex IDENTICAL to health's same-error grouping in `health-check.mjs` `extractCiErrorKey`, enforced by a sync assertion) → instruction assembly → `/drive` launch. `--dry-run` prints the instruction only (no rerun, no drive launch); `--auto` skips the pre-launch confirm. main-branch failures (broken merged code) are flagged high-priority at the top of the report |
| `commit` | Stage changes and create a Conventional Commit |
| `commit-conventions` | Commit / branch / PR naming conventions |
| `deps` | Policy-based triage of automation PRs (renovate / dependabot) via the `deps.mjs` engine: enumerate open bot PRs (author detection IDENTICAL to health area 15 — `*[bot]` / `app/*`; release-please excluded, it is `/release`'s job), classify each by semver bump (PR title / branch / manifest diff, grouped PRs judged by their MAX bump), CI status (`gh pr checks`), lockfile integrity, and peer/engines changes, then apply the fixed judgment table: patch/minor + CI green + lockfile consistent + no peer/engines → auto-merge candidate; major / CI red / pending / no-checks / unknown bump / lockfile drift / peer / engines → 要確認. `--dry-run` classifies only (wins over `--auto`); `--auto` merges confirmation-free. Merge (`gh pr merge --squash`) is irreversible and gated by the central autonomy policy (`--action=merge`, zero-config `ask`); `--auto` is the explicit override. Single-repo scope |
| `drive` | Issue → merge-ready PR autonomous loop. usage-guard is **on by default** (Claude Code only; opt out with `--no-usage-guard`, and `--usage-guard` is a deprecated no-op alias): at resumable-unit boundaries (Phase 1 start / each review-loop pass / each wave / before worker dispatch) it Reads the `usage-guard` engine and, when over the Usage Limit threshold, waits for the window to reset then re-enters via `/drive <args>` (idempotent resume). If the `usage-guard` skill is not installed it logs a one-line warning and proceeds (fail-open). Orchestration pauses at wave-boundary granularity; an in-flight worker's ceiling is the PreToolUse hook. Orchestration `--merge` is **self-closing in one run**: workers do not self-merge — the parent centralizes merge and, before merging, runs a pre-merge cross-cutting audit (Final-2) → folds gaps into the introducing PR (Final-3 reconciliation) → merges in dependency order (Final-4), leaving no follow-up ([#166](https://github.com/ozzy-labs/skills/issues/166)) |
| `health` | Inspect repo state and skill catalog consistency across 16 areas via the `health-check.mjs` engine, with inline recommended actions (`--deep` for follow-up investigation of `要確認` items; `--fix` executes only the safe vocabulary — prune / delete / fetch, and `--deep`-upgraded drop — gated by the central autonomy policy (`policy-read.mjs`): reversible-local = `proceed` (run + audit trail), the irreversible stash drop = `ask` (individual confirm); `--yes` is the explicit opt-out. Policy absence fails safe to `ask`). Default is read-only |
| `implement` | Branch creation and implementation from an issue or instructions |
| `lessons-triage` | Triage the session-lessons queue (`~/.agents/lessons/queue.jsonl`, filled by the dotfiles `lesson-capture.sh` hook): extract User-Skills improvement lessons from session transcripts and file approved ones as issues on ozzy-labs/skills. HITL — issue filing follows the central autonomy policy (externally-visible → batch-confirm: one bulk approval of all extracted lessons); no repo edits, no auto-apply |
| `phase-issue` | Generate a Phase-N tracking issue: assembles a structured body (cross-session handoff context, decision table, per-PR tasks, DoD, Phase N+1 outlook) and files it via `gh issue create`. Non-interactive by default — all sections passed as arguments; the Claude Code companion adds an interactive mode that collects missing ones. `--draft` prints the body to stdout instead of filing |
| `policy` | Referenced companion (non-user-invocable) defining the central autonomy policy contract (ADR-0028 R3): the action 3-class model (reversible-local / externally-visible / irreversible), the gate vocabulary (`proceed` / `batch-confirm` / `ask`), the `~/.agents/policy.yaml` (user) + `.agents/policy.yaml` (repo, overrides user) hierarchy, and zero-config defaults equal to today's behavior. Ships `policy.schema.json` (schema SSOT) and the all-adapter `policy-read.mjs` read CLI that merges the two files and prints the effective policy as JSON, fail-safe to `ask` on any untrusted value |
| `pr` | Push changes and open or update a PR |
| `release` | Verify → gated-merge → publish-monitor a release-please PR: detect it (`gh pr list --author app/release-please --state open`; 0 hits → "nothing to release" + co-report any draft release, health area 14), run the fixed checklist (version bump vs. the SemVer implied by its commit types — feat→minor / fix→patch / `!` or BREAKING CHANGE→major; CHANGELOG consistency; CI all green), then — the default is an approval gate (releases are externally-visible and effectively irreversible, so the merge follows the central autonomy policy `--action=merge`, zero-config `ask`) — `gh pr merge --squash`, monitor the publish workflow (30s poll, 20-min cap), and confirm `npm view <pkg> version` (npm-distributed repos only). `--auto` skips the gate ONLY when every verification passes (still stops on any failure). On failure it summarizes `gh run view --log-failed` and points at common causes (Trusted Publisher / provenance / permissions). npm publish uses OIDC Trusted Publishers (no `NPM_TOKEN`); publish-workflow-less repos complete on merge + tag / Release. Single-repo scope |
| `review` | Review code changes or PRs across 11 perspectives (correctness / security / conventions / architecture / compatibility / maintainability / testing / performance / observability / usability / documentation). Emits a JSON-structured payload alongside the human-readable comment so `drive` can terminate its loop deterministically. `--axes` overrides the auto-selection; `--deep` fans out per-axis subagents (Claude Code only) |
| `ship` | Lint + commit + PR creation in one go |
| `skill-metrics` | Read-only aggregator over the observability event log (`~/.agents/observability/events.jsonl`): per-skill invocation counts + notable friction events (fallback / HITL-reject / loop-cap / abort), with a min-n guard so rates are shown only when the denominator is large enough. Local-only — never sends anything; reflection (issue-filing) is `lessons-triage`'s job. See "Observability" below |
| `skill-observability` | **Claude Code only.** Referenced companion that defines the skill-improvement loop's measurement layer: the event contract (`event.schema.json`, the single SSOT) and the fail-open emit substrate (`obs-emit.mjs`). Metadata-only, privacy-first (`additionalProperties:false` rejects payloads; repo ids are hashed). See "Observability" below |
| `topics` | Research-driven GitHub topics setup (ozzy-labs scope) via the `topics.mjs` engine: validate official constraints (lowercase / hyphen / 50 chars / max 20), measure popularity via `gh api search/repositories` with session-scoped cache, decide broad+narrow / singular-plural pairs, and apply ozzy-labs hardcoded conventions (`claude-code` exception, `*-cli` suffix removal, `multi-agent` canonical form). `--apply` to commit (the policy `externally-visible` batch-confirm opt-out), `--dry-run` for analysis only |
| `usage-guard` | **Claude Code only.** Monitor the Usage Limit (5-hour / 7-day) via the OAuth usage endpoint and auto pause/resume work at 95% (env-overridable): exceeded → `ScheduleWakeup` until the latest exceeded window resets, then re-enter. Doubles as a pause/resume engine (callers like `drive` Read it at checkpoints) and a standalone `/usage-guard "<continuation>"` form (idempotent continuation assumed). Endpoint → JSONL fallback → fail-open. Optionally pair it with the PreToolUse ceiling hook (see below) |
| `verify` | Unified build + type + test + lint verification via the `verify.mjs` engine. A discovery chain (AGENTS.md「検証」section → package.json scripts → justfile/Makefile/lefthook targets → language heuristic) finds the project's verification commands; the first stage that yields any command wins (no stage crossing, and every command within it runs), each command is stamped with its `source` (provenance) and run serially, returning a JSON summary. `--dry-run` discovers only. Folds in the old `lint-rules` per-extension table (ADR-0028 R4, supersedes [#179](https://github.com/ozzy-labs/skills/issues/179)) |

`usage-guard` also ships a `usage-guard-hook.mjs` extra file: an optional **PreToolUse ceiling hook** that fires on every tool call (including inside subagents) and denies once usage is over threshold — the in-flight complement to drive's default-on usage-guard, which only pauses at resumable-unit boundaries. It reads the same `~/.claude/usage-guard/cache.json` the engine writes (no extra endpoint hits) and fails open when the signal is unreadable. The repo does not ship settings/hooks, so enabling it is a manual opt-in: add a PreToolUse entry to `~/.claude/settings.local.json` whose `command` is the **absolute** path to `usage-guard-hook.mjs` (the path differs between user-scope `~/.claude/skills/usage-guard/...` and dogfood `<repo>/.claude/skills/usage-guard/...` — fill in your own). Full snippet + path-resolution note in the skill's "PreToolUse hook を有効化" section.

### Observability (skill-improvement loop)

`skill-observability` lays the measurement foundation for a data-driven skill-improvement loop (capture → aggregate → reflect). It ships three artifacts as a referenced companion:

- **`event.schema.json`** — the single SSOT for the event contract. Both `obs-emit.mjs` and the test suite consume this exact file, so the event shape has no doc/code drift. Field names follow the OpenTelemetry GenAI semantic-convention *shape* (`skill`≈`gen_ai.agent.name`, `operation`≈`gen_ai.operation.name`) without hard-coupling to the still-experimental spec. `additionalProperties:false` is the mechanical privacy guard: any unknown field (payload, diff, token, path) fails validation and is never written.
- **`obs-emit.mjs`** — the fail-open append+validate write substrate. It records one validated event per call to `~/.agents/observability/events.jsonl` (HOME-anchored, append-only, OTel-independent). It captures nothing on its own and never throws: a rejected or failed emit warns and exits 0 so observability can never break the skill being observed. Repo identifiers passed via `--repo` are hashed (never stored raw).
- **`obs-derive.mjs`** — the artifact-derived **SessionEnd capture hook** (the primary path that avoids self-report bias). It reads the session transcript after the fact and derives which skills ran — model-invoked `Skill` tool uses (`invoke_agent`) and user-typed `/slash-commands` (`slash_command`) — emitting one `start` per invocation plus a `heartbeat` (so an empty window reads as "0 invocations", not "hook never fired"). Skill args are never recorded. It deliberately does **not** derive merge/abort outcome (deferred: session-end merge state is unconfirmed; abort-inference is noisy). The repo ships no settings/hooks, so wiring is a manual opt-in: add a SessionEnd entry to `~/.claude/settings.json` whose `command` is the absolute path to `obs-derive.mjs` (snippet in the skill's "SessionEnd hook を有効化" section).

```bash
node obs-emit.mjs --skill=drive  --event=outcome --status=completed
node obs-emit.mjs --skill=review --event=signal  --name=review.loop_iter --value=2
node obs-emit.mjs --skill=drive  --event=heartbeat
```

The **`skill-metrics`** skill (shipped, all-adapter) aggregates this log read-only into per-skill invocation counts + notable friction events, applying a min-n guard so a misleading "1/1 = 100%" rate is never shown for low-frequency data.

Built on top of this contract (separate follow-ups, tracked in [#162](https://github.com/ozzy-labs/skills/issues/162)): outcome derivation (`gh`/`git` merge ground truth + session→PR linkage) and a reflection channel that folds privacy-scrubbed rollups into `lessons-triage` issues (HITL, opt-in).

Repo-specific skills (e.g. `road`'s `improve-loop` / `road-repo-context`) are intentionally not included in this package.

## CLI

The `@ozzylabs/skills` package ships a CLI. Scope is chosen by `--target`: absent → **user scope** (`$HOME`), present → **project scope** (a consumer repo, committed). The verb is `add` (`install` is accepted as an alias).

```bash
# User scope — add every skill for the agent CLIs detected on this machine
npx @ozzylabs/skills add

# User scope — pick adapters explicitly (required in non-interactive / CI runs)
npx @ozzylabs/skills add --adapter=codex-cli --skills=drive,review

# Dry-run: print the JSON plan and do nothing
npx @ozzylabs/skills add --adapter=claude-code --skills=drive --dry-run

# Project scope — write into a consumer repo (review the diff and commit it).
# Reaches Claude mobile / web (cloud) sessions that only see committed files.
npx @ozzylabs/skills add --target=./my-repo
```

Supported adapters: `claude-code`, `codex-cli`, `gemini-cli`, `copilot`. On an **interactive** run `--adapter` defaults to the CLIs detected under `$HOME`; on a **non-interactive** run (CI, pipe) `--adapter` is required. The Claude Code payload is self-contained (ships the `.claude/skills/` wrappers **and** the canonical `.agents/skills/` files they Read); Codex / Gemini / Copilot share the canonical `.agents/skills/` tree.

### Verbs

| Verb | What it does |
| --- | --- |
| `add` (alias `install`) | Add skills to a scope. Refuses to overwrite an unmarked (foreign) skill dir without `--force`. |
| `list` | Show the catalog with installed status. `--json`, `--target`. |
| `update [<skill>…]` | Re-materialize installed skills, **preserving local edits**: an edited skill is not clobbered — resolve with `--take-theirs` / `--keep-mine` / `--merge` (3-way). `--prune` removes skills no longer in the bundle. |
| `remove` (alias `uninstall`) | Uninstall skills. Confirmation required (TTY prompt or `--yes`). `--skills` required. |
| `fork <skill> <new-name>` | Copy an installed skill to a user-owned, unmanaged name (free to edit; never touched by update/remove). |
| `diff <skill>` | Show a skill's local edits vs the current upstream. |
| `hooks <add\|remove\|status> [<name>]` | Wire/unwire/inspect an optional Claude Code hook (`usage-guard`, `observability`, `policy`). `add`/`remove` resolve the script's absolute path, preview a diff, and confirm (`--yes` non-interactively); `add usage-guard` also suggests the endpoint-path permissions allowlist (`--no-permissions` to skip). `status` reports each hook's wiring and, for a wired usage-guard, diagnoses whether the guard is effective or has degraded to a no-op. |
| `policy <init>` | Scaffold a commented `policy.yaml` for the central autonomy policy (`--scope=user` → `~/.agents/policy.yaml`, `--scope=repo` → `<repo>/.agents/policy.yaml`). Non-destructive: an existing file is never overwritten. `--dry-run` prints the template; `--yes` skips the confirm (required non-interactively). |

### State & editable skills

Installed skills are **editable** — edit them in place under their own name. The CLI tracks what it installed with **per-item provenance markers** (`.ozzylabs-skills.json` co-located in each skill dir; no central registry). The shared `.agents/skills/<name>` base is **reference-counted** across adapters (removing one adapter keeps the base while another needs it). `update` baselines each skill's content hash so it can detect — and refuse to clobber — your local edits.

Project scope (`--target`) writes the committed payload (`.claude/skills/` wrappers + canonical `.agents/skills/` + `.claude/agents/`) with repo-root-relative refs preserved. The legacy `sync-project` and `migrate` subcommands have been removed — use `add --target <repo>`. For edited skills, `update --merge` does a 3-way merge (base = the install-time snapshot, mine = your edits, theirs = current upstream); conflicts are left with standard `<<<<<<<` markers.

### Hook wiring

Three skills ship an optional Claude Code hook as an extra file: usage-guard's PreToolUse ceiling (`usage-guard-hook.mjs`), skill-observability's SessionEnd capture (`obs-derive.mjs`), and the central autonomy policy's PreToolUse enforcement gate (`policy-hook.mjs`). Enabling one means adding a hook entry whose `command` is the **absolute** path to that script — and that path differs between a user-scope install (`~/.claude/skills/…`) and dogfooding inside this repo (`<repo>/.claude/skills/…`). `hooks add` resolves it for you:

```bash
# Wire usage-guard's PreToolUse ceiling into ~/.claude/settings.local.json
npx @ozzylabs/skills hooks add usage-guard

# Wire skill-observability's SessionEnd capture; --scope=user targets settings.json
npx @ozzylabs/skills hooks add observability --scope=user

# Wire the central autonomy policy's PreToolUse gate (narrow-gated to irreversible
# commands like gh pr merge / npm publish / git push --force)
npx @ozzylabs/skills hooks add policy

# Preview the settings diff without writing anything
npx @ozzylabs/skills hooks add usage-guard --dry-run

# Wire the hook but skip the permissions suggestion
npx @ozzylabs/skills hooks add usage-guard --no-permissions

# Remove only the entry this CLI wrote (other hooks stay untouched)
npx @ozzylabs/skills hooks remove usage-guard

# Inspect wiring + diagnose whether a wired usage-guard is actually effective
npx @ozzylabs/skills hooks status
```

`hooks add` resolves the script from the installed skill dir (run `add --skills=usage-guard` first if it is missing), previews the settings diff, and asks before writing (`--yes` is required on non-interactive / CI runs). It edits `settings.local.json` by default (`--scope=user` for `settings.json`), is idempotent (a re-add is a no-op), only ever touches the entries it owns, and refuses to overwrite an unparseable settings file. The repo still ships no settings/hooks — this only writes your local settings on request.

`hooks add usage-guard` additionally proposes the **permissions allowlist** the endpoint path needs — a `Read(//…/.credentials.json)` and a `Bash(node …/usage-check.mjs:*)` entry (see the skill's §環境要件) — folded into the same diff. It is a non-destructive, idempotent append to `permissions.allow`; `--no-permissions` opts out and still wires the hook. Without those grants the guard silently falls back to `fail-open` (effectively OFF).

`hooks status` is read-only: it scans both settings files and reports, per hook, whether it is wired. For a wired usage-guard it runs `usage-check.mjs` once and diagnoses the `source` — `endpoint`/`cache` mean the guard is effective, while `jsonl`/`fail-open` mean it has degraded to a no-op (with a pointer to the skill's §環境要件). This catches the failure mode where the hook is wired but the endpoint path is blocked, so the guard is quietly off.

`hooks add policy` wires the **central autonomy policy's** PreToolUse enforcement gate. It is narrow-gated: it only inspects irreversible Bash commands (`gh pr merge`, `gh release create`, `git push --force`, `npm`/`pnpm`/`yarn publish`) and denies them when the resolved gate is `ask`; every other tool call passes through untouched. A caller that has already been granted autonomy for an action (e.g. `drive --merge`, which overrides `merge` to `proceed`) exports `POLICY_GUARD_PROCEED=merge` so its own pre-approved merge is not re-blocked by the gate. See the `policy` skill for the contract and the file kill-switch (`~/.claude/policy-guard/DISABLE`).

### Autonomy policy template

`policy init` scaffolds a commented `policy.yaml` for the central autonomy policy — the three class defaults (`reversible-local`/`externally-visible`/`irreversible`) spelled out, plus commented per-action override examples. The written file is a valid, zero-config-equivalent policy (it reproduces today's behavior until you edit it):

```bash
# Write ~/.agents/policy.yaml (user default)
npx @ozzylabs/skills policy init

# Write <repo>/.agents/policy.yaml (repo override, wins over user)
npx @ozzylabs/skills policy init --scope=repo

# Print the template without writing anything
npx @ozzylabs/skills policy init --dry-run
```

It is non-destructive: an existing `policy.yaml` is never overwritten (it skips with a note). `--yes` skips the confirmation prompt (required on non-interactive / CI runs).

## Consumer setup

Add the skills as **user skills** with a single command:

```bash
npx @ozzylabs/skills add
```

This drops the canonical skills into your user-scope skill directory (e.g. `~/.claude/skills/{name}/SKILL.md` for Claude Code) so every project on the machine can use them without per-repo configuration.

### Adapter selection

On an interactive run, `add` installs for the agent CLIs detected on your machine. Pass `--adapter` (comma-separated) to choose explicitly — required on non-interactive / CI runs:

```bash
npx @ozzylabs/skills add --adapter=claude-code,codex-cli
```

The Claude Code payload is self-contained: it ships the `.claude/skills/` wrappers **and** the canonical `.agents/skills/` files those wrappers Read, so a standalone `--adapter=claude-code` install resolves every reference without also installing `codex-cli`.

| Adapter id | User-scope install target |
| --- | --- |
| `claude-code` | `~/.claude/skills/{name}/SKILL.md` |
| `codex-cli` | `~/.agents/skills/{name}/SKILL.md` + `AGENTS.md.snippet` merge |
| `gemini-cli` | `~/.agents/skills/{name}/SKILL.md` + `~/.gemini/settings.json` + `AGENTS.md.snippet` merge |
| `copilot` | `~/.agents/skills/{name}/SKILL.md` + `copilot-instructions.md` snippet merge |

Codex CLI, Gemini CLI, and Copilot CLI all read Agent Skills natively from `.agents/skills/`, so they install the same canonical tree into the shared `~/.agents/skills/` (plus their own aggregation file). See `npx @ozzylabs/skills add --help` for the full list of options and the exact target paths.

### Using the skills in CI

For GitHub Actions, use the `ozzy-labs/skills` composite action — it wraps `npx @ozzylabs/skills install` and writes into the runner's `$HOME/.claude/skills/` (and `$HOME/.agents/skills/`):

```yaml
- uses: ozzy-labs/skills@v1
  with:
    skills: drive,review   # default: '' (install all bundled skills)
    adapter: claude-code   # default: claude-code
    # version: latest      # default: latest from npm; pin a version for reproducibility
```

The action installs at the user scope only (`$HOME/.claude/skills/`); a `target` input is intentionally omitted so consumers cannot accidentally write into repo-local `.claude/skills/`. A runnable end-to-end sample lives at [`examples/ci-with-skills.yaml`](examples/ci-with-skills.yaml).

If you would rather call the CLI directly (e.g. to share a custom install step across multiple jobs), invoke it from a `run:` step:

```yaml
- name: Install OzzyLabs skills
  run: npx --yes @ozzylabs/skills install --adapter claude-code
```

### Migrating from the legacy push-mode flow

Consumers that previously consumed skills as **project skills** via the legacy push-mode sync flow (`dist/{adapter-id}/` copied into `.claude/skills/` etc.) need to migrate to user skills only. The migration was completed in [issue #100](https://github.com/ozzy-labs/skills/issues/100) by delivering a one-off `chore/migrate-to-user-skills` PR to each consumer. For new consumers, the manual steps are:

1. Remove `.claude/skills/`, `.agents/skills/`, and equivalent in-repo skill mirrors (manually; the `migrate` subcommand has been removed — `skills remove` will cover this once available, see [#151](https://github.com/ozzy-labs/skills/issues/151)).
2. Drop `skills_commit` / `skills_adapters` from `.commons/sync.yaml`.
3. Have each contributor run `npx @ozzylabs/skills install` once on their machine.

## Adapter outputs

`pnpm build` runs each per-agent adapter under `scripts/adapters/` and writes the result to `dist/{adapter-id}/`:

| Adapter | Output | Source |
| --- | --- | --- |
| `claude-code` | `dist/claude-code/.claude/skills/{name}/SKILL.md` | `SKILL.claude-code.md` if present, else canonical `SKILL.md` |
| `codex-cli` | `dist/codex-cli/.agents/skills/{name}/SKILL.md` + `AGENTS.md.snippet` | canonical `SKILL.md` |
| `gemini-cli` | `dist/gemini-cli/.agents/skills/{name}/SKILL.md` + `.gemini/settings.json` + `AGENTS.md.snippet` | canonical `SKILL.md` |
| `copilot` | `dist/copilot/.agents/skills/{name}/SKILL.md` + `copilot-instructions.md.snippet` | canonical `SKILL.md` |

### Claude Code companion file (overlay)

A skill may ship `.agents/skills/{name}/SKILL.claude-code.md` alongside the canonical `SKILL.md`. It is an **overlay**: it carries only Claude-Code-specific frontmatter plus a body (next-action `AskUserQuestion` menus, argument parsing, etc.). At build time the Claude Code adapter injects the canonical `description` as the first frontmatter key, so the two can never drift — the companion **must not** duplicate `description`.

Companion frontmatter contract:

| Field | Required | Notes |
| --- | --- | --- |
| `description` | — | Must be **absent**; injected from the canonical `SKILL.md` |
| `disable-model-invocation` | optional | Boolean — opt out of automatic invocation |
| `allowed-tools` | optional | Comma-separated tool list |
| `argument-hint` | optional | Display hint for `/skill-name <hint>` |
| `user-invocable` | optional | `false` for reference-only skills |

`name` is derived from the directory and must not appear in companion frontmatter.

### Adapter-specific sidecars

Any non-`SKILL.*` file under a skill directory is copied verbatim into each adapter payload that ships the skill (e.g. `review/perspectives/<axis>.md`). This is also the extension point for adapter-native config: a Codex skill can carry `agents/openai.yaml` (approval policy / implicit-invocation control) and it rides along to `.agents/skills/{name}/agents/openai.yaml`, which Codex reads and the other tools ignore. No skill in this repo uses one yet.

Build-control frontmatter (`adapters`) is stripped from every emitted `SKILL.md` — it never reaches consumer payloads.

### Adapter gating

A skill may restrict which adapters emit it via an optional `adapters` frontmatter field — the per-skill counterpart of `src/agents/` being Claude Code only. This is for skills that depend on a single agent's runtime (e.g. `usage-guard` needs Claude Code's OAuth usage endpoint + `ScheduleWakeup`) and must not ship to the others.

Because the SKILL.md frontmatter parser is a flat, string-only subset of YAML (no arrays), `adapters` is a **comma-separated string**, not a YAML array:

```yaml
adapters: claude-code               # claude-code only
adapters: claude-code, codex-cli    # both
```

When the field is absent, the skill is emitted by every adapter (the default). Known ids: `claude-code`, `codex-cli`, `gemini-cli`, `copilot`; an unknown id fails the build. Gating applies to the shipped `dist/{adapter-id}/` payloads (an `adapters: claude-code` skill is excluded from `dist/codex-cli`, `dist/gemini-cli`, `dist/copilot`) and the aggregate listings. Note: since `.agents/skills/` is the SSOT that Codex/Gemini read directly in-repo, a `claude-code`-gated skill (e.g. `usage-guard`) still physically lives there — it is an inert no-op for non-Claude tools; gating is what keeps it out of their shipped payloads.

## Local development

```bash
pnpm install
pnpm build         # regenerate dist/
pnpm test          # adapter unit + integration tests
pnpm lint:all
```

`dist/` is committed and the CI verifies it matches `pnpm build` output. After editing any `.agents/skills/*/SKILL.md` or `.agents/skills/*/SKILL.claude-code.md`, run `pnpm build` and commit the resulting `dist/` changes.

Verifying the `usage-guard` skill: the deterministic signal runs in CI (`tests/usage-guard-integration.test.mjs`); the live `ScheduleWakeup` pause/resume is driven manually via `scripts/usage-guard-smoke.mjs`. See [docs/usage-guard-verification.md](docs/usage-guard-verification.md).

## Release flow (maintainer)

`@ozzylabs/skills` is published to npm via [release-please](https://github.com/googleapis/release-please) + OIDC [Trusted Publishers](https://docs.npmjs.com/trusted-publishers). The full pipeline lives in `.github/workflows/release.yaml`:

1. **Commits to `main`**: Conventional Commits (`feat:` / `fix:` / `feat!:` etc.) drive the version bump.
2. **Release PR**: `release-please` opens / updates an automated PR that bumps `version` in `package.json` and `.release-please-manifest.json`, and updates `CHANGELOG.md`. Maintainers review and squash-merge it.
3. **Tag + GitHub Release**: merging the release PR creates a `v<x.y.z>` tag and a GitHub Release.
4. **`npm publish --provenance`**: the `publish` job runs `pnpm install --frozen-lockfile` → `pnpm build` → `npm publish --provenance --access public`. Authentication is OIDC-only — no `NPM_TOKEN` secret. The job sets `permissions: { id-token: write, contents: read }` so npm can verify the GitHub Actions OIDC token against the trusted publisher mapping configured at <https://www.npmjs.com/package/@ozzylabs/skills/access>.

### npm payload contents

The npm payload is declared in `package.json#files` and verified by `tests/npm-pack-payload.test.mjs`:

- `dist/{adapter-id}/` — canonical per-adapter outputs that consumers read (`claude-code`, `codex-cli`, `gemini-cli`, `copilot`)
- `dist/sync/replace-snippet.sh` — snippet sync helper
- `bin/install.mjs` — CLI installer entry point (see [issue #98](https://github.com/ozzy-labs/skills/issues/98))
- `schemas/` — sync-target schemas
- `README.md`, `LICENSE`, `action.yaml`

In-repo dogfood mirrors (`.agents/skills/`, `.claude/skills/`, `.claude/agents/`) and source layout (`src/`, `scripts/`, `tests/`) are intentionally excluded.

### Trusted Publishers setup

The OIDC trust relationship is configured once at the npm registry:

- Package: `@ozzylabs/skills`
- Workflow: `.github/workflows/release.yaml`
- Repository: `ozzy-labs/skills`
- Environment: (none)

See the official [npm Trusted Publishers documentation](https://docs.npmjs.com/trusted-publishers) for the management UI walkthrough.

## Conventions

- Commits: [Conventional Commits](https://www.conventionalcommits.org/) (`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`)
- Branches: `<type>/<short-description>` (e.g. `feat/add-debug-skill`)
- PRs: squash merge only, title in Conventional Commits format

## License

[MIT](./LICENSE)
