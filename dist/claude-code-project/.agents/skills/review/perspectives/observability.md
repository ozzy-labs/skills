---
name: observability
category: quality
description: Error context, logging, clues for failure diagnosis
applies_when: ["src/**", "scripts/**", "**/*.ts", "**/*.tsx", "**/*.mjs", "**/*.js", "**/*.py", "**/*.sh"]
skip_when: { diff_only_in: ["**/*.md", "docs/**", "tests/**", "**/*.test.*", "**/*.yaml", "**/*.yml", "**/*.json"] }
default_enabled: true
severity_rules: { critical: "失敗時に何も情報が出ず原因特定不可能、本番で silent failure になる経路", warning: "エラーメッセージが薄い、ログ過剰 / 不足、エラー種別の取り違え", info: "より親切なメッセージ、log level の調整提案" }
exit_criteria: { drive_loop: { critical: 0 } }
---

# observability — Observability

## Review Criteria

- **Error context**: Whether thrown errors include sufficient clues (input values, which file, which operation)
- **Logging**: Whether there is enough logging to trace what happened on failure, whether excessive debug logging has been left in
- **Error message granularity**: Whether messages shown to users are actionable (whether the next step is suggested)
- **Failure propagation**: Whether the structure allows callers to branch on error type, use of error codes / typed errors
- **Side-effect traceability**: Whether success/failure of calls to external systems (GitHub API / fs / network) is visible
- **Secret leak prevention**: Whether secrets appear in logs
- **CI / hook failure display**: Whether lefthook / hook failures produce output that immediately reveals the cause

## Severity Guide

- **critical**: No information is output on failure, making the cause impossible to identify; paths that become silent failures in production
- **warning**: Thin error messages, excessive / insufficient logging, mistaking error types
- **info**: Friendlier messages, suggestions for adjusting log level

## skip_when

The observability perspective does not apply to changes that are only to tests / documentation / config.

## exit_criteria.drive_loop

```yaml
exit_criteria:
  drive_loop:
    critical: 0
```

Observability warnings are permitted. critical blocks.
