---
argument-hint: "<candidate-list> [--repo owner/repo] [--apply | --dry-run]"
disable-model-invocation: true
allowed-tools: Bash, Read, AskUserQuestion
---

# topics

`.agents/skills/topics/SKILL.md` を Read し、ワークフロー手順に従う。

**重要:** 決定論（公式制約 validation / 人気度取得 / broad+narrow 5x / 単数複数比較 / ozzy-labs 慣行のハードコード）はすべて同梱の **`topics.mjs` エンジン**が担う。SKILL は「エンジンを呼び、出力をそのまま提示し、policy gate で適用確認する」判断層に徹する。慣行を Claude の自由判断で拡張しない（エンジン + SKILL.md の同時改訂で行う）。

## Claude Code 固有の追加事項

### エンジン実行

```bash
node ~/.claude/skills/topics/topics.mjs <candidate-list> [--repo owner/repo] [--dry-run]
```

dogfood（本リポ内）では `<repo>/.claude/skills/topics/topics.mjs`。出力は整形済みテキスト（`--json` で構造化 JSON）。引数はユーザー入力をそのまま渡す。

- `<candidate-list>`: `,` 区切り or 複数引数
- `--repo owner/repo`: 省略時はエンジンが `git remote get-url origin` から抽出
- `--apply`: policy の batch-confirm を明示 opt-out し、エンジンが確認なしで適用
- `--dry-run`: 適用せず分析のみ
- `--apply` と `--dry-run` 同時指定時はエンジンが `--dry-run` を優先する

### 適用確認（policy の `externally-visible` gate = batch-confirm）

`--apply` / `--dry-run` どちらも未指定（`plan` モード）の場合、エンジンは適用せず `apply_command`（実行予定コマンド）と `final_topics` を返す。policy の gate に従う。gate=`batch-confirm`（ゼロコンフィグ既定）では、最終 topics リストを 1 回まとめて提示した後に AskUserQuestion を **1 回だけ** 呼び出す（`answers` パラメータは設定しない）:

- **「適用する」** → 同じ引数に `--apply` を付けて `topics.mjs` を再実行する（エンジンが `gh repo edit --add-topic` を実行し、`gh repo view` で検証）
- **「適用しない」** → 分析結果のみ表示して終了する
- **「候補を編集する」** → 終了し、ユーザーに再実行を促す

gate=`ask` に厳格化されている場合は 1 topic ずつ確認する。`--apply` は `batch-confirm` の明示 opt-out として扱い、確認せず適用する。

### 完了報告・次のアクション提案

適用結果（`apply.verified_topics`）または dry-run / plan 結果を表示したら終了する。次のアクション提案は行わない。
