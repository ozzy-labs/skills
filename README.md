English | [日本語](docs/README.ja.md)

# @ozzylabs/skills

Canonical OzzyLabs agent skill bundle for Claude Code, GitHub Copilot, Gemini CLI, and Codex CLI.

`src/skills/{name}/SKILL.md` is the single source of truth. `pnpm build` produces per-agent outputs under `dist/{adapter-id}/` (`claude-code`, `codex-cli`, `gemini-cli`, `copilot`). End users install these skills as **user skills** (e.g. `~/.claude/skills/`) via the CLI installer shipped in the npm package.

This package backs the [OzzyLabs handbook ADR-0016](https://github.com/ozzy-labs/handbook/blob/main/adr/0016-create-skills-repo.md) decision to extract skills out of the `commons` repository into their own SSOT. Distribution is **user skills by default** (see handbook ADR-0027, in preparation): consumers install via `npx @ozzylabs/skills install`, and project-scope skills (`.claude/skills/` under each consumer repo) are no longer pushed automatically. The supported exception is **Claude mobile / web (cloud) sessions**, which run "repo only" and never see `~/.claude/skills/`: for repos developed that way, `npx @ozzylabs/skills sync-project --target <repo>` opts in to a relative-ref project-scope payload (`dist/claude-code-project/`) — see [Project-scope sync](#project-scope-sync-for-claude-mobile--web-cloud) below. Project-scope skills otherwise remain in use only inside the `skills` / `commons` repos themselves for dogfooding, where the build pipeline emits them from the SSOT.

## Skills in v0.x

14 skills total: 11 generic workflow skills shared across all OzzyLabs repositories, plus 3 internal-use skills (`health`, `topics`, `phase-issue`) bundled in the package. Only the 10 original generic skills are subject to `npx @ozzylabs/skills migrate` when removing the legacy project-scoped layout (`lessons-triage` was never distributed project-scoped).

| Skill | Description |
| --- | --- |
| `commit` | Stage changes and create a Conventional Commit |
| `commit-conventions` | Commit / branch / PR naming conventions |
| `drive` | Issue → merge-ready PR autonomous loop |
| `health` | Inspect repo state and skill catalog consistency across 16 areas with inline recommended actions (`--deep` for follow-up investigation of `要確認` items) |
| `implement` | Branch creation and implementation from an issue or instructions |
| `lint` | Run all linters with auto-fix |
| `lessons-triage` | Triage the session-lessons queue (`~/.agents/lessons/queue.jsonl`, filled by the dotfiles `lesson-capture.sh` hook): extract User-Skills improvement lessons from session transcripts and file approved ones as issues on ozzy-labs/skills. HITL — every issue requires per-item approval; no repo edits, no auto-apply |
| `lint-rules` | Lint configuration reference |
| `pr` | Push changes and open or update a PR |
| `review` | Review code changes or PRs across 11 perspectives (correctness / security / conventions / architecture / compatibility / maintainability / testing / performance / observability / usability / documentation). Emits a JSON-structured payload alongside the human-readable comment so `drive` can terminate its loop deterministically. `--axes` overrides the auto-selection; `--deep` fans out per-axis subagents (Claude Code only) |
| `ship` | Lint + commit + PR creation in one go |
| `test` | Run build, tests, and type checks |
| `topics` | Research-driven GitHub topics setup (ozzy-labs scope): validate official constraints (lowercase / hyphen / 50 chars / max 20), measure popularity via `gh api search/repositories` with session-scoped cache, decide broad+narrow / singular-plural pairs, and apply ozzy-labs hardcoded conventions (`claude-code` exception, `*-cli` suffix removal, `multi-agent` canonical form). `--apply` to commit, `--dry-run` for analysis only |

Repo-specific skills (e.g. `road`'s `improve-loop` / `road-repo-context`) are intentionally not included in this package.

## CLI installer (user-scoped)

The `@ozzylabs/skills` package ships a CLI that installs the canonical skill bundle into the user-scoped skills directory (always under `$HOME` — there is intentionally no project-scoped target):

```bash
# Install every skill into ~/.claude/skills/ (Claude Code, default adapter)
npx @ozzylabs/skills install

# Install a subset into ~/.agents/skills/ (Codex CLI)
npx @ozzylabs/skills install --adapter=codex-cli --skills=drive,review

# Dry-run: print the JSON plan and do nothing
npx @ozzylabs/skills install --skills=drive --dry-run

# Overwrite skills that are already installed
npx @ozzylabs/skills install --upgrade

# Skip the interactive overwrite prompt (e.g. CI)
npx @ozzylabs/skills install --force
```

Supported adapters: `claude-code` (default), `codex-cli`, `gemini-cli`, `copilot`. The output path mirrors what the build pipeline writes under `dist/{adapter-id}/`, transplanted onto `$HOME`. The `install` subcommand has no project-scoped target — `~/.claude/skills/` is the only target it writes to. To deliver skills at **project scope** (the Claude mobile / web cloud case), use the separate `sync-project` subcommand described next.

### Project-scope sync for Claude mobile / web (cloud)

Claude mobile / web (cloud) sessions run "repo only": they discover skills from a consumer repo's committed `.claude/skills/` but never from `~/.claude/skills/`, so `install` (user scope) does not reach them. The per-adapter `dist/{adapter-id}/` payloads also can't be committed as-is — their skill refs are rewritten to `~/.agents/skills/…`, which resolves against an empty `$HOME` in the cloud VM.

`sync-project` is the opt-in project-scope path. It copies `dist/claude-code-project/` — where refs stay **repo-root-relative** and the canonical `.agents/skills/<name>/SKILL.md` files the Claude Code wrappers `Read` are shipped alongside the `.claude/skills/` wrappers (plus `.claude/agents/`) — into a target repo:

```bash
# Sync every skill into ./my-repo (writes .claude/skills/, .agents/skills/, .claude/agents/)
npx @ozzylabs/skills sync-project --target=./my-repo

# Sync just the /drive workflow set (drive depends on the others — keep them together)
npx @ozzylabs/skills sync-project --target=./my-repo \
  --skills=drive,implement,ship,review,commit,pr,lint,test,commit-conventions,lint-rules

# Preview the plan as JSON without writing
npx @ozzylabs/skills sync-project --target=./my-repo --dry-run
```

`--target` is required; there is no implicit default. The command writes files only — review the diff and commit them in the target repo so the cloud session picks them up. Use this only for repos you actually develop via the Claude mobile / web app; everywhere else, user-scope `install` remains the norm.

### Migrating off the legacy project-scoped layout

For repos that previously consumed the generic skills via the legacy Renovate / push-mode sync flow, the migrate subcommand removes the now-redundant project-scoped copies:

```bash
# Preview the cleanup plan
npx @ozzylabs/skills migrate --dry-run

# Apply the cleanup (removes the 10 generic skills under .claude/skills/ and
# .agents/skills/, and strips skills_adapters / skills_commit from
# .commons/sync.yaml). Pass --keep-sync-yaml to leave the YAML untouched.
npx @ozzylabs/skills migrate --force
```

Repo-local skills (anything outside the documented generic 10) are left untouched.

## Consumer setup

Install the skills as **user skills** with a single command:

```bash
npx @ozzylabs/skills install
```

This drops the canonical skills into your user-scope skill directory (e.g. `~/.claude/skills/{name}/SKILL.md` for Claude Code) so every project on the machine can use them without per-repo configuration.

### Adapter opt-in

By default the installer writes the Claude Code adapter output. Pass `--adapter` (repeatable) to opt into additional agents:

```bash
npx @ozzylabs/skills install --adapter claude-code --adapter codex-cli
```

| Adapter id | User-scope install target |
| --- | --- |
| `claude-code` | `~/.claude/skills/{name}/SKILL.md` |
| `codex-cli` | `~/.agents/skills/{name}/SKILL.md` + `AGENTS.md.snippet` merge |
| `gemini-cli` | `~/.gemini/settings.json` merge + `AGENTS.md.snippet` merge |
| `copilot` | `~/.github/copilot-instructions.md` snippet merge |

See `npx @ozzylabs/skills install --help` for the full list of options and the exact target paths.

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

1. Remove `.claude/skills/`, `.agents/skills/`, and equivalent in-repo skill mirrors (or run `npx @ozzylabs/skills migrate`).
2. Drop `skills_commit` / `skills_adapters` from `.commons/sync.yaml`.
3. Have each contributor run `npx @ozzylabs/skills install` once on their machine.

## Adapter outputs

`pnpm build` runs each per-agent adapter under `scripts/adapters/` and writes the result to `dist/{adapter-id}/`:

| Adapter | Output | Source |
| --- | --- | --- |
| `claude-code` | `dist/claude-code/.claude/skills/{name}/SKILL.md` | `SKILL.claude-code.md` if present, else canonical `SKILL.md` |
| `codex-cli` | `dist/codex-cli/.agents/skills/{name}/SKILL.md` + `AGENTS.md.snippet` | canonical `SKILL.md` |
| `gemini-cli` | `dist/gemini-cli/.gemini/settings.json` + `AGENTS.md.snippet` | canonical `SKILL.md` |
| `copilot` | `dist/copilot/.github/copilot-instructions.md.snippet` | canonical `SKILL.md` |

### Claude Code companion file

A skill may ship `src/skills/{name}/SKILL.claude-code.md` alongside the canonical `SKILL.md`. The Claude Code adapter emits the companion verbatim when present, so each skill can carry a Claude-Code-specific wrapper (next-action `AskUserQuestion` menus, `argument-hint`, `disable-model-invocation`, `allowed-tools`, etc.) without polluting the canonical `SKILL.md` other adapters consume.

Companion frontmatter contract:

| Field | Required | Notes |
| --- | --- | --- |
| `description` | yes | May be a Claude-Code-tailored shortening of canonical `description` |
| `disable-model-invocation` | optional | Boolean — opt out of automatic invocation |
| `allowed-tools` | optional | Comma-separated tool list |
| `argument-hint` | optional | Display hint for `/skill-name <hint>` |
| `user-invocable` | optional | `false` for reference-only skills |

`name` is derived from the directory and must not appear in companion frontmatter.

### Adapter gating

A skill may restrict which adapters emit it via an optional `adapters` frontmatter field — the per-skill counterpart of `src/agents/` being Claude Code only. This is for skills that depend on a single agent's runtime (e.g. `usage-guard` needs Claude Code's OAuth usage endpoint + `ScheduleWakeup`) and must not ship to the others.

Because the SKILL.md frontmatter parser is a flat, string-only subset of YAML (no arrays), `adapters` is a **comma-separated string**, not a YAML array:

```yaml
adapters: claude-code               # claude-code only
adapters: claude-code, codex-cli    # both
```

When the field is absent, the skill is emitted by every adapter (the default). Known ids: `claude-code`, `codex-cli`, `gemini-cli`, `copilot`; an unknown id fails the build. Gating applies uniformly to per-skill outputs, the Gemini CLI / Copilot aggregate listings, the project-scope payload (`dist/claude-code-project/`), and the in-repo dogfood mirrors (an `adapters: claude-code` skill is kept out of `.agents/skills/`).

## Local development

```bash
pnpm install
pnpm build         # regenerate dist/
pnpm test          # adapter unit + integration tests
pnpm lint:all
```

`dist/` is committed and the CI verifies it matches `pnpm build` output. After editing any `src/skills/*/SKILL.md` or `src/skills/*/SKILL.claude-code.md`, run `pnpm build` and commit the resulting `dist/` changes.

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

In-repo dogfood mirrors (`.agents/skills/`, `.claude/skills/`) and source layout (`src/`, `scripts/`, `tests/`) are intentionally excluded.

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
