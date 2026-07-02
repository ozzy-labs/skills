---
description: セッション教訓 queue（~/.agents/lessons/queue.jsonl）を消化し、transcript から User Skills に関する教訓を抽出して、承認された分のみ ozzy-labs/skills へ issue 起票する。「教訓を整理して」「lessons を消化して」「セッションの振り返り」で発火。
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob, AskUserQuestion
---

# lessons-triage

`~/.agents/skills/lessons-triage/SKILL.md` を Read し、ワークフロー手順に従う。

## Claude Code 固有の追加事項

### transcript の読み方

- Claude Code の transcript は `~/.claude/projects/<project-slug>/<session_id>.jsonl`（1 行 = 1 イベントの JSONL）
- skill 呼び出しの痕跡は `Skill` tool の tool_use イベント、または `<command-name>` タグで判定できる
- 巨大な transcript は Grep で skill 関連イベントの行を絞ってから前後を Read する

### 過去の triage セッション判定（outcome: self）

実行中の自セッションは SessionEnd 未発火のため queue に存在しない。プレフィルタの `self` 判定対象は**過去に lessons-triage を実行したセッション**であり、transcript 内の実行マーカーで判定する:

- `<command-name>lessons-triage</command-name>` タグ（`/lessons-triage` 起動の痕跡）
- `Skill` tool の `lessons-triage` 呼び出しイベント

いずれかが transcript に含まれるセッションは `outcome: self` として破棄候補にする（Grep で判定できる）。

### HITL 承認（policy の `externally-visible` gate = batch-confirm）

手順 4 の一括確認は AskUserQuestion で行う（`answers` パラメータは設定しない）。gate=`batch-confirm`（既定）では、全教訓を 1 つの question の options として提示し、`multiSelect: true` で起票する教訓をまとめて選ばせる。教訓数が 1 question の option 上限を超える場合は複数回に分割してよいが、いずれも「1 回の一括確認ラウンド」として扱い、1 件ずつの逐次承認には戻さない。選択された教訓のみ `gh issue create` を実行し、非選択は破棄する。

gate=`ask`（policy で厳格化された場合）のときのみ 1 件ずつ確認にフォールバックする（起票する / 修正して起票する / 破棄する）。
