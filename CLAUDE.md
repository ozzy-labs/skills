# CLAUDE.md

共通方針は AGENTS.md を参照。以下は Claude Code 固有の設定。

## 基本ルール

- ユーザーへの確認には `AskUserQuestion` を使用する

## Available Skills

- `/drive` などの汎用 skill は **user skills** (`~/.claude/skills/`) として配置されることを想定。エンドユーザーは `npx @ozzylabs/skills install` で installation する
- skills / commons リポ内部 (本リポ等) では project skills として `.claude/skills/` 配下に置かれている (build pipeline で SSOT から生成)
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
- `/lessons-triage` — セッション教訓 queue（`~/.agents/lessons/queue.jsonl`）を消化し、User Skills 改善の教訓を承認制で ozzy-labs/skills へ issue 起票（HITL、起票のみ）

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
npx @ozzylabs/skills sync-project --target=./my-repo --skills=drive,implement,ship,review,commit,pr,lint,test,commit-conventions,lint-rules
```

詳細は `README.md` の「CLI installer (user-scoped)」を参照。
