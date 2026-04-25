English | [日本語](README.ja.md)

# @ozzylabs/skills

Canonical OzzyLabs agent skill bundle for Claude Code, GitHub Copilot, Gemini CLI, and Codex CLI.

`src/skills/{name}/SKILL.md` is the single source of truth. `pnpm build` produces `dist/.agents/skills/{name}/SKILL.md`, which consumer repositories pull in via Renovate auto-sync (or, optionally, via `npm install`).

This package backs the [OzzyLabs handbook ADR-0016](https://github.com/ozzy-labs/handbook/blob/main/adr/0016-create-skills-repo.md) decision to extract skills out of the `commons` repository into their own SSOT, while preserving the [ADR-0002](https://github.com/ozzy-labs/handbook/blob/main/adr/0002-skills-distribution-via-renovate.md) Renovate-based distribution model.

## Skills in v0.x

The 10 common skills shared across all OzzyLabs repositories:

| Skill | Description |
| --- | --- |
| `commit` | Stage changes and create a Conventional Commit |
| `commit-conventions` | Commit / branch / PR naming conventions |
| `drive` | Issue → merge-ready PR autonomous loop |
| `implement` | Branch creation and implementation from an issue or instructions |
| `lint` | Run all linters with auto-fix |
| `lint-rules` | Lint configuration reference |
| `pr` | Push changes and open or update a PR |
| `review` | Review code changes or pull requests |
| `ship` | Lint + commit + PR creation in one go |
| `test` | Run build, tests, and type checks |

Repo-specific skills (e.g. `road`'s `improve-loop` / `road-repo-context`) are intentionally not included in this package.

## Consumer setup

Add the Renovate preset to your repository's `renovate.json`:

```json
{
  "extends": [
    "github>ozzy-labs/skills//skills-sync"
  ]
}
```

Track the upstream digest in `.dev-config/sync.yaml`:

```yaml
skills_commit: <40-char SHA from main>
```

Renovate detects updates to `ozzy-labs/skills@main` and opens a PR bumping `skills_commit`. The accompanying `sync.sh` (provided by [ozzy-labs/commons](https://github.com/ozzy-labs/commons)) copies `dist/.agents/skills/` from this repository into the consumer's `.agents/skills/`.

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

## Conventions

- Commits: [Conventional Commits](https://www.conventionalcommits.org/) (`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`)
- Branches: `<type>/<short-description>` (e.g. `feat/add-debug-skill`)
- PRs: squash merge only, title in Conventional Commits format

## License

[MIT](./LICENSE)
