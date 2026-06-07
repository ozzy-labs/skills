---
description: セッション教訓 queue を消化し、skill 改善の教訓を承認制で issue 起票する
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob, AskUserQuestion
---

# lessons-triage

`.agents/skills/lessons-triage/SKILL.md` を Read し、ワークフロー手順に従う。

## Claude Code 固有の追加事項

### transcript の読み方

- Claude Code の transcript は `~/.claude/projects/<project-slug>/<session_id>.jsonl`（1 行 = 1 イベントの JSONL）
- skill 呼び出しの痕跡は `Skill` tool の tool_use イベント、または `<command-name>` タグで判定できる
- 巨大な transcript は Grep で skill 関連イベントの行を絞ってから前後を Read する

### 自セッション判定

環境変数 `CLAUDE_CODE_SESSION_ID` が現在のセッション ID を保持する。queue エントリの `session_id` と一致するものは `outcome: self` として破棄候補にする。

### HITL 承認

手順 4 の承認は AskUserQuestion で 1 件ずつ行う（`answers` パラメータは設定しない）:

- **「起票する」** → そのまま `gh issue create` を実行する
- **「修正して起票する」** → ユーザーの修正内容を反映してから起票する
- **「破棄する」** → 起票せず次の教訓へ進む
