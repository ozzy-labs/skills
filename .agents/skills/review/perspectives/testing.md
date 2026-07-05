---
name: testing
category: quality
description: Coverage of new code, regression risk, validity of bats / Vitest / node:test
applies_when: ["src/**", "scripts/**", "tests/**", "**/*.ts", "**/*.tsx", "**/*.mjs", "**/*.js", "**/*.py", "**/*.sh"]
skip_when: { diff_only_in: ["**/*.md", "docs/**", "**/*.yaml", "**/*.yml", "**/*.json"] }
default_enabled: true
severity_rules: { critical: "公開 API / バグ修正にテストがない、既存テストを根拠なく削除、tautology テスト", warning: "エッジケースの取りこぼし、不安定なテスト (flaky)、mock 過剰", info: "より良いアサーション、テストの整理 / 命名改善" }
exit_criteria: { drive_loop: { critical: 0, warning: 0 } }
---

# testing — Testing

## Review Criteria

- **Tests for new code**: Whether tests exist for public APIs / main logic
- **Edge cases**: Whether empty input / null / abnormal cases / boundary values are covered
- **Regression risk**: Breaking changes to existing tests, validity of test removal, reasons for skip / disable
- **Test quality**: Whether assertions are meaningful, whether tests have become tautology tests (`expect(true).toBe(true)`)
- **Mocking boundaries**: Whether important integration points are mocked away in integration tests
- **Fixture / snapshot**: Whether tests depend on unstable data (time / random), reasons for snapshot updates
- **Test runner consistency**: Whether existing patterns such as bats / node:test / Vitest are followed
- **CI executability**: Whether tests depend on local-only assumptions (specific paths / environment variables)

## Severity Guide

- **critical**: No tests for public API / bug fixes, existing tests removed without justification, tautology tests
- **warning**: Missed edge cases, unstable (flaky) tests, excessive mocking
- **info**: Better assertions, test organization / naming improvements

## skip_when

The testing perspective does not apply to changes that are only to documentation / config files.

## exit_criteria.drive_loop

```yaml
exit_criteria:
  drive_loop:
    critical: 0
    warning: 0
```

Do not judge as merge-ready when public APIs / bug fixes lack tests.
