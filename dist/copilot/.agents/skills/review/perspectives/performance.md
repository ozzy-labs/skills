---
name: performance
category: quality
description: hot paths, unnecessary sequential I/O, memory
applies_when: ["src/**", "scripts/**", "**/*.ts", "**/*.tsx", "**/*.mjs", "**/*.js", "**/*.py"]
skip_when: { diff_only_in: ["**/*.md", "docs/**", "tests/**", "**/*.test.*", "**/*.yaml", "**/*.yml", "**/*.json"] }
default_enabled: true
severity_rules: { critical: "顕著な性能退行、production で UX を損なう規模のリグレッション、無限ループ", warning: "hot path 上の非効率、逐次 I/O、明らかな再計算", info: "軽微な最適化提案、cache 化候補" }
exit_criteria: { drive_loop: { critical: 0 } }
---

# performance — Performance

## Review Criteria

- **Hot path**: O(n²) or worse processing in high-frequency call paths, nested loops, unnecessary allocation
- **Sequential I/O**: Whether independent I/O that could be parallelized is executed serially (serialized `for await`, missing Promise.all)
- **Memory**: Unnecessarily huge intermediate arrays, bulk loading of processing that could be streamed, leak sources (closures that hold references)
- **Unnecessary rendering / recomputation**: Places where memo / cache should be used, constants recomputed every time
- **File I/O**: Duplicate reads of the same file, wasteful fs stat calls, reading entire large files
- **HTTP / fetch**: Missing timeout settings, N+1 requests, excessive polling intervals
- **Dependency impact**: Introducing heavyweight libraries, structures that hinder tree-shaking

## Severity Guide

- **critical**: Notable performance regression, a regression large enough to harm UX in production, infinite loops
- **warning**: Inefficiency on the hot path, sequential I/O, obvious recomputation
- **info**: Minor optimization suggestions, caching candidates

## skip_when

The performance perspective does not apply to changes that are only to tests / documentation / config.

## exit_criteria.drive_loop

```yaml
exit_criteria:
  drive_loop:
    critical: 0
```

Performance warnings are permitted (subject to continued improvement after merge). critical blocks.
