---
name: conventions
category: required
description: Repository conventions such as Conventional Commits, lint, file naming, and `.yaml` unification
applies_when: ["**/*"]
default_enabled: true
severity_rules: { critical: "コミット / PR タイトルが Conventional Commits 違反 (commitlint で fail)、main への直接 push、--no-verify 利用", warning: "lint / formatter 違反、命名規約違反、.yaml / .yml 不整合", info: "より明示的な書き方への改善提案、命名の細かな統一" }
exit_criteria: { drive_loop: { critical: 0, warning: 0 } }
---

# conventions — Coding conventions

## Inspection items

- **Conventional Commits**: format of type / scope / description, marking breaking changes with `!`
- **Branch naming**: `<type>/<short-description>` format
- **File naming / placement**: consistency with existing patterns (`SKILL.md` / `SKILL.<adapter>.md`, `perspectives/<axis>.md`, etc.)
- **YAML extension**: whether it is unified as `.yaml` (allowed as `.yml` only when a tool requires it)
- **lint / formatter**: whether it violates the output of biome / markdownlint / yamllint / shellcheck / shfmt, etc.
- **import / export conventions**: ESM / CJS unification, explicit file extensions
- **CLAUDE.md / AGENTS.md**: whether it violates the project rules documented there
- **Per-language conventions**: language-specific conventions defined in tools/lint-rules.md, etc.

## Severity guide

- **critical**: commit / PR title violates Conventional Commits (fails commitlint), direct push to `main`, use of `--no-verify`
- **warning**: lint / formatter violations, naming convention violations, `.yaml` / `.yml` inconsistency
- **info**: suggestions for more explicit code, minor naming unification

## skip_when

```yaml
skip_when:
  diff_only_in: []
```

Always applied because this is a `required` perspective.

## exit_criteria.drive_loop

```yaml
exit_criteria:
  drive_loop:
    critical: 0
    warning: 0
```

Do not judge as merge-ready while convention violations remain.
