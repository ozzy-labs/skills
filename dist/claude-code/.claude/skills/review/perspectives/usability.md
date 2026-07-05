---
name: usability
category: ux
description: CLI wording, error messages, skill argument-hint, README immediate comprehensibility
applies_when: ["src/**", "**/*.md", "**/SKILL.md", "**/*.ts", "**/*.tsx", "**/*.mjs", "**/*.js", "**/*.py", "**/*.sh"]
skip_when: { diff_only_in: ["tests/**", "**/*.test.*"] }
default_enabled: true
severity_rules: { critical: "ユーザーが詰まる致命的な UX 不備 (無限ループ的な確認、復旧不可能な操作の無確認実行)", warning: "紛らわしいメッセージ、誤解を招く CLI 文言、argument-hint の欠落", info: "より親切な文言、説明追記、UX の細かな改善" }
exit_criteria: { drive_loop: { critical: 0 } }
---

# usability — Usability / DX

## Review Criteria

- **CLI wording**: help / usage display, intuitiveness of flag names, consistency of `--<flag>` naming conventions
- **Error messages**: Whether the cause and required action are conveyed, whether the user can address it through their own actions
- **skill / agent argument-hint**: Whether the expected argument format is clear at a glance
- **README immediate comprehensibility**: Whether the first screen makes clear what the skill / package provides
- **Recovery steps on failure**: Design that doesn't get stuck outside the happy path, re-runnability
- **Default values**: Whether it works without configuration in the common case, whether it errs on the safe side
- **AskUserQuestion**: Whether user confirmations use AskUserQuestion, and whether choices are not enumerated via plain text output (CLAUDE.md rule)
- **Internationalization**: Whether messages are consistently in either Japanese or English, without mixing

## Severity Guide

- **critical**: Fatal UX defects that get users stuck (infinite-loop-like confirmations, executing unrecoverable operations without confirmation)
- **warning**: Confusing messages, misleading CLI wording, missing argument-hint
- **info**: Friendlier wording, added explanations, minor UX improvements

## skip_when

The usability perspective does not apply to changes that are only to tests.

## exit_criteria.drive_loop

```yaml
exit_criteria:
  drive_loop:
    critical: 0
```

Usability warnings are permitted (subject to continued improvement after merge). critical blocks.
