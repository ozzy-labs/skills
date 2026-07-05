---
name: maintainability
category: design
description: Naming, complexity, dead code, comment debt
applies_when: ["src/**", "scripts/**", "**/*.ts", "**/*.tsx", "**/*.mjs", "**/*.js", "**/*.py", "**/*.sh"]
skip_when: { diff_only_in: ["**/*.md", "docs/**", "**/*.yaml", "**/*.yml", "**/*.json"] }
default_enabled: true
severity_rules: { critical: "取り返しのつかない命名 / 構造の選択 (公開 API として固定される名称等)", warning: "顕著な dead code、過剰な複雑度、誤解を招く命名、明らかな重複", info: "命名の細かな改善、コメント整理、軽微なリファクタ提案" }
exit_criteria: { drive_loop: { critical: 0 } }
---

# maintainability — Maintainability

## Review Criteria

- **Naming**: Whether identifier intent is conveyed, whether there is misleading naming, unnecessary abbreviations
- **Complexity**: Functions / methods that are excessively long, nesting that is too deep, branch explosion, cyclomatic complexity
- **Dead code**: Unused exports / functions / variables / imports, commented-out code
- **Comment debt**: Redundant comments that explain WHAT, stale comments, neglected TODO / FIXME
- **Duplication**: Logic that appears in 3 or more places, or signs of copy-paste
- **Testability**: Excessive hiding, designs that depend on side effects, dependency injection that is hard to test
- **Documentation**: Whether public APIs / skills / agents have at least minimal explanation

## Severity Guide

- **critical**: Irreversible naming / structural choices (e.g. names that become fixed as a public API)
- **warning**: Notable dead code, excessive complexity, misleading naming, obvious duplication
- **info**: Minor naming improvements, comment cleanup, minor refactor suggestions

## skip_when

The maintainability perspective does not apply to changes that are only to documentation / config files.

## exit_criteria.drive_loop

```yaml
exit_criteria:
  drive_loop:
    critical: 0
```

Maintainability warnings are permitted (subject to continued improvement after merge). critical blocks.
