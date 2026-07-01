---
name: drive
description: Issue または指示から実装・PR 作成・セルフレビュー・修正を自動で回し、merge-ready な PR を出す。単一/複数の Issue/PR と明示依存記法に対応。オプションでマージまで実行可能。オーケストレーションではマージ前に cross-cutting を検出・自己解消し、1 run で follow-up を残さない。
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
- `--review=<mode>`: review モード（既定 `quick`）。値は次のいずれか:
  - `quick`（既定）: 全 review pass で quick モード（最大 3 回）
  - `final-deep`: quick で最大 2 回 loop し、最終 pass のみ deep に格上げ（quick 2 + deep 1）
  - `deep`: 全 pass で deep モード（最大 1 回。コスト爆発防止）

  オーケストレーションモードでは `--review=quick` を強制し、`final-deep` / `deep` 指定時は警告を出して `quick` にフォールバックする。

- usage-guard: Claude Code の Usage Limit 超過手前で作業を pause し、枠回復後に自動再開する。**既定で有効（opt-out）**。無効化するには `--no-usage-guard` を付ける。**Claude Code 環境のみ**で実効する（`review --deep` と同じ扱い。OAuth 使用率エンドポイント + `ScheduleWakeup` 依存のため他アダプタでは no-op）。既定 ON だが実効は claude-code adapter のみで、他アダプタ（codex/gemini/copilot）では従来どおり何もしない。pause/resume の配線はホスト依存なので `SKILL.claude-code.md` の「usage-guard 配線（既定 ON・`--no-usage-guard` で無効化）」で吸収する。
  - `--no-usage-guard`: usage-guard を無効化し、checkpoint を一切挟まない素の drive を実行する。
  - `--usage-guard`: 後方互換のための **deprecated no-op エイリアス**（既定で有効になったため明示は不要）。受理するが挙動は既定 ON と同一。
  - 停止は **resumable unit の入口**でのみ行う（単一モード: Phase 1 開始前 / review loop 各反復前、オーケストレーション: 各 wave 開始前 / worker dispatch 前）。mid-implement（PR 作成前）では止めない。
  - orchestration の停止粒度は **wave 境界**。一度起動した走行中 worker の mid-unit 超過はこのフラグでは止められず、PreToolUse hook（#123）が ceiling を担う。
  - 超過時は枠リセットまで待機してから継続コマンド `/drive <元の引数>` を自己再入する（drive 冪等 resume で続行）。`--no-usage-guard` がユーザー指定されていた場合のみ継続コマンドにも引き継ぐ（`--usage-guard` を強制付与しない）。
  - usage-guard skill / `usage-check.mjs` が未インストールの環境でもエラーで drive を止めない。skill 不在を検出したら 1 行警告を出し、そのまま通常進行する（fail-open 扱い）。

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
- **冪等性:** 既存 PR を検出した場合は resume として扱い、新規作成せず Phase 3 から再開する。判定基準:
  - target が PR 番号 → その PR を採用
  - target が issue 番号 → `gh pr list --search "in:body #<N>" --state open` で取得した最新 1 件、または現在のブランチ名と一致する PR を採用

**中断条件:** lint が失敗し、自動修正できない場合 → エラーを報告して中断

### Phase 3: review loop（観点別終了基準で判定）

review skill の観点別 `exit_criteria.drive_loop` を集約して終了判定する。loop 上限は `--review` モードで切替える:

| `--review` | quick の最大回数 | deep の最大回数 | 備考 |
| --- | --- | --- | --- |
| `quick`（既定） | 3 | 0 | 全 review pass で quick |
| `final-deep` | 2 | 1（最終 pass のみ） | quick で loop し、最終 pass のみ deep |
| `deep` | 0 | 1 | 全 pass で deep。コスト爆発防止のため最大 1 回 |

各 pass の手順:

1. **レビュー実行:** review スキルで PR をレビューし、結果を PR コメントとして投稿する。このとき PR コメント末尾の HTML コメント `<!-- review-json:v<N> ... -->` に JSON を埋め込む（[ADR-0025](https://github.com/ozzy-labs/handbook/blob/main/adr/0025-skills-review-multi-perspective.md) Schema v1）
2. **判定:**
   - JSON を解析できる場合 → 観点別 `exit_criteria.drive_loop` を **すべて** 満たすか判定する。`exit_criteria` は対応する `perspectives/<axis>.md` の `exit_criteria.drive_loop` を参照する（観点ごとに critical / warning の許容しきい値が異なる）
   - すべての適用観点が `exit_criteria` を満たす → ループを終了（merge-ready）
   - 1 つでも未達観点がある → 修正に進む
   - JSON 解析失敗 / `unknown_review_version` → fail-soft で人間可読部分のみ扱い、Critical または Warning が 0 件かどうかで判定（旧挙動互換）
   - ループ上限に到達 → ループを終了（残存指摘を報告に含める）
3. **修正:** 未達観点の Critical および Warning の指摘事項のみを修正する。Info は修正しない（報告のみ）。修正後、lint → commit → push を実行し、1 に戻る

`--review=final-deep` の場合、最後の pass（quick 上限到達直前または最終 1 回ぶん）のみ deep モードで再 review する。

`unknown_review_version` を検出した場合は、JSON を無視して人間可読部分のみで判定し、loop はそのまま継続する（schema bump 後の互換維持）。

#### 既存 PR コメントとの resume 互換

- 過去の PR コメントに `<!-- review-json:v<N> -->` が含まれない場合、その PR は **legacy comment** とみなし、新しい review pass を実行する（旧コメントは消さない）
- `<!-- review-json:v<unknown> -->` の場合も同様に新規 pass を実行する

### Phase 4: merge (optional)

**オーケストレーションの worker として単一モードを実行する場合は Phase 4 を実行しない。** worker は `merge-ready`（レビュー通過済み・未マージ）で停止し、戻り値 `status` を最大 `merge-ready` として返す。マージは親が Phase Final-4 で一元管理する（マージ前に cross-cutting を畳み込む窓を確保するため。worker が self-merge するとマージ済みで畳み込めず follow-up が残る）。

以下は **単一モードを直接（worker としてではなく）実行し、かつ `--merge` 指定時**にのみ実行する:

1. **Auto-merge の有効化:** `gh pr merge --auto --squash --delete-branch` を実行する
2. **成否の確認:**
   - 成功（Auto-merge がセットされた、または即時マージされた）→ 次へ
   - 失敗（Auto-merge がリポジトリで無効など）→ ユーザーに通知し、手動マージを促す（状態を `merge-ready` にする）
3. **クリーンアップ（即時マージされた場合）:**
   - ローカルブランチが削除され、ベースブランチ（main 等）に切り替わっていることを確認する
   - ベースブランチで `git pull` を実行し、最新の状態に同期する

### Phase 5: 完了報告

```text
drive 完了:
  Issue:    #<number> <title>
  ブランチ: <branch-name>
  PR:       <PR URL>
  レビュー: N 回実施 (mode: <quick|final-deep|deep>)
            総計 Critical: 0, Warning: 0, Info: N
            by_axis: correctness:C0W0I0 security:C0W0I0 ...
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

#### worker dispatch

各 target に対し worker（並列実行単位）を起動する。同時起動数は並列度まで、空きが出たら次を投入する。worker の起動機構と、親リポジトリの git 状態を保護するための禁止事項・tool 制約は**並列実行機構に依存する**ため、ホスト固有の手順に従う（Claude Code: `SKILL.claude-code.md` の「subagent dispatch」）。

- **隔離:** worker は必ず隔離された作業コピーで起動する（必須。並列実行時の作業ディレクトリ衝突防止）。worker は自分の作業コピーと branch の中で完結し、親側のベースブランチ・ref・作業コピーには一切書き込まない
- **委譲粒度:** worker には本 SKILL.md を読み込ませ、target #N について単一モードのワークフロー（Phase 1-3）を実行させる。**worker は Phase 4（マージ）を実行しない** — `merge-ready` で停止し、マージは親が Phase Final-4 で一元管理する（マージ前に cross-cutting を畳み込む窓を確保するため）
- **マージ禁止:** worker は `gh pr merge` を一切呼ばない（`--auto` も `--delete-branch` も付けない）。self-merge するとマージ済みで gap を畳み込めず follow-up が残る。ローカル branch / 作業コピーの整理も親の Phase Final-5 で一括処理する
- **scope 外波及の最低限チェック:** 自 issue で schema enum / field / CLI flag を追加した場合、リポ全体で対応する help 文字列・エラーメッセージ・サンプル/docs を grep し、同期されているか確認する（例: `rg -n '<old-enum-list>' src/ docs/`）。同期されていなければ **可能なら自 PR に含める**（自 scope の自然な拡張として）。判断に迷う / 自 scope を明確に超える場合は修正せず、戻り値 `cross_cutting_gaps` に `<file>:<line> — <symbol> not synced` 形式で記録し、親の Phase Final-2 audit に集約する（[Issue #70](https://github.com/ozzy-labs/skills/issues/70)）
- **ベースブランチ:**
  - 依存元 wave がない target → main からブランチを作る
  - 依存元 wave がある target → 依存元 PR の `headRefName` をベースにブランチを作る（stacked PR）。worker は self-merge しないため、run 中は依存元も未マージ。よって `--merge` 有無にかかわらず **stacked 構造が既定**（親が Phase Final-4 で依存順にマージする際に base を main へ付け替える）
- **戻り値:** 各 worker は完了時に以下の JSON を返す

```json
{
  "target": "#<N>",
  "title": "<issue/PR title>",
  "branch": "<branch-name>",
  "pr_url": "<URL>",
  "pr_number": <N>,
  "status": "merge-ready" | "failed",
  "review": {
    "mode": "quick" | "final-deep" | "deep",
    "axes_applied": ["security", "..."],
    "by_axis": {"security": {"critical": 0, "warning": 0, "info": 0}, ...},
    "total": {"critical": 0, "warning": 0, "info": 0},
    "iterations": <N>
  },
  "cross_cutting_gaps": [
    "src/cli/foo.ts:213 — help text missing new kind 'html-js'",
    "src/cli/foo.ts:299 — validation error message lists old enum set"
  ],
  "final_head_state": {
    "symbolic_ref": "<git symbolic-ref HEAD 出力、例: refs/heads/feat/foo>",
    "rev_parse_HEAD": "<git rev-parse HEAD 出力>",
    "status_short": "<git status --short 出力、clean なら空文字列>"
  },
  "error": "<message if failed>"
}
```

`status` は worker では最大 `merge-ready`（レビュー通過・未マージ）。`merged` は親が Phase Final-4（即時 squash マージ）で確定し、`auto-merge enabled` は単一モードを直接実行した場合の Phase 4（`--auto`）でのみ現れる。いずれも worker 戻り値には現れない（後方互換のため親は受理はする）。

`cross_cutting_gaps` は worker が「scope 外波及の最低限チェック」で気付いたが自 PR では修正しなかった項目を記録する任意フィールド（空配列でも可）。フィールドが欠落している戻り値も後方互換のためエラーにせず、`[]` として扱う。親は Phase Final-2 の**マージ前** audit でこれを起点に集約し、独自検出した gap と統合して Phase Final-3 reconciliation で導入元 PR に畳み込む。

`final_head_state` は worker 完了時点の自作業コピーの git HEAD 状態を必ず申告するフィールド。自己申告と実態が乖離した観察例があるため、戻り値で実測値を提出させて親側 Phase Final-1 で交差確認する。フィールドが欠落している場合は後方互換のため `null` 扱いとし、交差確認を skip する（乖離の判定基準はホスト固有の手順を参照）。

#### 観測性

- worker の実行中はストリーム的な中間報告ができない場合があるため、親は wave 起動時刻 `<T>` を ISO 8601 で記録し、30 秒間隔で `gh pr list --author @me --state open --search "created:>=<T>" --json number,url,headRefName,title` を polling する
- 既知 PR との差分から新規作成 PR を検出し、URL を即時表示する
- 全 worker 完了時に最終 JSON 戻り値で状態を確定する

#### wave 完了待ち

- すべての worker が完了した時点で wave 完了
- worker は self-merge しないため、`--merge` 有無にかかわらず wave 完了 = wave 内全 PR が `merge-ready` 以上になった時点（未マージ）。後続 wave は前段 PR の `headRefName` をベースに stacked PR として作成する
- 実際のマージは全 wave 完了後、Phase Final-4 で親が依存順に一元実行する

#### 失敗・merge-ready task の処理

worker は run 中マージしないため、downstream から見た上流は `merge-ready`（成功）か `failed` の 2 値のみ:

| 上流の状態 | downstream の扱い |
|---|---|
| merge-ready | 進める（前段 PR の headRefName ベースで stacked PR） |
| failed | `skipped (upstream failed: #N)` として除外 |

- 失敗した target は記録する
- 独立した（依存関係のない）他 task には影響させない

### Phase Final: cross-cutting 自己解消・マージ・集約レポート

Phase Final は次の 6 ステップで構成する。順に実行する。**設計の要**: cleanup（Final-5）を最後尾に置き、audit（Final-2）と reconciliation（Final-3）を**マージ前**に実行することで、worker の作業コピーが残存する間に cross-cutting gap を導入元 PR へ畳み込む。これにより 1 run で follow-up を残さない。

#### Phase Final-1: 親作業コピーの整合性チェック

worker が親リポジトリの git 状態（`HEAD` / `index` / ベースブランチ ref）を汚染していないかを検証する fail-safe。具体的な検証軸・recovery シーケンスは並列実行機構に依存するため、ホスト固有の手順に従う（Claude Code: `SKILL.claude-code.md` の「Phase Final-1: 親 worktree 整合性チェック」）。

最低限、次の不変条件をホストによらず確認する:

1. 親の HEAD がベースブランチ（通常 `main`）を指し、detached でないこと
2. 親の index / working tree が clean であること
3. ベースブランチ ref が `origin/<base-branch>` と一致すること
4. worker 戻り値の `final_head_state` と実測の git 状態に乖離がないこと

いずれかが不一致なら、集約レポート末尾に warning と recovery 手順（ホスト固有）を出す。

#### Phase Final-2: cross-cutting audit（マージ前・worker 作業コピー内で並列）

複数 worker が自 sub-issue scope に閉じて並列実行する結果、**scope を跨ぐ波及 (cross-cutting) が構造的に漏れる**ことがある（enum/field/CLI flag の help・エラーメッセージ・サンプルへの未反映、ステータス系文言の取り残し、lockfile drift 等）。これを**マージ前**に検出し、Phase Final-3 で導入元 PR へ畳み込む（[Issue #70](https://github.com/ozzy-labs/skills/issues/70) / [#166](https://github.com/ozzy-labs/skills/issues/166) 由来）。

**なぜマージ前・worktree 内で検出できるか**: cross-cutting gap の本質は「PR-A が enum X を追加 → help/docs（誰も触っていない既存ファイル）に X 未反映」。この既存ファイルは **PR-A の作業コピー（X を含む）** で grep すれば `X 無し = gap` と検出でき、main へマージする前に判定可能（post-merge の main grep と等価）。

**並列**: 各 PR の検査は独立しているため、**PR ごとに並列実行する（既定）**。各検査は当該 worker の作業コピー内で行う（worker は Phase Final-5 まで cleanup されず残存する）。

##### 0. worker からの報告を集約

検査の起点として、各 worker 戻り値の `cross_cutting_gaps` フィールドをすべて集約する。worker が自前で気付き、自 PR では修正しなかった gap がここに含まれる。

##### 1. cross-cutting symbol の同期確認 (heuristic)

各 worker の `pr_number` に対し `gh pr diff <N>`（stacked でも `base...head` = その PR 固有 diff のみ、二重計上なし）で差分を取得し、新規追加された enum 値・field 名・CLI flag らしき symbol を heuristic に抽出する:

```bash
gh pr diff <N> | grep -E '^\+' | grep -oE '(case\s+["'\'']\w[\w-]+["'\''])|(--[a-z][a-z0-9-]+)|(["'\''][a-z][a-z0-9-]+["'\''])' | sort -u
```

抽出した symbol を当該 worker の作業コピー内で repo 全体 grep し、help 文字列・エラーメッセージ・サンプル・docs に同期されているか確認する（偽陽性は許容、AI が判断）。

##### 2. 古い文言の残骸検出

ステータス系 keyword (`alpha`, `beta`, `Phase \d+`, `pending` 等) が PR で削除されている場合、同じ文字列が他ファイルに残骸として残っていないか作業コピー内で grep する。固有名詞として正当な使用は AI が除外する。

##### 3. lockfile drift

`pnpm-lock.yaml` / `package-lock.json` / `uv.lock` 等が PR で変更されているが対応する manifest (`package.json` / `pyproject.toml` 等) が変更されていない、またはその逆を各 PR diff から検出する。

##### 4. docs ⇄ code grep 整合 (スコープ縮小版)

docs 系 PR (`docs:` タイトル等) の diff から追加された CLI 呼び出し文字列を抽出し、code 側に対応する文字列が存在するか作業コピー内で grep する。「実行ベース」検証は行わない。

##### audit 出力（attribution）

検出した各 gap を **導入元 PR に attribution** して次の形で出力する。Phase Final-3 はこの `source_pr` を使って畳み込み先を決める:

```text
gap:        <target_file:line — symbol / message>
source_pr:  #<N>（symbol を導入した PR）
category:   enum-flag-sync | stale-text | lockfile-drift | docs-code
```

worker 報告と独自検出は重複排除する。重複判定キーは `file:line` を基本とし、同一 `file:line` で複数 message がある場合は両方併記する（情報を捨てない）。gap が 0 件なら Final-3 を skip する。

#### Phase Final-3: reconciliation（導入元 PR へ畳み込み・PR 単位で並列）

Final-2 で検出した gap を `source_pr` で groupBy し、**導入元 PR の作業コピーで修正して push する**（マージ前なので自然に PR へ畳み込まれ、follow-up を残さない）。

- **並列**: gap を PR ごとに groupBy → **PR ごとに並列**（別作業コピーで衝突しない）。**同一 PR 内の複数 gap は直列**（同じ作業コピーを共有するため）
- **手順**: 導入元 PR の作業コピーで対象ファイルを編集 → lint（自動修正）→ commit（`fix(sync): ...`）→ push
- **full review loop は回さない**（機械的同期のため）。lint pass のみ確認する

edge case:

| ケース | 扱い |
|---|---|
| 対象ファイルを別 PR-B が編集済みで畳み込みが衝突 | 導入元 PR への畳み込みを諦め、**専用 reconciliation PR** へフォールバック（下記） |
| 複数 PR が同 symbol を導入 | 専用 reconciliation PR |
| reconciliation の lint/畳み込みが失敗 | **fail-soft**：その gap のみ warning に残して run 継続（設計レベルで機械修正できないものと同様） |
| 畳み込みが新たな cross-cutting を生む | audit→reconciliation は **1 パス固定**（再帰しない）。残余は warning。収束・コスト上限を保証 |
| stacked 上流 PR へ畳み込み → 下流 base ズレ | Phase Final-4 の依存順マージ手順に内包 |

**専用 reconciliation PR**: 単一 gap を 1 PR へ畳み込めない場合（衝突 / 複数 PR 跨ぎ）に作る補正 PR。GitHub PR の base は単一なので「全 tip に stacked」は取れない。よって **全 content PR をマージした後に main を base として最後にマージする**（Phase Final-4 の末尾に組み込む）。この PR も run 内でマージするため follow-up は残らない。

reconciliation で解消した gap は「run 内解消（folded）」として集約レポートに記録する。fail-soft で残った gap のみ warning とする。

#### Phase Final-4: 依存順マージ（親一元）

worker は self-merge しないため、実際のマージはここで親が一元管理する。`--merge` 指定時に実行する（未指定時は下記「完了後」の確認を経る）。

topological order（依存元→依存先）で各 PR をマージする:

1. `gh pr merge <上流> --squash`（**remote-only マージ。`--delete-branch` は付けない** — この時点で worker 作業コピーが当該 branch を握って残存しているため、local branch 削除は `fatal: '<branch>' is already used by worktree` で失敗する。remote/local branch と作業コピーの削除は Final-5 cleanup に一本化する）
2. 下流 PR は `gh pr edit <下流> --base main`（base を上流 head→main へ付け替え）してから次をマージする。upstream の squash-merge で main に変更が入っているため、base 付け替えだけで phantom conflict になる場合は下流の作業コピーで `git rebase origin/main` してから続行する（親側 ref は触らない）
3. **Phase Final-3 で専用 reconciliation PR を作成した場合、全 content PR をマージした後に main を base として最後にマージする**（この PR も run 内でマージし follow-up を残さない）
4. auto-merge がリポジトリで無効 / branch protection 等で即マージ不可 → その PR を `merge-ready` として残置し、それに依存する下流を `skipped` にして warning を出す
5. 各 PR のマージ完了を `gh pr view --json mergedAt,state` で確認してから次へ進む（squash merge の反映を待つ）

親が途中で落ちても drive は冪等 resume（既存 merged PR を検出）で残りを続行できる。

#### Phase Final-5: worker 作業コピーの cleanup

**今回の drive 実行で起動した worker** の作業コピーと関連 local branch をクリーンアップする。Final-4 のマージ後に実行するため、成功した worker は全て merged 済みで cleanup 対象になる（従来「merge-ready 残置」だった作業コピーもここで整理され、残置問題が解消する）。今回の実行外の orphan は対象外（`/health` 領域 #7 に委譲。[Issue #71](https://github.com/ozzy-labs/skills/issues/71)）。

status 別の cleanup ポリシー（ホスト共通）:

- **`merged`**（Final-4 でマージ完了）: cleanup 対象
- **`merge-ready`**（Final-4 で auto-merge 不可により残置）: cleanup **しない**（ユーザーが手動マージするまで残す）
- **`failed`**: cleanup **しない**（再実行で resume できるよう残置）

具体的な削除手順と既知の落とし穴（cwd 喪失、lock 解除、synthetic branch の残置）は隔離機構に依存するため、ホスト固有の手順に従う（Claude Code: `SKILL.claude-code.md` の「Phase Final-5: subagent worktree cleanup」）。`merged` 以外で残置された作業コピー、または cleanup 自体に失敗した場合は、集約レポート末尾に残置一覧と手動 cleanup 手順を warning として出す。

#### Phase Final-6: 集約レポート

整合性チェック・audit・reconciliation・マージ・cleanup の結果を踏まえ、集約レポートを出力する:

```text
drive 完了 (4/5 merged, 1 skipped):
  #1 feat: ...        | PR #100 | merged
  #2 fix:  ...        | PR #101 | merged       (Review: C0 W0 I2)
  #3 feat: ...        | PR #102 | merged
  #4 chore: ...       | skipped (upstream failed: #5)
  #5 refactor: ...    | failed (test loop)

集計:
  merged:           3
  skipped:          1
  failed:           1
  総レビュー反復:    5 回
  cross-cutting:    2 gaps resolved (folded into PR #100, #102)
  cleanup:          3/5 removed (2 preserved: 1 failed, 1 skipped)
```

`cross-cutting:` 行は Phase Final-3 で reconciliation により解消した gap 数と畳み込み先 PR を `<N> gaps resolved (folded into ...)` 形式で表示する。専用 reconciliation PR を作成・マージした場合はそれも merged リストの 1 行として現れ、`folded into` にその PR 番号を含める。gap が 0 件なら `cross-cutting: none`。fail-soft で残った gap があれば `<N> resolved, <M> unresolved (warning)` とし、warning ブロックに未解決分と手動対応の推奨を出す。

## 失敗 semantics

| 状況 | 扱い | downstream への影響 |
|---|---|---|
| review loop 上限後も観点別 exit_criteria 未達 | partial success（merge-ready） | 影響なし |
| Phase Final-4 で auto-merge 不可（branch protection 等） | 当該 PR を merge-ready 残置 | 依存下流を skipped |
| implement / ship 中断（テスト失敗等） | failed | skipped |
| reconciliation の畳み込み失敗 | fail-soft（gap を warning 残置） | 影響なし（PR 自体は merge-ready） |
| 独立 task の失敗 | 他並列 task に影響させない | - |

## 注意事項

- .env ファイルは読み取り・ステージングしない
- `gh` CLI が未認証の場合はエラーメッセージを表示して中断する
- マージはデフォルトでは行わない。`--merge` 指定時のみ実行する（単一モードは Phase 4 で Auto-merge、オーケストレーションは Phase Final-4 で親が依存順に一元マージ）
- オーケストレーションの worker は self-merge しない（`merge-ready` で停止し親が Final-4 でマージ）。これによりマージ前に cross-cutting を畳み込める
- Info 指摘は修正せず報告のみ（設計判断に関わる変更を機械的に行わない）
- オーケストレーションモードでは worker を必ず隔離された作業コピーで起動する（隔離機構はホスト依存）
- 並列度 8 超過は警告のみ。GitHub Actions 同時実行枠 / API rate limit / 観測性 / コストに注意
- 循環依存を検出した場合はエラー報告して中断する
