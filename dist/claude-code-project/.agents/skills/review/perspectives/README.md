---
name: perspectives-index
description: Index and schema guide for perspective definitions referenced by the review skill.
---

# review perspectives

SSOT for perspective definitions referenced by the review skill / `code-reviewer` agent ([ADR-0025](https://github.com/ozzy-labs/handbook/blob/main/adr/0025-skills-review-multi-perspective.md)). Each `<axis>.md` represents one review perspective; the frontmatter holds perspective metadata, and the body holds inspection items, severity guide, and exit criteria.

## Adopted perspectives (11 axes)

| category | axis | default |
| --- | --- | --- |
| required | [correctness](./correctness.md) | Always applied |
| required | [security](./security.md) | Always applied |
| required | [conventions](./conventions.md) | Always applied |
| design | [architecture](./architecture.md) | When applies_when matches |
| design | [compatibility](./compatibility.md) | When applies_when matches |
| design | [maintainability](./maintainability.md) | When applies_when matches |
| quality | [testing](./testing.md) | When applies_when matches |
| quality | [performance](./performance.md) | When applies_when matches |
| quality | [observability](./observability.md) | When applies_when matches |
| ux | [usability](./usability.md) | When applies_when matches; consumer can opt out |
| ux | [documentation](./documentation.md) | Always applied |

## frontmatter schema

```yaml
---
name: <axis>                                                    # ファイル名と一致させる
category: required | design | quality | ux
description: <一行で観点の主旨>
applies_when: ["<glob>", ...]                                   # diff にこの glob にマッチするファイルが含まれれば適用
skip_when: { diff_only_in: ["<glob>", ...] }                    # 全変更ファイルがこの glob 部分集合なら不適用
default_enabled: true | false                                   # false の場合は --axes 明示時のみ適用
severity_rules: { critical: "<...>", warning: "<...>", info: "<...>" }
exit_criteria: { drive_loop: { critical: <N>, warning: <N> } }  # warning キーは省略可（許容を意味する）
---
```

Write `skip_when` / `severity_rules` / `exit_criteria` as a single line of flow-style YAML (to stay consistent with the existing flat frontmatter parser). The body may spell out a human-readable severity guide and inspection items redundantly, but frontmatter remains the SSOT for machine processing.

Readers ignore undefined keys (forward-compat). File an ADR for breaking schema changes (e.g. removing a required key).

## Perspective selection logic

The review skill / `code-reviewer` agent determines applicable perspectives in the following order:

1. `category: required` → always applied (ignoring `applies_when` / `skip_when`)
2. `default_enabled: false` → applied only when explicitly specified via `--axes` (for experimental use)
3. `skip_when.diff_only_in` matches → not applied (highest-priority skip condition)
4. Matches any glob in `applies_when` → applied (OR)
5. Otherwise → not applied

## Adding / changing perspective MD files

To add a new perspective, create `<axis>.md` in this directory and write it following the frontmatter schema. Linting of perspective MD files (validating required frontmatter keys, and the validity of `applies_when` / `skip_when` globs) is performed by the `health` skill.

File an ADR when making a breaking schema change (e.g. removing a required key). Introduce new keys as optional so that both the `code-reviewer` agent and the review skill's readers can keep up in a backward-compatible way.
