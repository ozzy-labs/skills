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

## Local development

```bash
pnpm install
pnpm build         # regenerate dist/
pnpm lint:all
```

`dist/` is committed and the CI verifies it matches `pnpm build` output. After editing any `src/skills/*/SKILL.md`, run `pnpm build` and commit the resulting `dist/` changes.

## Conventions

- Commits: [Conventional Commits](https://www.conventionalcommits.org/) (`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`)
- Branches: `<type>/<short-description>` (e.g. `feat/add-debug-skill`)
- PRs: squash merge only, title in Conventional Commits format

## License

[MIT](./LICENSE)
