---
description: Issue または指示をもとに、ブランチ作成・実装計画・コード変更を行う。Issue 番号またはテキスト指示を受け取る。
argument-hint: <#issue-number | instruction>
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch, AskUserQuestion
---

# implement

`~/.agents/skills/implement/SKILL.md` を Read し、ワークフロー手順に従う。

## Claude Code 固有の追加事項

### 入力解析

`$ARGUMENTS` を解析し、要件を特定する。

- **引数なしの場合:** AskUserQuestion で「何を実装しますか？（Issue 番号 or 説明）」と確認する（`answers` パラメータは設定しない）
- **`gh` CLI エラー時:** 認証エラーの場合は `gh auth login` の実行を案内して中断する

### 実装計画の確認（policy の gate に従う）

「アクション分類と policy 参照」で解決した gate に応じて分岐する:

- **gate=`proceed`（`reversible-local` の既定）:** AskUserQuestion を出さず、計画を提示して実装を進める（計画・変更内容を audit trail として報告に残す）
- **gate=`ask`（`irreversible`: migration / データ削除 / CI・リリース設定変更）:** 実装計画を提示した後、AskUserQuestion で確認する（`answers` パラメータは設定しない）:
  - **「この計画で実装」**
  - **「計画を修正」**
  - **「キャンセル」**
- **gate=`batch-confirm`:** 着手前に 1 回だけまとめて確認する

**drive 配下:** 自律実行が委任済みのため、`reversible-local` の `proceed` により従来どおり承認をスキップして進める。`ask` と判定したアクションのみ確認する。

### 完了後の次のアクション

実装完了報告の直後に AskUserQuestion を呼び出す（`answers` パラメータは設定しない）:

- **「検証・コミット・PR まで一括実行する」** → `~/.claude/skills/ship/SKILL.md` を Read し、その手順に従う
- **「検証（verify）を実行する」** → `~/.claude/skills/verify/SKILL.md` を Read し、その手順に従う
- **「追加の変更を行う」** → 終了する
