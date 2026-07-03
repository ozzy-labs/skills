---
description: 失敗した CI run のログを収集してコンテキストを整形し `/drive` へ接続する薄い wrapper。入力解決（明示 run id > 明示 branch の最新 failure > 現在ブランチの最新 failure）→ flaky 判定（`gh run rerun --failed` 1 回 + polling、`--no-rerun` で skip）→ ログ抽出（`gh run view --log-failed`、ANSI 除去 + エラー行抽出 regex は health の same-error 判定と同一）→ 指示テキスト組み立て → `/drive` 起動。`--dry-run` は指示テキストのみ出力（rerun も drive 起動もしない）。main ブランチの failure は優先度高としてレポート冒頭で明示。
argument-hint: "[<run-id> | --branch <name>] [--no-rerun] [--dry-run] [--auto]"
disable-model-invocation: true
allowed-tools: Bash, Read, AskUserQuestion, SlashCommand
---

# ci-fix

`~/.agents/skills/ci-fix/SKILL.md` を Read し、ワークフロー手順に従う。

**重要:** 入力解決の優先順位 / flaky 判定フロー / エラー抽出 regex は SKILL.md の固定契約。regex は health（`health-check.mjs` の `extractCiErrorKey`）と同一で、テストが一致を強制する。Claude が順序や regex を勝手に変えない。

## Claude Code 固有の追加事項

### コマンド実行

`gh` CLI（Bash）で run を解決・再実行・ログ取得する。SKILL.md「入力解決の優先順位」「flaky 判定」「ログ抽出」の順に実行する:

```bash
# 入力解決（明示 run id がなければ branch から最新 failure を引く）
gh run list --branch <name> --status failure --limit 1 --json databaseId,workflowName,headBranch,conclusion

# flaky 判定（--no-rerun 指定時は skip）
gh run rerun <id> --failed
# 30 秒間隔・上限 15 分で completed を待つ
gh run view <id> --json status,conclusion

# 再現する失敗のログ抽出
gh run view <id> --log-failed | tail -200
```

ANSI 除去（`/\[[0-9;]*m/g`）とエラー行抽出（`/(error|Error|failed)[\s:].*$/` の最終マッチ）は SKILL.md の regex に厳密に従う。

### drive 起動前の確認（AskUserQuestion 配線・既定）

drive 起動は PR 作成という**外部可視アクション**。既定では組み立てた指示テキストを提示し、`AskUserQuestion` で起動可否を確認する（テキストで選択肢を列挙しない）:

1. 整形した指示テキストと、対象 run の要約（workflow / job / step / エラー要約 / main branch failure なら優先度高の明示）を提示する。
2. `AskUserQuestion` で確認する:
   - **「drive を起動する」** → `SlashCommand` で `/drive "<指示テキスト>"` を単一モードで起動する。
   - **「やめる」** → 指示テキストを表示して終了する。

### `--auto`（確認 skip）

`--auto` 指定時は上記 `AskUserQuestion` を**挟まず**、直接 `SlashCommand` で `/drive "<指示テキスト>"` を起動する（外部可視アクションの明示 opt-out）。routine / `/loop` / `schedule` 経由の無人実行を想定する。

### `--dry-run`（副作用なし）

`--dry-run` 指定時は **rerun も drive 起動も行わず**、指示テキストのみを出力して終了する。`AskUserQuestion` も `SlashCommand` も呼ばない。`--dry-run` と他フラグが同時指定された場合も「出力のみ」が優先される。

### flaky / failed-run なしの終了

- flaky（rerun が success）→ 「flaky（修正不要）」と報告して終了。drive は起動しない。
- failed run なし → 「failed run なし」と報告して終了。
- polling 上限（15 分）到達 → `要確認`（判定不能）として終了。drive は起動しない。

### 完了報告・次のアクション提案

指示テキストの提示 / 起動した drive / flaky・failed-run なしの報告を表示したら終了する。drive を起動した場合はその報告に委ねる。次のアクション提案は行わない。
