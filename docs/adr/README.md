# Architecture Decision Records (skills project)

Project-internal architecture and design decisions for `ozzy-labs/skills`, one file per decision.

Format is based on [MADR](https://adr.github.io/madr/) and mirrors the handbook ADR conventions ([`ozzy-labs/handbook/adr/`](https://github.com/ozzy-labs/handbook/tree/main/adr)).

## The 2-tier ADR structure

OzzyLabs runs ADRs in two tiers ([`handbook/conventions/project-docs-layout.md`](https://github.com/ozzy-labs/handbook/blob/main/conventions/project-docs-layout.md)):

- **handbook ADR** ([`handbook/adr/`](https://github.com/ozzy-labs/handbook/tree/main/adr)) — **cross-repo policy only**: decisions that affect more than one repo (npm scope, skills distribution, agent adapter architecture, the skills authoring/policy/catalog architecture in [ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md)).
- **project ADR** (this directory) — **a single project's internal design judgment**: decisions scoped to `ozzy-labs/skills` alone.

Decision rule: *does this affect other repos?* Yes → handbook ADR; No → project ADR. A project ADR later found to be cross-repo is migrated to the handbook (the project entry then becomes `Superseded by handbook/adr/NNNN-{slug}`).

Numbering is **independent** between the two tiers — this project starts at `0001` even though the handbook is well past it.

## Index

| # | Title | Status | Date |
| --- | --- | --- | --- |
| [0001](./0001-observability-measurement-design.md) | Observability measurement design | Accepted | 2026-07-03 |

## How to add a new ADR

1. Copy the handbook [`template.md`](https://github.com/ozzy-labs/handbook/blob/main/adr/template.md) to `NNNN-{slug}.md` with the next available 4-digit number.
2. Fill in Status / Context / Decision / Consequences / Alternatives / References.
3. Commit on a feature branch with message `docs(adr): add project ADR-NNNN about {slug}`.
4. Open a PR for review.
5. When merged, update this index (Index row + Status if changed).

### Numbering

- 4-digit zero-padded sequential: `0001`, `0042`, `0123`.
- Next number = max existing number + 1.
- Numbers are **never reused** even if an ADR is deprecated or superseded.
- Independent from the handbook's numbering (§ The 2-tier ADR structure).

### Slug

- kebab-case, concise, reflects the decision topic.
- Examples: `observability-measurement-design`.

## Status lifecycle

- **Proposed** — Under discussion. No commitment yet.
- **Accepted** — Decision made and being followed.
- **Superseded by [ADR-NNNN](./NNNN-{slug}.md)** — Replaced by a later decision (or by a handbook ADR when migrated cross-repo). Keep the original for historical context.
- **Deprecated** — No longer in effect, not yet replaced.

## Writing style

- Lead with Context (the forces at play), then Decision, then Consequences.
- Record Alternatives considered — future readers need to see what was rejected and why.
- Prefer concrete references over prose: link to issues, PRs, or the implementation files the decision governs.
- Keep each ADR under ~200 lines. If it grows beyond that, the decision is probably multiple decisions.

## Placeholder convention

In prose use `{xxx}` for placeholders (e.g. `{slug}`). Do not use `<xxx>` in plain text — markdownlint MD033 flags it as inline HTML. Inside code spans (`` `<xxx>` ``) either form is fine.
