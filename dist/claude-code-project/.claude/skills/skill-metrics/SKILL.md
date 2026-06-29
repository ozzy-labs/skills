---
description: ローカルの observability イベントログ（~/.agents/observability/events.jsonl）を集計し、skill 別の発火件数と注目イベント（fallback / HITL 却下 / loop 上限到達 / 中断）を read-only で提示する。「skill のメトリクスを見せて」「観測結果を集計して」「どの skill がよく使われてる?」で発火。送信はしない。
argument-hint: "[--since=<ISO 8601>] [--skill=<name>] [--snapshot]"
disable-model-invocation: true
allowed-tools: Bash, Read
---

# skill-metrics

`.agents/skills/skill-metrics/SKILL.md` を Read し、ワークフロー手順に従う。

## Claude Code 固有の追加事項

### 集計エンジンの実行

同階層の `skill-metrics.mjs` を Bash で実行して JSON rollup を得る（`$ARGUMENTS` をそのまま渡す）。user-scope では `~/.claude/skills/skill-metrics/skill-metrics.mjs`、dogfood では `<repo>/.claude/skills/skill-metrics/skill-metrics.mjs`:

```bash
node ~/.claude/skills/skill-metrics/skill-metrics.mjs $ARGUMENTS
```

得た JSON を人間可読に整形して提示する（read-only・送信なし）。
