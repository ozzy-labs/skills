---
argument-hint: <#N | #N,#N | #N-N | instruction> [--merge] [--concurrency N] [--review=quick|final-deep|deep] [--no-usage-guard]
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch, AskUserQuestion, Agent, Workflow
---

# drive

`.agents/skills/drive/SKILL.md` を Read し、ワークフロー手順に従う。

**重要:** 各フェーズでは対応するスキルの SKILL.md を Read して**ワークフロー手順のみ**を実行する。読み込んだ SKILL.md 内の「次のアクション提案」セクションおよび「完了報告」セクションは**すべて無視**する。フェーズ間の遷移は本スキルが制御する。

## Claude Code 固有の追加事項

### 入力解析

`$ARGUMENTS` を解析し、target リスト（Issue/PR/指示）と依存記法、オプション（`--merge`, `--concurrency N`, `--review=<mode>`, `--no-usage-guard`）を特定する。決定論的な展開・DAG/wave 構築・モード分岐は canonical と同じく `drive-plan.mjs`（`~/.claude/skills/drive/drive-plan.mjs`、dogfood は `<repo>/.claude/skills/drive/drive-plan.mjs`）に委譲し、集約レポート整形は `drive-report.mjs` に委譲する。

- target が 1 件かつ依存記法（`->`）なし → 単一モード
- target が 2 件以上、または依存記法あり → オーケストレーションモード

`--review` の取り扱い:

- 既定は `quick`
- 単一モード: `quick` / `final-deep` / `deep` をすべて受け付ける
- オーケストレーションモード: `--review=quick` を強制し、`final-deep` / `deep` 指定時は警告を表示して `quick` にフォールバックする（コスト管理）

usage-guard の取り扱い:

- **既定で有効（opt-out）**。明示的に `--no-usage-guard` を付けたときのみ checkpoint を挟まない素の drive を実行する。
- `--no-usage-guard` 未指定なら、後述「usage-guard 配線（既定 ON・`--no-usage-guard` で無効化）」の checkpoint で usage-guard エンジンを呼び、Usage Limit 超過時は枠回復まで待機してから自己再入する。
- `--usage-guard` は後方互換の **deprecated no-op エイリアス**として受理する（既定 ON のため明示は不要・挙動は既定と同一）。継続コマンドには強制付与しない。
- 解析時に**元の引数列を保存**する（継続コマンド `/drive <元の引数>` と、失敗時レポートの再開行 `再開: /drive <元の引数>` — canonical の Phase 5 / Phase Final-6、`failed` / `merge-ready` 残置 / `skipped` があるときのみ — の組み立てに使う）。`--no-usage-guard` がユーザー指定されていた場合のみ保存対象に含めて継続コマンドにも引き継ぐ。`--usage-guard` は no-op エイリアスなので保存・付与しない。

### 自律実行

計画承認を含め、マージ処理（またはマージ確認）まで AskUserQuestion を使用しない（完全自律実行）。

### usage-guard 配線（既定 ON・`--no-usage-guard` で無効化）

**既定で有効**。Claude Code の Usage Limit（5 時間 = Current / 週次 = Weekly）が 100% に達する前に作業を一時停止し、枠が回復したら自動再開する。**`--no-usage-guard` 指定時のみ本節の処理を一切実行せず、drive 本体の挙動を変えない**（pause/resume は Claude 固有なので配線を本 overlay に閉じる。前例: `review --deep`）。`--usage-guard` は deprecated no-op エイリアスとして受理するが、既定で有効なため挙動は変わらない。

> **Claude 専用**: usage-guard エンジンは OAuth 使用率エンドポイントと `ScheduleWakeup` に依存するため Claude Code でのみ動作する（`adapters: claude-code` で gate された `usage-guard` skill = #121）。base SKILL.md は既定 ON だが、他アダプタ（codex/gemini/copilot）のビルド出力には本 overlay が含まれないため実効は no-op。

#### graceful degrade（skill 不在）

既定 ON のため、usage-guard skill / `usage-check.mjs` が**存在しない環境**（例: `~/.claude/skills/usage-guard/` 未配置）でも drive を**エラーで止めない**。各 checkpoint の冒頭で `usage-guard` skill（`.claude/skills/usage-guard/SKILL.md`、user-scope では `~/.claude/skills/usage-guard/SKILL.md`）の存在を確認し、**不在を検出したら 1 行警告**（例: 「⚠️ usage-guard 劣化: skill 未インストール、監視せず通常進行します」）**を出してそのまま通常進行する**（fail-open 扱い・以降の checkpoint も skip）。これはデフォルト ON の必須要件であり、guard が自不在で drive を hard-stop させない。

#### checkpoint の発火点

`--no-usage-guard` 未指定（= 既定 ON）のとき、以下の **resumable unit の入口**でのみ usage-guard を呼ぶ:

| モード | checkpoint |
|---|---|
| 単一モード | 各 target の **Phase 1（implement）開始前** |
| 単一モード | **review loop の各反復前**（Phase 3 の各 pass 開始前） |
| オーケストレーション | 各 **wave の開始前**（Phase 1..N の wave ループ先頭） |
| オーケストレーション | 各 **worker dispatch 前**（同一 wave 内で worker を起動する直前） |

**checkpoint は常にクリーンに再入できる境界に置く**。mid-implement（PR がまだ存在しない実装途中）や review pass の途中、コミット/push の途中では**止めない** — そこで停止すると再入時に進捗を取りこぼす恐れがある。drive は冪等 resume（既存 PR を検出して Phase 3 から再開）なので、上記の境界はいずれも再実行で安全に続きから再開できる。

#### checkpoint での手順

各 checkpoint で以下を実行する:

1. `usage-guard` エンジン（`.claude/skills/usage-guard/SKILL.md`、user-scope では `~/.claude/skills/usage-guard/SKILL.md`）を Read し、その「軽量 wait-loop」を実行する（= 同階層の `usage-check.mjs` を Bash 実行して JSON を得る）。
   - **wave / worker dispatch checkpoint（オーケストレーション）では headroom-aware に gate する（#141）**: wave dispatch は **N 個の中断不能 worker** を確定起動し、それらは走行中に枠を消費する。現在値だけで判定すると 1 wave 分の見込み消費を見込めず、wave 走行中に閾値を飛び越えて overshoot する（実観測: `five_hour` 86% → 1 wave で 98%、3-worker 並列）。これを防ぐため、dispatch checkpoint では `usage-check.mjs --headroom <pct>` を渡し、**見込み post-dispatch 値**（`util + reserve(N) >= threshold`）で gate する。`reserve(N)` は並列度 `N`（`--concurrency`、既定 `min(4, wave 内タスク数)`）に比例した予約。**目安は `reserve = N × per_worker_pct`**（`per_worker_pct` は heavy worker 1 本あたりの見込み消費。実観測の `86→98 / 3-worker ≈ 4pt/worker` を初期値に、env `USAGE_GUARD_DISPATCH_HEADROOM` で上書き）。例: `concurrency=3`・`per_worker≈4pt` → `--headroom 12` → `threshold(95) − 12 = 83%` を超えていれば dispatch 前に pause。`--concurrency` が大きいほど reserve を増やす。
   - **単一モードの Phase1 / review-loop checkpoint は headroom を渡さない**（= 既定 0、現在値で gate。従来どおり）。1 unit の消費は中断可能境界で吸収できるため reserve は不要。
2. `ok: true`（両枠とも閾値未満。dispatch checkpoint では `util + reserve` が閾値未満）→ **通常進行**。次のフェーズ／wave／worker dispatch へそのまま進む。
3. `ok: false`（いずれかの枠が閾値超過）→ usage-guard の wait-loop に委譲する。`wait_seconds` にはポストリセットのバッファ（`resume_buffer_seconds`、既定 +300 秒）が折り込まれており、待機は `resets_at + buffer` まで延びる（リセット丁度の再突入による再ハネを回避）:
   - in-session・待機 ≤1h → `ScheduleWakeup(min(wait_seconds, 3600))` で heartbeat を仕込み、**待機する**（待機中は再入せず予算を消費しない）。`wait_seconds` が 3600 を超える場合は複数回に分けて再チェックする。
   - 非 /loop オーケストレーション（Agent tool / Workflow drive）・待機 >1h・再起動耐性が必要 → `CronCreate`（`recurring: false`, durable）を **`resets_at + resume_buffer_seconds`** にセットし、発火時に継続コマンドを再投入する（壁時計一発・再起動耐性。one-shot は発火後 auto-delete）。既定 ON によりこの経路（>1h・非 /loop）を踏みやすいため、該当時は `ScheduleWakeup` ではなく **`CronCreate`(one-shot, durable)** を優先する。詳細は usage-guard SKILL.md §軽量 wait-loop「再開トリガの選択」。
   - **反映ラグ疑い時（`suspected_reflection_lag: true`）は境界に長時間 CronCreate を張らず、短間隔（`wait_seconds` ≈ 180 秒）で `ScheduleWakeup` 再チェック**する（境界直後の前枠残像による偽 100% を回復確認後に拾い、~5h 放置の偽陰性を回避。usage-guard SKILL.md §振る舞い: 反映ラグ検知 を参照）。
   - 起床したら継続コマンド **`/drive <元の引数>`** を自己再入する（既定 ON のため `--usage-guard` を強制付与しない。`--no-usage-guard` がユーザー指定されていた場合のみ引き継ぐ ── ただし `--no-usage-guard` 時はそもそも本節を実行しないため、実際の継続コマンドは元の引数をそのまま渡せばよい）。drive の冪等 resume が既存 PR / ブランチ / 完了済み worker を検出して**続きから再開**する（待機を挟んでも重複副作用を生まない）。
   - `usage-check.mjs` が `ok: true` を返すまで 3〜4 を繰り返す。

> 継続コマンドには**元の引数列**をそのまま渡す（既定 ON のため `--usage-guard` の付与は不要。resume 後も guard は既定で効き続ける）。

#### 粒度と二重化（in-wave overshoot への二層防御・#141）

orchestration の停止は **wave 境界 / worker dispatch 境界の粒度**。ここには構造的な失敗モードがある:

- **失敗モード（in-wave overshoot）**: 境界 checkpoint が `ok:true` で dispatch しても、起動した N 本の worker は**走行中に枠を消費する**。境界 checkpoint は走行中には効かないため、wave 走行中に閾値を飛び越えて 100% に到達し得る。`ok:false` は次の境界で**事後検知**されるだけで、その wave の overshoot は防げない（実観測: dispatch 前 86%・threshold 95 → 3-worker 並列 → 走行中 98%）。**threshold 引き下げは並列度を見込めない stopgap で代替にならない**。

これを **二層防御**で塞ぐ:

1. **境界の resumable pause（headroom-aware・予防）**: wave / worker dispatch checkpoint で `usage-check.mjs --headroom <pct>`（`reserve(N)` を `--concurrency` から算出）を渡し、**見込み post-dispatch 値**で gate して dispatch 自体を見込みで止める（前述「checkpoint での手順」step 1）。headroom-trip 時の待機は枠端 + buffer（枠リセットで headroom が回復する）。
2. **mid-unit ceiling（#123 PreToolUse hook・確実な天井）**: 一度起動した worker の走行中（mid-unit）超過は境界では止まらない。**全 tool 呼び出し前に効き subagent 内にも届く** #123 hook が唯一の確実な天井。`/drive` の wave 並列を回す環境では `matcher:"*"` の hook を**既定で配線することを推奨**する（#141）。以前は **pre-#139** の hook が一過性異常値で hard-stop するリスクから「推奨併用」止まりだったが、**#139（file kill-switch / 反映ラグ ALLOW / debounce / spike 棄却）で hard-stop リスクが解消された**ため、既定配線が安全になった。万一の誤 deny は **`touch ~/.claude/usage-guard/DISABLE`** で即解除できる（usage-guard SKILL.md §無効化）。配線手順は usage-guard SKILL.md §PreToolUse hook を有効化。

> 境界 pause（headroom-aware）と mid-unit hook は**どちらか一方では不十分**。headroom は「dispatch を見込みで止める」予防、hook は「走行中の確実な天井」。両者を揃えて初めて overshoot を実用上塞げる。

- worker（subagent）に渡す prompt 自体は無改変でよい。worker は単一モードを実行するため、**親が（既定 ON で）worker dispatch 前に headroom-aware checkpoint を挟む**ことで wave 粒度の予算対応になる。

#### fail-open（劣化可視化）

usage-check のシグナル取得が全滅（endpoint → JSONL フォールバックともに失敗）した場合、usage-guard は `ok: true`（fail-open）を返す。drive はそのまま通常進行する — **ガードが自バグで drive を hard-stop させない**。

ただし fail-open は**ガードが事実上 OFF**の状態。checkpoint で得た JSON の `source` が `endpoint` / `cache` 以外（特に `fail-open`）のとき、drive caller は**劣化を明示報告に残す**（例: 「⚠️ usage-guard 劣化: source=fail-open、実際には監視していません」）。endpoint 経路が使えていない原因（api.anthropic.com egress / `~/.claude/.credentials.json` 読み取りの権限）と復旧方法は usage-guard SKILL.md §環境要件 を参照。走行中 worker の PreToolUse hook も同様に劣化警告を stderr に出す。

### オーケストレーション実行機構の選択

オーケストレーションモードの worker 並列実行には 2 つの機構がある。**Workflow tool が利用可能なら Workflow 方式を優先**し、利用不可（dynamic workflows 無効環境・旧バージョン）なら従来の Agent tool 方式（「subagent dispatch」節）に fallback する。

| | Workflow 方式 | Agent tool 方式 |
|---|---|---|
| 並列制御 | ランタイムが cap・キュー管理 | 手動 semaphore |
| worktree 隔離 | `isolation: 'worktree'` | `isolation: "worktree"` |
| 戻り値検証 | `schema` で構造化検証（不一致は自動リトライ） | JSON 自由記述を親が parse |
| 進捗監視 | `/workflows` UI + `log()` | `gh pr list` polling |
| 中断再開 | `resumeFromRunId`（完了 worker はキャッシュ復元） | 手動再実行 |

### Workflow 方式によるオーケストレーション（推奨）

Phase 0（DAG / wave 構築）と計画表示は**Workflow 起動前に会話側で**行う（workflow はミッドランのユーザー入力を受けられないため、承認系はすべて起動前後に置く）。wave 構成を `args` で渡し、以下の形のスクリプトを組む:

```js
export const meta = {
  name: 'drive-orchestration',
  description: 'drive: wave 単位で worker を並列実行し merge-ready PR 群を作る',
  phases: [{ title: 'Wave 1' }, { title: 'Wave 2' }],  // 実際の wave 数に合わせて起動時に書く（pure literal）
}

// canonical（.agents/skills/drive/SKILL.md）の戻り値 JSON contract を JSON Schema 化したもの
const WORKER_SCHEMA = { /* target / title / branch / pr_url / pr_number / status / review / cross_cutting_gaps / final_head_state / error */ }

const results = []
const failed = new Set()
for (const [i, wave] of args.waves.entries()) {
  // 依存元が failed の target は dispatch せず skipped 扱いにする（canonical の失敗 semantics）
  const runnable = wave.filter(t => !t.deps?.some(d => failed.has(d)))
  wave.filter(t => !runnable.includes(t)).forEach(t => {
    results.push({ target: t.target, status: 'skipped', error: `upstream failed: ${t.deps.join(',')}` })
    log(`${t.target} skipped (upstream failed)`)
  })
  // --concurrency N がランタイム cap より小さい場合は runnable を N 件ずつのスライスに割って直列に流す
  const waveResults = await parallel(runnable.map(t => () =>
    agent(workerPrompt(t), { label: t.target, phase: `Wave ${i + 1}`, isolation: 'worktree', schema: WORKER_SCHEMA })
  ))
  for (const r of waveResults) {
    if (!r) continue
    results.push(r)
    if (r.status === 'failed') failed.add(r.target)
    log(`${r.target} → ${r.pr_url ?? '-'} (${r.status})`)
  }
}
return { results }
```

`workerPrompt(t)` には以下を必ず含める（Agent tool 方式の「subagent dispatch」と同一の制約。ランタイムの worktree 隔離は cleanup を肩代わりするが、worker の git 操作自体は防がないため prompt 制約は省略不可）:

- canonical SKILL.md を Read して単一モード Phase 1-3 を実行する指示（**Phase 4 マージは実行しない・`merge-ready` で停止**）
- main / 親側 ref への書き込み禁止コマンド一覧
- Edit / Write tool の `file_path` 制約（自 worktree path 限定）
- マージ禁止（`gh pr merge` を呼ばない）
- ベースブランチ規則（依存元 wave がある target は headRefName ベースの stacked。self-merge しないため `--merge` 有無を問わず stacked）
- 戻り値 JSON contract（`status` は最大 `merge-ready` / `final_head_state` / `cross_cutting_gaps` 含む）

Workflow 方式固有の注意:

- **スクリプト内で `Date.now()` / `Math.random()` / 引数なし `new Date()` は使えない**（resume 決定性のためランタイムが throw する）。タイムスタンプが必要なら `args` で渡す
- 観測性は `/workflows` UI と `log()` が担う。Agent tool 方式の `gh pr list` polling は不要
- wave 間の `await` は依存関係による**意図的バリア**（pipeline 化しない）
- workflow 内 worker は `acceptEdits` 固定でセッションの allowlist を継承する。長時間 run で permission prompt が出ないよう、必要コマンドが allowlist にあることを起動前に確認する
- 途中失敗からの再開は `Workflow({scriptPath, resumeFromRunId})`。完了済み worker はキャッシュから復元される
- **Phase Final-1〜Final-6 は workflow 終了後に会話側で実行する**。worker の worktree は変更を含むためランタイムの自動削除対象にならず、Final-2 audit / Final-3 reconciliation はこの残存 worktree 内で行い、cleanup（Final-5 節）は最後尾で行う。worktree path 規約（`.claude/worktrees/agent-<id>/`）も同一
- **Final-3 reconciliation の畳み込みも workflow の return 後に会話側で**行う（gap を `source_pr` で groupBy し、PR ごとに `parallel()` で並列 fold できる。同一 PR 内は直列）。あるいは reconciliation 専用の小 workflow を別途起動してもよい
- Final-4 マージ（`--merge` 指定時の親一元・依存順マージ）、および `--merge` 未指定時の一括マージ確認（「完了後」節の AskUserQuestion）は workflow の return 後に行う
- **wave checkpoint は会話側で挟む**（既定 ON。`--no-usage-guard` 指定時は省略）。workflow スクリプトは決定論実行で SKILL.md の Read も `ScheduleWakeup` も呼べないため、wave 単位で workflow を起動し、各 wave の起動**前**に会話側で「usage-guard 配線」節の checkpoint を **headroom-aware に**（`--headroom` を `--concurrency` から算出。#141）実行する（`ok` なら次 wave の workflow を起動、超過なら待機 → `/drive <元の引数>` で再入し、`resumeFromRunId` で完了済み worker をキャッシュ復元して続行）。workflow 走行中（dispatch 済み worker の mid-unit 超過）は #123 PreToolUse hook が天井を担う（§粒度と二重化）

### subagent dispatch（オーケストレーションモード・Agent tool 方式 fallback）

オーケストレーションモードでは `Agent` tool で各 target を並列実行する:

- **isolation:** `"worktree"`（必須）
- **subagent_type:** `general-purpose`
- **prompt:** subagent から slash command は呼べないため、`.agents/skills/drive/SKILL.md` を Read させ、target #N について単一モードのワークフロー（Phase 1-3）を実行するよう指示する。**worker は Phase 4（マージ）を実行しない** — レビュー通過後 `merge-ready` で停止し、`gh pr merge` を一切呼ばずに JSON を返させる（`--merge` 指定時も同じ。マージは親が Phase Final-4 で一元管理する）。最終結果は JSON で返させる
- **main / 親側 ref への書き込み禁止（必ず prompt に明記）:** subagent は自 worktree branch で完結する。以下のコマンドは全て**禁止** — 親 worktree の `HEAD` / `index` / `refs/heads/main` を共有 git directory 経由で汚染する ([Issue #66](https://github.com/ozzy-labs/skills/issues/66) / [Issue #89](https://github.com/ozzy-labs/skills/issues/89))。worktree は親側で削除されるため main へ戻す必要はない:
  - `git checkout main` / `git switch main` / `git checkout HEAD~` (HEAD 移動)
  - `git symbolic-ref HEAD refs/heads/main` (HEAD を符号的に main へ切替)
  - `git update-ref refs/heads/main <sha>` (main ref を直接書き換え)
  - `git reset --hard origin/main` (自 branch が main を指す状態で実行すると間接的に親に伝播)
  - `git branch -m <new-name>` (worktree-branch binding を壊す)
  - `git push origin main` / `git push origin HEAD:main`
- **戻り値 JSON に `final_head_state` を必須化（必ず prompt に明記）:** subagent 完了時、自 worktree の `git symbolic-ref HEAD` / `git rev-parse HEAD` / `git status --short` 出力を戻り値 JSON の `final_head_state` フィールドに含める。`symbolic_ref` が `refs/heads/main` または空（detached）なら親側 Phase Final-1 で warning。これは「main checkout なし」の自己申告と実態が乖離した観察 ([Issue #89](https://github.com/ozzy-labs/skills/issues/89)) への対策で、self-attestation を検証可能にする
- **Edit / Write tool の `file_path` 制約（必ず prompt に明記）:** subagent の Edit / Write tool に渡す `file_path` は必ず自 worktree path（`.claude/worktrees/agent-<id>/`）で始まる absolute path に限定する。親 worktree path（repo root 直下で `.claude/worktrees/` を含まない path）を渡してはならない。Phase 20 (opshub) で観察した汚染は **`cd` ではなく Edit/Write の絶対 path 引数経由**で発生したため、本制約が決定的。実行前に `pwd` で自 worktree path を確認してから tool に渡すと安全（[Issue #77](https://github.com/ozzy-labs/skills/issues/77)）
- **マージ禁止（必ず prompt に明記）:** subagent は `gh pr merge` を一切呼ばない（`--auto` も `--delete-branch` も付けない）。self-merge するとマージ済みで cross-cutting を畳み込めず follow-up が残る。加えて `--delete-branch` は自 worktree が握る branch の削除に失敗する（`fatal: '<branch>' is already used by worktree at ...`）。マージ・ローカル branch / worktree の整理はすべて親側 Phase Final（Final-4 マージ / Final-5 cleanup）で処理する（[Issue #69](https://github.com/ozzy-labs/skills/issues/69) / [#166](https://github.com/ozzy-labs/skills/issues/166)）
- **scope 外波及チェック（必ず prompt に明記）:** subagent が enum / field / CLI flag を追加した場合、リポ全体で対応する help 文字列・エラーメッセージ・サンプル/docs を grep し、同期を確認する。同期されていなければ可能なら自 PR に含める。自 scope を明確に超える場合は戻り値 JSON の `cross_cutting_gaps: string[]` フィールドに `<file>:<line> — <symbol> not synced` 形式で記録し、親の Phase Final-2 audit に集約する（[Issue #70](https://github.com/ozzy-labs/skills/issues/70)）
- **依存元 wave がある場合のベースブランチ:** worker は self-merge しないため run 中は依存元も未マージ。よって `--merge` 有無にかかわらず **依存元 PR の headRefName をベースに stacked PR として作成する**（親が Phase Final-4 で依存順にマージする際、下流の base を main へ付け替える）
- **並列起動:** 同一 wave 内の独立 subagent は **1 メッセージ複数 tool call** で並列起動する
- **並列度:** `min(4, wave 内タスク数)`、`--concurrency N` で上書き、8 超は警告のみ
- **wave 内タスク数 > 並列度:** semaphore 方式で空きスロット待ち（先に起動した subagent の完了を待ってから次を起動）

### 観測性

- Phase 0 完了時に wave 構成と target リストを表示する
- `Agent` tool は最終結果のみを返すためストリーム的な中間報告は不可。親は wave 起動時刻 `<T>` を ISO 8601 で記録し、30 秒間隔で `gh pr list --author @me --state open --search "created:>=<T>" --json number,url,headRefName,title` を polling する。既知 PR との差分から新規 PR を検出して URL を即時表示する
- Phase Final で集約レポートを出力する

### Phase Final-1: 親 worktree 整合性チェック

subagent が共有 git directory 経由で親の `HEAD` / `index` / `refs/heads/main` を汚染するケースに備えるための fail-safe（[Issue #66](https://github.com/ozzy-labs/skills/issues/66) / [Issue #77](https://github.com/ozzy-labs/skills/issues/77) / [Issue #89](https://github.com/ozzy-labs/skills/issues/89) 由来）。**検出 7 軸（+ 戻り値 `final_head_state` 交差確認）と recovery シーケンスの実行詳細は [`worktree-safety.claude-code.md`](worktree-safety.claude-code.md) の「汚染検出 7 軸」「recovery シーケンス」を参照する。** いずれかが不一致なら集約レポート末尾に warning + recovery 手順を出す。

### Phase Final-2: cross-cutting audit（マージ前・worker worktree 内で並列）

canonical（`.agents/skills/drive/SKILL.md`）の Phase Final-2 の検出内容（worker 報告集約 / enum-flag sync / stale 文言 / lockfile drift / docs-code）に従う。Claude Code 固有の実行:

- 各 worker の worktree（`.claude/worktrees/agent-<id>/`、Final-5 まで残存）内で grep を実行する。`gh pr diff <N>` で PR 固有 diff を取り、抽出 symbol を当該 worktree 内で `rg` する
- **PR ごとに並列**実行する（Agent tool 方式なら 1 メッセージ複数 tool call、Workflow 方式なら return 後に会話側で `parallel()`）。各 gap を `source_pr` に attribution して Final-3 へ渡す

### Phase Final-3: reconciliation（導入元 PR へ畳み込み・PR 単位で並列）

canonical の Phase Final-3 に従い、gap を `source_pr` で groupBy して導入元 PR の worktree で修正・push する。Claude Code 固有の実行:

- 各 gap の `source_pr` に対応する worker worktree（`.claude/worktrees/agent-<id>/`）で対象ファイルを Edit（`file_path` は自 worktree path 限定）→ lint → commit（`fix(sync): ...`）→ `git push`
- **PR ごとに並列**（別 worktree で衝突しない。Agent tool は複数 tool call、Workflow は `parallel(gaps.groupBy(pr))`）。**同一 PR 内の複数 gap は直列**（同一 worktree 共有）
- full review loop は回さない（lint pass のみ）。畳み込みが衝突する / 複数 PR 跨ぎの gap は専用 reconciliation PR へフォールバックし、全 content PR マージ後に main を base として Phase Final-4 の末尾でマージする（canonical Final-3 参照）。畳み込み失敗は fail-soft で warning に残す

### Phase Final-4: 依存順マージ（親一元）

canonical の Phase Final-4 に従い、`--merge` 指定時に親が topological order でマージする。Claude Code 固有の注意:

- **`gh pr merge --squash` は `--delete-branch` を付けない**（worker worktree が当該 branch を握って残存中のため local branch 削除が worktree lock で失敗する。branch / worktree の削除は Final-5 cleanup に一本化）
- 下流 PR の base 付け替え（`gh pr edit <下流> --base main`）後に phantom conflict が出る場合、下流の worktree 内で `git rebase origin/main` → `git push --force-with-lease`（自 worktree branch に限定。親 ref は触らない）してから次をマージする
- 親 worktree の HEAD / main ref は操作しない。マージは `gh` API 経由（リモート操作）なので親のローカル git 状態は不変のまま進む

### Phase Final-5: subagent worktree cleanup

Final-4 のマージ後に実行する。status 別 cleanup ポリシー（`merged` は削除 / `merge-ready`・`failed` は残置）は canonical の Phase Final-5 に従う。**Claude Code worktree 機構固有の実行手順（subshell による cwd 喪失回避、`-f -f` lock 解除、`worktree-agent-*` synthetic branch の残置確認）は [`worktree-safety.claude-code.md`](worktree-safety.claude-code.md) の「cleanup 実行手順」を参照する**（[Issue #69](https://github.com/ozzy-labs/skills/issues/69) / [Issue #90](https://github.com/ozzy-labs/skills/issues/90) 由来）。`merged` 以外で残置 / cleanup 失敗があれば集約レポート末尾に残置一覧と手動 cleanup 手順を warning として出す。

### 中断時

いずれかのフェーズで中断した場合、AskUserQuestion で次のアクションを確認する:

- **「エラーを修正して再開する」** → 中断したフェーズから再開
- **「中断する」** → 終了

オーケストレーションモードで一部 task のみ失敗の場合は、Phase Final レポート出力後に AskUserQuestion で再開対象を確認する。

### 完了後

#### 単一モード

1. **`--merge` 指定時:** Phase 4 の手順に従いマージを実行し、結果を報告して終了する
2. **`--merge` 未指定時:** AskUserQuestion を呼び出す（`answers` パラメータは設定しない）
   - **「PR をマージする」** → `gh pr merge --squash --delete-branch` でマージを実行し、結果を報告する
   - **「追加の変更を行う」** → 終了する

#### オーケストレーションモード

Phase Final は `--merge` 有無を問わず Final-1（整合性）→ Final-2（audit）→ Final-3（reconciliation）まで実行する（PR を gap-free で確定させる）。分岐は Final-4 マージのみ:

1. **`--merge` 指定時:** Phase Final-4 で親が依存順にマージし、Final-5 cleanup（マージ済み worker を整理）→ Final-6 集約レポートを出力して終了する
2. **`--merge` 未指定時:** Final-3 まで完了した後、AskUserQuestion を呼び出す（`answers` パラメータは設定しない）
   - **「全 PR を一括マージする」** → Phase Final-4 の依存順マージを実行し、続けて Final-5 cleanup → Final-6 レポートを出力する
   - **「個別に対応する」** → Final-6 レポートを出力して終了する。`merge-ready` の worktree は残置されたまま。ユーザーがマージ後に `/health` 領域 #7 または手動で整理する
