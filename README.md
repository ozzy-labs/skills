English | [日本語](docs/README.ja.md)

# @ozzylabs/skills

Canonical OzzyLabs agent skill bundle for Claude Code, GitHub Copilot, Gemini CLI, and Codex CLI.

`src/skills/{name}/SKILL.md` is the single source of truth. `pnpm build` produces per-agent outputs under `dist/{adapter-id}/` (`claude-code`, `codex-cli`, `gemini-cli`, `copilot`). Consumer repositories pull these in via the push-mode `/sync-consumers` flow (or, optionally, via `npm install`).

This package backs the [OzzyLabs handbook ADR-0016](https://github.com/ozzy-labs/handbook/blob/main/adr/0016-create-skills-repo.md) decision to extract skills out of the `commons` repository into their own SSOT, while preserving the [ADR-0002](https://github.com/ozzy-labs/handbook/blob/main/adr/0002-skills-distribution-via-renovate.md) Renovate-based distribution model.

## Skills in v0.x

The 13 common skills shared across all OzzyLabs repositories:

| Skill | Description |
| --- | --- |
| `commit` | Stage changes and create a Conventional Commit |
| `commit-conventions` | Commit / branch / PR naming conventions |
| `drive` | Issue → merge-ready PR autonomous loop |
| `health` | Inspect repo state and skill catalog consistency across 16 areas with inline recommended actions (`--deep` for follow-up investigation of `要確認` items) |
| `implement` | Branch creation and implementation from an issue or instructions |
| `lint` | Run all linters with auto-fix |
| `lint-rules` | Lint configuration reference |
| `pr` | Push changes and open or update a PR |
| `review` | Review code changes or PRs across 11 perspectives (correctness / security / conventions / architecture / compatibility / maintainability / testing / performance / observability / usability / documentation). Emits a JSON-structured payload alongside the human-readable comment so `drive` can terminate its loop deterministically. `--axes` overrides the auto-selection; `--deep` fans out per-axis subagents (Claude Code only) |
| `ship` | Lint + commit + PR creation in one go |
| `sync-consumers` | Push skills/commons updates to the 14 consumer repos declared in `sync-targets.yaml` in parallel (drive-derived). Reuses drive's Phase Final-1 worktree drift detection and Phase Final-2 cleanup; ships with an extra axis 7 (subagent worktree holding `refs/heads/main`) and a mandatory `cd <parent-worktree-root>` before each `git worktree remove`. `--dry-run` / `--filter <repo,repo>` / `--merge` |
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

Supported adapters: `claude-code` (default), `codex-cli`, `gemini-cli`, `copilot`. The output path mirrors what the build pipeline writes under `dist/{adapter-id}/`, transplanted onto `$HOME`. Project-scoped install flags (`--target` etc.) are not supported and never will be — use the `/sync-consumers` flow if you need per-repo mirrors.

### Migrating off the legacy project-scoped layout

For repos that previously consumed the generic skills via the Renovate-based `/sync-consumers` flow, the migrate subcommand removes the now-redundant project-scoped copies:

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

Track the upstream digest in `.commons/sync.yaml`:

```yaml
skills_commit: <40-char SHA from main>
skills_adapters:
  - claude-code
  - codex-cli
  - gemini-cli
  - copilot
```

Updates are pushed from `ozzy-labs/skills` via the `/sync-consumers` skill (see [issue #80](https://github.com/ozzy-labs/skills/issues/80)). When this repo's `main` advances, a maintainer runs `/sync-consumers --source=skills --auto-merge`, which opens one sync PR per consumer (driven by `commons/scripts/sync-consumers.sh`). The PR bumps `skills_commit` in `.commons/sync.yaml` and runs `sync-skills.sh -y` (from [ozzy-labs/commons](https://github.com/ozzy-labs/commons)) to copy the opted-in adapter outputs (`dist/{adapter-id}/`) from this repository into the consumer.

### Adapter opt-in (per-agent outputs)

To consume per-agent adapter outputs (`dist/{adapter-id}/`), list the adapter ids in `skills_adapters` (shown above). Adapter ids and the corresponding output paths:

| Adapter id | Adapter output |
| --- | --- |
| `claude-code` | `dist/claude-code/.claude/skills/{name}/SKILL.md` |
| `codex-cli` | `dist/codex-cli/.agents/skills/{name}/SKILL.md` + `AGENTS.md.snippet` |
| `gemini-cli` | `dist/gemini-cli/.gemini/settings.json` + `AGENTS.md.snippet` |
| `copilot` | `dist/copilot/.github/copilot-instructions.md.snippet` |

Adapter opt-in is non-breaking and additive — list only the adapters you actually sync. The file copy on the consumer side is driven by `commons/sync-skills.sh` per consumer's `skills_adapters` declaration.

### Legacy Renovate preset (removed)

Earlier versions of this repo shipped a `skills-sync/` Renovate preset (`extends: ["github>ozzy-labs/skills//skills-sync"]`). The preset was removed in [issue #80](https://github.com/ozzy-labs/skills/issues/80) Step 4 in favor of the push-mode `/sync-consumers` flow described above. Existing consumers should remove the `extends` reference from their `renovate.json` (see Step 3 of the transition for the consumer-side cleanup PRs).

### Snippet sync helper

`dist/sync/replace-snippet.sh` is shipped as a drop-in helper for downstream sync workflows that merge snippet files (`AGENTS.md.snippet`, `copilot-instructions.md.snippet`) into consumer-owned files:

```bash
.sync-skills/dist/sync/replace-snippet.sh \
  AGENTS.md \
  .sync-skills/dist/codex-cli/AGENTS.md.snippet
```

Behavior:

- Target contains the begin marker → replace the marker block (begin..end inclusive) with the snippet contents.
- Target is missing the marker (e.g. another sync — typically `commons` — overwrote the file and stripped the managed region) → append the snippet to the end of the file. The snippet itself carries the markers, so the next run resumes in-place replacement.
- Target file does not exist → create it from the snippet.

This auto-recovery removes the need for downstream workflows to carry their own marker-handling logic and avoids hard failures when ownership of a shared file like `.github/copilot-instructions.md` shifts between sync sources.

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
