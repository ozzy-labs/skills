---
name: architecture
category: design
description: Layering, responsibility placement, level of abstraction, consistency with existing patterns
applies_when: ["src/**", "scripts/**", "**/*.ts", "**/*.tsx", "**/*.mjs", "**/*.js", "**/*.py"]
skip_when: { diff_only_in: ["**/*.md", "docs/**", "**/*.yaml", "**/*.yml", "**/*.json"] }
default_enabled: true
severity_rules: { critical: "既存アーキテクチャ判断 (ADR 等) に明確に反する、取り返しがつかない構造変更", warning: "責務違反、循環依存、既存パターンを破る無理筋、保守性を著しく下げる構造", info: "より良い分離・命名・抽象度の提案、リファクタリング候補" }
exit_criteria: { drive_loop: { critical: 0, warning: 0 } }
---

# architecture — Architecture

## Inspection items

- **Layering**: whether higher layers reference lower layers, whether there are circular dependencies
- **Responsibility placement**: whether each module / function has a clear responsibility without excessive bloat
- **Abstraction level**: appropriate level of abstraction, unnecessary abstraction / premature optimization, missing abstraction
- **Consistency with existing patterns**: whether it follows existing repository patterns such as adapter / skill / agent, whether ad-hoc patterns are proliferating
- **Data flow**: direction of input/output, contamination by global state, deliberate maintenance of purity
- **Extensibility**: future insertion points, over-installing extension points (YAGNI)
- **Explicit boundaries**: whether the boundaries between module / package / internal API / external API are made explicit

## Severity guide

- **critical**: structural changes that clearly contradict an existing architectural decision (ADR, etc.) and are irreversible
- **warning**: responsibility violations, circular dependencies, forcing a break from existing patterns, structures that significantly reduce maintainability
- **info**: suggestions for better separation / naming / abstraction level, refactoring candidates

## skip_when

The architecture perspective does not apply to changes limited to documentation / config files.

## exit_criteria.drive_loop

```yaml
exit_criteria:
  drive_loop:
    critical: 0
    warning: 0
```

Do not judge as merge-ready while design-level critical / warning issues remain.
