# CLAUDE.md

共通方針は AGENTS.md を参照。以下は Claude Code 固有の設定。

## 基本ルール

- ユーザーへの確認には `AskUserQuestion` を使用する

## Available Skills

- `/drive` などの汎用 skill は **user skills** (`~/.claude/skills/`) として配置されることを想定。エンドユーザーは `npx @ozzylabs/skills install` で installation する
- skills / commons リポ内部 (本リポ等) では project skills として `.claude/skills/` 配下に置かれている (build pipeline で SSOT から生成)
- 特定アダプタ限定の skill は SSOT 側 frontmatter `adapters`（カンマ区切り・例 `adapters: claude-code`）で配信先を絞れる (詳細は AGENTS.md / README.md「Adapter gating」)
- `/implement` — Issue または指示をもとに、ブランチ作成・実装
- `/commit` — 変更をステージし、Conventional Commits でコミット
- `/pr` — 変更を push し、PR を作成・更新
- `/review` — コード変更や PR を 11 観点（正確性 / セキュリティ / 規約 / アーキテクチャ / 互換性 / 保守性 / テスト / パフォーマンス / 可観測性 / ユーザビリティ / ドキュメント整合性）でレビューし、JSON 構造化出力を併載。`--axes=<list>` で観点指定、`--deep` で観点別 subagent 並列起動
- `/ship` — lint・コミット・PR 作成を一括実行
- `/verify` — ビルド + 型 + テスト + lint の複合検証を `verify.mjs` エンジンで実行。検証コマンド発見連鎖（AGENTS.md「検証」節 → package.json scripts → justfile/Makefile/lefthook → 言語 heuristic）で発見し、最初にヒットした段のみ実行（段跨ぎ禁止・同段内は全実行）、各コマンドに出典を付けて直列実行し JSON サマリを返す。`--dry-run` で発見のみ。旧 `lint-rules` の拡張子別 lint 規則を内包（ADR-0028 R4）
- `/drive` — implement + ship + review loop（Issue から merge-ready な PR まで自律駆動）。`--review=quick|final-deep|deep` で review モード切替（既定 quick）。usage-guard（**Claude Code only**・**既定 ON**、`--no-usage-guard` で無効化、`--usage-guard` は deprecated no-op エイリアス）で予算対応: resumable unit の入口（Phase 1 開始前 / review loop 各反復前 / 各 wave 開始前 / worker dispatch 前）で `usage-guard` エンジンを Read し、Usage Limit 超過なら枠回復まで待機 → `/drive <元の引数>` で冪等 resume。skill 不在なら 1 行警告 + 通常進行（fail-open）。orchestration は wave 境界粒度、走行中 worker は PreToolUse hook が ceiling。オーケストレーションの `--merge` は **1 run 自己完結**: worker は self-merge せず親がマージを一元管理し、マージ前に cross-cutting audit（Final-2）→ 導入元 PR へ reconciliation 畳み込み（Final-3）→ 依存順マージ（Final-4）で follow-up を残さない（[#166](https://github.com/ozzy-labs/skills/issues/166)）
- `/backlog` — open issue を `backlog.mjs` エンジンで収集し drive へ接続する上流 skill（ADR-0028 R1 + R5）。依存抽出は drive エンジンの規則（`drive-plan.mjs` の `detectBodyDeps` / `topoWaves`、単一 SSOT・再掲しない）を import 再利用し、固定語彙の優先度規則（(a) blocker（他 issue から依存される）/ (b) milestone 期限昇順 / (c) `priority:high` ラベル / (d) updatedAt 古い順・issue 番号 tie-break）で並べ、drive 引数形式（例 `#12,#15 -> #18`）で出力。既定は候補提示のみ、`--drive[=N]` は上位 N 件 + 依存閉包を確認後 `/drive` 起動、`--auto` は無確認だが **`auto-ok` ラベル付き issue のみ対象**（HATL・ゲーティングなしの `--auto` は存在しない）。drive 起動は中央 autonomy policy（`policy-read.mjs` の `externally-visible` gate・既定 batch-confirm）に従う。単一リポのみ（[#175](https://github.com/ozzy-labs/skills/issues/175)）
- `/deps` — automation PR（renovate / dependabot）の policy-based triage を `deps.mjs` エンジンで実行（ADR-0028 R1 + R3）。open な bot PR を列挙（author 判定は **health 領域 15 と同一** — `*[bot]` / `app/*`、`tests/deps.test.mjs` の sync assertion で drift 防止。**release-please は除外**＝ `/release` の責務）し、semver 区分（PR タイトル / branch / manifest diff、**grouped は最大 bump**）・CI 状態（`gh pr checks`）・lockfile 整合・peer / engines 変更で固定語彙判定する: **patch/minor + CI green + lockfile 整合 + peer/engines なし → `auto-merge` 候補**、**major / CI red / pending / no-checks / 区分不能 / lockfile drift / peer / engines → `要確認`**（保守側）。`--dry-run` は判定のみ（`--auto` より優先・誤 merge 防止）、`--auto` は確認なし merge。merge（`gh pr merge --squash`）は不可逆で中央 autonomy policy（`policy-read.mjs` の `--action=merge`・`irreversible`・ゼロコンフィグ既定 `ask`）に従い、`--auto` が明示 opt-out。単一リポのみ（[#176](https://github.com/ozzy-labs/skills/issues/176)）
- `/ci-fix` — 失敗した CI run のログを収集してコンテキストを整形し `/drive` へ接続する薄い wrapper。入力解決（明示 run id > 明示 branch の最新 failure > 現在ブランチの最新 failure、`gh run list --branch <b> --status failure --limit 1`）→ flaky 判定（`gh run rerun --failed` 1 回 + polling 30s 間隔・上限 15 分、上限到達は `要確認`、`--no-rerun` で skip）→ ログ抽出（`gh run view --log-failed`、ANSI 除去 + エラー行抽出 regex は **health の same-error 判定と同一**（`health-check.mjs` の `extractCiErrorKey`）で `tests/ci-fix.test.mjs` の sync assertion が drift 防止）→ 指示テキスト組み立て → `/drive` 起動。既定は指示テキストを提示して確認、`--auto` で確認 skip、`--dry-run` は指示テキストのみ出力（rerun も drive 起動もしない・副作用なし）。main ブランチの failure（merged コードの破損）は優先度高としてレポート冒頭で明示（[#177](https://github.com/ozzy-labs/skills/issues/177)）
- `/health` — リポジトリ状態と skill catalog 整合性を `health-check.mjs` エンジンで 16 領域確認し、固定語彙の推奨アクションを提示（`--deep` で `要確認` 項目を read-only 追加調査、`--fix` で安全語彙 — prune / delete / fetch と `--deep` 昇格 drop — を中央 autonomy policy（`policy-read.mjs`）の gate に従って実行 — reversible-local=`proceed`（実行 + audit trail）/ irreversible の stash drop=`ask`（個別確認）、`--yes` は明示 opt-out、policy 不在は fail-safe に `ask`）。既定は read-only（[#181](https://github.com/ozzy-labs/skills/issues/181)-PR3）
- `/topics` — research-driven な GitHub topics 設定（ozzy-labs scope）。候補を公式制約検証 → 人気度測定（session キャッシュ）→ broad+narrow / 単数複数比較 → ozzy-labs 慣行ハードコードで選定し、`--apply` で `gh repo edit --add-topic` を実行、`--dry-run` で分析のみ
- `/lessons-triage` — セッション教訓 queue（`~/.agents/lessons/queue.jsonl`）を消化し、User Skills 改善の教訓を承認制で ozzy-labs/skills へ issue 起票（HITL、起票のみ）
- `/usage-guard` — **Claude 専用**。Usage Limit（5 時間 / 週次）を OAuth 使用率エンドポイントで監視し、95%（env で上書き可）超過で自動 pause→`ScheduleWakeup` で待機→回復後に自動再開。drive 等の caller が checkpoint で Read するエンジン形態と、`/usage-guard "<継続コマンド>"`（継続コマンド冪等前提）の単体形態を同梱。endpoint → JSONL → fail-open
- `/skill-metrics` — observability イベントログ（`~/.agents/observability/events.jsonl`）を read-only 集計し、skill 別発火件数 + 注目イベント（fallback / HITL 却下 / loop 上限 / 中断）を提示。小 n ガードで分母が `min_n`（既定 5）未満なら率を出さず件数のみ。`--since` / `--skill` / `--snapshot` 対応。送信なし（反映は lessons-triage）。計測層は被参照 companion `skill-observability`（イベント契約 `event.schema.json` + emit substrate `obs-emit.mjs` + SessionEnd capture hook `obs-derive.mjs`、いずれも fail-open・privacy 最厳格）が提供
- `/phase-issue` — Phase-N tracking issue を生成。cross-session handoff context / 決定事項表 / PR ごとのタスク / DoD / Phase N+1 outlook を含む構造化 issue body を組み立てて `gh issue create` で起票。既定は非対話モード（不足セクションは省略）、不足分を対話で補う Claude Code companion を同梱。`--draft` で起票せず stdout に出力

## Skills の共通ルール

- スキル完了時のネクストアクション提案には `AskUserQuestion` を使用する
- ネクストアクションはユーザーの確認なく実行しない

## CLI Installer (user scope)

各 skill を自分の `$HOME` に user-scope で install したい場合は npm 経由の CLI を使う:

```bash
npx @ozzylabs/skills install --adapter=claude-code             # 全 skill を ~/.claude/skills/ に
npx @ozzylabs/skills install --skills=drive,review --dry-run   # JSON で計画のみ
npx @ozzylabs/skills migrate --dry-run                         # 旧 project-scope 配信の片付け
```

Claude mobile / web (cloud) セッションは "repo only" 動作で `~/.claude/skills/` を見られないため、`install` では届かない。その用途で開発する repo には `sync-project` で **project-scope**（相対 ref を保った `dist/claude-code-project/`）を opt-in 配信する:

```bash
npx @ozzylabs/skills sync-project --target=./my-repo --skills=drive,implement,ship,review,verify,commit,pr,commit-conventions
```

詳細は `README.md` の「CLI installer (user-scoped)」を参照。
