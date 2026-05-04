---
name: drive
description: Issue または指示から実装・PR 作成・セルフレビュー・修正を自動で回し、merge-ready な PR を出す。単一/複数の Issue/PR と明示依存記法に対応。オプションでマージまで実行可能。
---

# drive - Issue から merge-ready な PR まで自律駆動

Issue または指示を受け取り、実装 → ship → セルフレビュー → 修正を自動で繰り返して merge-ready な PR を作成する。複数 Issue/PR の並列駆動、オプションでマージまで完結させることが可能。

## 入力解析

引数を解析する。

### target の展開

以下の表記をすべて展開して target リストにする:

- 単一: `#42` / `42`
- カンマ列: `#1,#2`
- 範囲: `#3-5` → `#3, #4, #5`
- 空白列: `#1 #2`
- 混合: `#1,#3-5`
- テキスト指示: 上記いずれにも該当しない場合、指示として扱う（target は単一）

### 明示依存記法

`->` を含む引数は順次依存を表す:

- `#1,#2 -> #3`: #1 と #2 は並列、#3 は両者の完了後
- `#1 -> #2 -> #3`: 完全直列

### オプション

- `--merge`: 自動マージを試行する
- `--concurrency N`: 並列度を上書きする（既定 `min(4, タスク数)`、N > 8 は警告のみ）

### モード分岐

- target が 1 件かつ依存記法なし → **単一モード**
- target が 2 件以上、または依存記法あり → **オーケストレーションモード**

## 単一モード

### Phase 1: implement

implement スキルのワークフローを実行する。ただし以下の点が異なる:

- **計画承認をスキップ:** drive を実行した時点でユーザーは自律実行を委任しているため、計画を自ら承認して実装を進める
- **完了報告・次のアクション確認は無視:** フェーズ間の遷移は本スキルが制御する

**中断条件:** 動作確認が繰り返し失敗する場合 → エラーを報告して中断

### Phase 2: ship

ship スキルのワークフロー（lint → commit → PR 作成）を実行する。完了報告・次のアクション確認は無視する。

- PR 番号を記録する（Phase 3 で使用）
- **冪等性:** 同 issue に紐づく既存 PR、または target が PR 番号で既存 PR が見つかる場合は resume として扱い、新規作成せず Phase 3 から再開する

**中断条件:** lint が失敗し、自動修正できない場合 → エラーを報告して中断

### Phase 3: review loop（最大 3 回）

以下のループを最大 3 回繰り返す:

1. **レビュー実行:** review スキルで PR をレビューし、結果を PR コメントとして投稿する
2. **判定:**
   - Critical または Warning が 0 件 → ループを終了
   - Critical または Warning がある場合 → 修正に進む
   - ループ上限（3 回）に到達 → ループを終了（残存指摘を報告に含める）
3. **修正:** Critical および Warning の指摘事項のみを修正する。Info は修正しない（報告のみ）。修正後、lint → commit → push を実行し、1 に戻る

### Phase 4: merge (optional)

`--merge` 指定時に実行する。

1. **Auto-merge の有効化:** `gh pr merge --auto --squash --delete-branch` を実行する
2. **成否の確認:**
   - 成功（Auto-merge がセットされた、または即時マージされた）→ 次へ
   - 失敗（Auto-merge がリポジトリで無効など）→ ユーザーに通知し、手動マージを促す（状態を `merge-ready` にする）
3. **マージ完了の polling（オーケストレーションから呼ばれた場合のみ）:**
   - `gh pr view --json mergedAt,state` で mergedAt が立つ、または state が `MERGED` になるまで待つ
   - polling 間隔 30 秒、最大 30 分。タイムアウト時は状態を `auto-merge enabled` として終了
4. **クリーンアップ（即時マージされた場合）:**
   - ローカルブランチが削除され、ベースブランチ（main 等）に切り替わっていることを確認する
   - ベースブランチで `git pull` を実行し、最新の状態に同期する

### Phase 5: 完了報告

```text
drive 完了:
  Issue:    #<number> <title>
  ブランチ: <branch-name>
  PR:       <PR URL>
  レビュー: N 回実施（Critical: 0, Warning: 0, Info: N）
  状態:     <merged | merge-ready | auto-merge enabled | failed>
```

## オーケストレーションモード

### Phase 0: 入力展開と DAG 構築

1. 引数を target リストに展開する
2. 各 target について GitHub から情報を取得する:
   - issue: `gh issue view <N> --json number,title,body`
   - PR: `gh pr view <N> --json number,title,body,baseRefName,headRefName`
   - issue/PR の判別が曖昧な場合は両方を試し、ヒットした方を採用する
3. DAG を構築する:
   - **明示依存記法（最優先・確実）:** 引数の `->` から登録
   - **PR base ブランチ照合（確実）:** ある PR の baseRefName が同セット内の別 PR の headRefName に一致する場合、stacked PR として依存登録
   - **issue 本文の自動検出（best-effort）:** "depends on #X" / "blocked by #X" / "after #X" 等を grep で抽出。表記ゆれや日本語表現で取りこぼしてもエラーにせず並列扱いにフォールバック
4. DAG を wave に分割する（topological levels）。循環依存を検出した場合はエラー報告して中断する
5. wave 構成と target リストを表示する:

```text
drive 開始:
  Targets:  #1, #2, #3, #4, #5
  並列度:    4 (既定: min(4, タスク数))
  --merge:  有効
  Waves:
    Wave 1: #1, #2 (並列)
    Wave 2: #3 (← #1, #2)
    Wave 3: #4, #5 (並列, ← #3)
```

### Phase 1..N: wave 並列実行

wave を順に実行する。

#### 並列度

- 既定: `min(4, wave 内タスク数)`
- `--concurrency N` で上書き
- N > 8 の場合は警告を表示して続行（ハードキャップなし）

#### subagent dispatch

各 target に対し subagent を起動する。同時起動数は並列度まで、空きが出たら次を投入する semaphore 方式。

- **隔離:** worktree 隔離で起動する（必須。並列実行時の作業ディレクトリ衝突防止）
- **委譲粒度:** subagent には `/drive #<N>[ --merge]` を実行させる。引数 1 件なので subagent 内では単一モードに入る
- **PR 作成直後の即時報告:** 各 subagent には PR 作成時点で URL を中間出力するよう指示する（観測性）
- **戻り値:** 各 subagent は完了時に以下の JSON を返す

```json
{
  "target": "#<N>",
  "title": "<issue/PR title>",
  "branch": "<branch-name>",
  "pr_url": "<URL>",
  "pr_number": <N>,
  "status": "merged" | "merge-ready" | "auto-merge enabled" | "failed",
  "review": { "critical": 0, "warning": 0, "info": 0, "iterations": <N> },
  "error": "<message if failed>"
}
```

#### wave 完了待ち

- すべての subagent が完了した時点で wave 完了
- `--merge` 指定時、各 subagent は自 PR のマージ完了まで polling して終了するため、wave 完了 = wave 内全 PR のマージ完了
- `--merge` 未指定時、wave 完了 = wave 内全 PR が merge-ready になった時点

#### 失敗 task の処理

- 失敗した target を記録する
- downstream（DAG 上で依存する target）は次 wave の起動時に `skipped (upstream failed: #N)` として除外する
- 独立した（依存関係のない）他 task には影響させない

### Phase Final: 集約レポート

```text
drive 完了 (3/5 merged, 1 merge-ready, 1 skipped):
  #1 feat: ...        | PR #100 | merged
  #2 fix:  ...        | PR #101 | merged       (Review: C0 W0 I2)
  #3 feat: ...        | PR #102 | merge-ready  (Review: C0 W1 I0)
  #4 chore: ...       | skipped (upstream failed: #5)
  #5 refactor: ...    | failed (test loop)

集計:
  merged:       2
  merge-ready:  1
  skipped:      1
  failed:       1
  総レビュー反復: 5 回
```

## 失敗 semantics

| 状況 | 扱い | downstream への影響 |
|---|---|---|
| review loop 3 回後も Critical/Warning 残存 | partial success（merge-ready） | 影響なし |
| auto-merge セット失敗（branch protection 等） | failed | skipped |
| implement / ship 中断（テスト失敗等） | failed | skipped |
| 独立 task の失敗 | 他並列 task に影響させない | - |

## 注意事項

- .env ファイルは読み取り・ステージングしない
- `gh` CLI が未認証の場合はエラーメッセージを表示して中断する
- マージはデフォルトでは行わない。`--merge` 指定時のみ Auto-merge を試行する
- Info 指摘は修正せず報告のみ（設計判断に関わる変更を機械的に行わない）
- オーケストレーションモードでは subagent を必ず worktree 隔離で起動する
- 並列度 8 超過は警告のみ。GitHub Actions 同時実行枠 / API rate limit / 観測性 / コストに注意
- 循環依存を検出した場合はエラー報告して中断する
