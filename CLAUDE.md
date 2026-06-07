# CLAUDE.md

共通方針は AGENTS.md を参照。以下は Claude Code 固有の設定。

## 基本ルール

- ユーザーへの確認には `AskUserQuestion` を使用する

## Available Skills

- `/implement` — Issue または指示をもとに、ブランチ作成・実装
- `/lint` — 全リンターを自動修正付きで実行
- `/test` — ビルド・テスト・型チェックを実行
- `/commit` — 変更をステージし、Conventional Commits でコミット
- `/pr` — 変更を push し、PR を作成・更新
- `/review` — コード変更や PR を 11 観点（正確性 / セキュリティ / 規約 / アーキテクチャ / 互換性 / 保守性 / テスト / パフォーマンス / 可観測性 / ユーザビリティ / ドキュメント整合性）でレビューし、JSON 構造化出力を併載。`--axes=<list>` で観点指定、`--deep` で観点別 subagent 並列起動
- `/ship` — lint・コミット・PR 作成を一括実行
- `/drive` — implement + ship + review loop（Issue から merge-ready な PR まで自律駆動）。`--review=quick|final-deep|deep` で review モード切替（既定 quick）
- `/health` — リポジトリ状態と skill catalog 整合性を 16 領域確認し、推奨アクションを inline 表示（`--deep` で `要確認` 項目を追加調査）
- `/topics` — research-driven な GitHub topics 設定（ozzy-labs scope）。候補を公式制約検証 → 人気度測定（session キャッシュ）→ broad+narrow / 単数複数比較 → ozzy-labs 慣行ハードコードで選定し、`--apply` で `gh repo edit --add-topic` を実行、`--dry-run` で分析のみ
- `/sync-consumers` — skills / commons の更新を `sync-targets.yaml` の 14 consumer リポへ並列に push（PR auto-merge まで）。drive 派生として subagent worktree 隔離 + Phase Final-1/2 を踏襲する

## Skills の共通ルール

- スキル完了時のネクストアクション提案には `AskUserQuestion` を使用する
- ネクストアクションはユーザーの確認なく実行しない
