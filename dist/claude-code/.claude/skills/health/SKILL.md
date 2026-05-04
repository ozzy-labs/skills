---
description: リポジトリ改修中に意図せず残る状態を 15 領域に渡って一発確認し、固定語彙の推奨アクションを inline 付与して報告する。検査と提示のみで実行はしない。Routine 互換。
disable-model-invocation: true
allowed-tools: Bash, Read, Grep
---

# health

`.agents/skills/health/SKILL.md` を Read し、ワークフロー手順に従う。

**重要:** 読み込んだスキル内の手順を忠実に実行する。section 順序、推奨アクション語彙、エラーハンドリングは厳密に守る。

## Claude Code 固有の追加事項

### 並列実行

15 領域のチェックコマンドは **同一メッセージ内に複数の Bash tool call** を並べることで並列実行する。直列に呼ばないこと。

### 完了報告・次のアクション提案

レポートを出力したら終了する。AskUserQuestion は使わない。次のアクション提案も行わない。ユーザーが推奨アクションを見て自ら判断・実行する。
