---
argument-hint: "[--dry-run] [--json] [--repo-root=<dir>]"
allowed-tools: Bash, Read
---

# verify

`.agents/skills/verify/SKILL.md` を Read し、ワークフロー手順に従う。

**重要:** 検証コマンドの発見連鎖・直列実行・結果サマリのレンダリングは `verify.mjs` エンジンが担う。エンジンの stdout をそのまま提示し、再整形・再解釈しない。

## Claude Code 固有の追加事項

### エンジンの実行

同階層の `verify.mjs` を Bash で実行する（`$ARGUMENTS` をそのまま渡す）。user-scope では `~/.claude/skills/verify/verify.mjs`、dogfood では `<repo>/.claude/skills/verify/verify.mjs`:

```bash
node ~/.claude/skills/verify/verify.mjs $ARGUMENTS
```

### 引数解析

`--dry-run`（別名 `--discover`）/ `--json` / `--repo-root=<dir>` の有無を判定する。いずれもエンジンが解釈するため、`$ARGUMENTS` をそのまま渡すだけでよい。

### 完了報告・次のアクション提案

エンジン出力を提示したら終了する。失敗コマンドがあってもここで自動修正・再実行はしない（呼び出し元の判断に委ねる）。次のアクション提案も行わない。
