---
name: compatibility
category: design
description: Backward compatibility, schema changes, consumer impact via commons-sync
applies_when: ["src/**", "scripts/**", "dist/**", "package.json", "**/*.json", "**/*.yaml", "**/*.yml", "**/SKILL.md"]
skip_when: { diff_only_in: ["tests/**", "**/*.test.*"] }
default_enabled: true
severity_rules: { critical: "既存コンシューマが破壊される非互換変更 (rename / 削除 / 型変更) で migration path や CHANGELOG への記載がない", warning: "互換性は保てるがコンシューマ側で対応が必要、または default 変更で挙動が変わる", info: "より丁寧な deprecation の提案、注意喚起" }
exit_criteria: { drive_loop: { critical: 0, warning: 0 } }
---

# compatibility — Compatibility

## Inspection items

- **Backward compatibility**: removal/renaming of public API / CLI flags / skill arguments, impact on existing users from default value changes
- **Schema changes**: field removal / type changes in SKILL.md frontmatter / config files / JSON schema
- **Consumer impact via commons-sync**: whether changes to the `dist/` output structure break consumers' sync
- **agent / adapter API**: changes to the `AdapterBase.generate()` signature, adding required fields to the `Skill` type
- **package.json**: dependency / engines compatibility, major bump
- **legacy resume compatibility**: read compatibility with existing PR comments, existing lock / state files, etc.
- **version migration**: whether changes that increment the schema version provide fallback handling on the reader side

## Severity guide

- **critical**: a breaking change (rename / removal / type change) that breaks existing consumers, with no migration path or CHANGELOG entry
- **warning**: compatibility is maintained but requires consumer-side adaptation, or behavior changes due to a default value change
- **info**: suggestions for more careful deprecation, cautionary notes

## skip_when

The compatibility perspective does not apply to test-only changes.

## exit_criteria.drive_loop

```yaml
exit_criteria:
  drive_loop:
    critical: 0
    warning: 0
```

Do not judge as merge-ready while a breaking change remains unaddressed.
