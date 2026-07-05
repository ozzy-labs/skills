---
name: correctness
category: required
description: Logic errors, edge cases, concurrency, error handling
applies_when: ["**/*"]
default_enabled: true
severity_rules: { critical: "悪用・データ破壊・誤った状態遷移・無限ループ・回帰の温床になり得るバグ", warning: "通常パスは動くが特定入力で破綻するケース、未処理の例外", info: "防御的コーディングの改善余地、より堅牢な書き方の提案" }
exit_criteria: { drive_loop: { critical: 0, warning: 0 } }
---

# correctness — Correctness

## Inspection items

- **Logic errors**: missed branches in conditionals, off-by-one, inverted booleans, wrong operators
- **Edge cases**: empty input, null / undefined, max/min values, empty arrays / empty strings, Unicode, line breaks
- **Concurrency**: race conditions, conflicting writes, handling of shared state, missing await, Promise handling
- **Error handling**: swallowing errors (catch and do nothing), incorrect re-throwing, mixing up error types, side effects in finally
- **Return values / side effects**: whether the function satisfies its declared contract, whether there are undocumented side effects
- **Type consistency**: whether there are paths that break at runtime via `as` casts or `any`

## Severity guide

- **critical**: bugs that could enable abuse, data corruption, incorrect state transitions, infinite loops, or become a breeding ground for regressions
- **warning**: cases where the normal path works but specific inputs break it, unhandled exceptions
- **info**: room for improvement in defensive coding, suggestions for more robust code

## skip_when

None (a `required` perspective is always applied).

## exit_criteria.drive_loop

```yaml
exit_criteria:
  drive_loop:
    critical: 0
    warning: 0
```

Do not judge as merge-ready while critical / warning issues related to correctness remain.
