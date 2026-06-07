English | [日本語](docs/README.ja.md)

# @ozzylabs/skills

Canonical OzzyLabs agent skill bundle for Claude Code, GitHub Copilot, Gemini CLI, and Codex CLI.

`src/skills/{name}/SKILL.md` is the single source of truth. `pnpm build` produces per-agent outputs under `dist/{adapter-id}/` (`claude-code`, `codex-cli`, `gemini-cli`, `copilot`). End users install these skills as **user skills** (e.g. `~/.claude/skills/`) via the CLI installer shipped in the npm package.

This package backs the [OzzyLabs handbook ADR-0016](https://github.com/ozzy-labs/handbook/blob/main/adr/0016-create-skills-repo.md) decision to extract skills out of the `commons` repository into their own SSOT. Distribution is **user skills only** (see handbook ADR-0027, in preparation): consumers install via `npx @ozzylabs/skills install`, and project-scope skills (`.claude/skills/` under each consumer repo) are no longer pushed. Project-scope skills remain in use only inside the `skills` / `commons` repos themselves for dogfooding, where the build pipeline emits them from the SSOT.

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
| `codex-cli` | `~/.codex/agents/skills/{name}/SKILL.md` + `AGENTS.md.snippet` merge |
| `gemini-cli` | `~/.gemini/settings.json` merge + `AGENTS.md.snippet` merge |
| `copilot` | `~/.github/copilot-instructions.md` snippet merge |

See `npx @ozzylabs/skills install --help` for the full list of options and the exact target paths.

### Using the skills in CI

A reusable GitHub Action that runs `npx @ozzylabs/skills install` on the runner is planned (see [issue #101](https://github.com/ozzy-labs/skills/issues/101)). Until it lands, invoke the CLI directly from a step:

```yaml
- name: Install OzzyLabs skills
  run: npx --yes @ozzylabs/skills install --adapter claude-code
```

### Migrating from the legacy push-mode flow

Consumers that previously consumed skills as **project skills** via the push-mode `/sync-consumers` flow (`dist/{adapter-id}/` copied into `.claude/skills/` etc.) need to migrate to user skills only. A migration guide and a pilot rollout are planned in [issue #100](https://github.com/ozzy-labs/skills/issues/100); the short version is:

1. Remove `.claude/skills/`, `.agents/skills/`, and equivalent in-repo skill mirrors.
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
