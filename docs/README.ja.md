[English](../README.md) | 日本語

# @ozzylabs/skills

Claude Code / GitHub Copilot / Gemini CLI / Codex CLI 向けの OzzyLabs 正準エージェントスキルバンドル。

`.agents/skills/{name}/SKILL.md` を SSOT とし、`pnpm build` で `dist/{adapter-id}/` 配下に各 agent 向けの出力を生成する。エンドユーザーは npm package に同梱された CLI installer 経由で **user skills**（例: `~/.claude/skills/`）として install する。

[OzzyLabs handbook ADR-0016](https://github.com/ozzy-labs/handbook/blob/main/adr/0016-create-skills-repo.md) で決定された、skills を `commons` から切り出して専用リポでバージョニングする方針の実装。配布形態は **既定で user skills**（handbook ADR-0027 にて整理予定）であり、consumer は `npx @ozzylabs/skills add` で導入する。各 consumer リポ配下への project skills (`.claude/skills/`) 自動配信は廃止した。例外は **Claude mobile / web (cloud) セッション** で、これは "repo only" 動作のため `~/.claude/skills/` を参照できない。その用途で開発するリポには `npx @ozzylabs/skills add --target <repo>` で相対 ref を保った project-scope payload を opt-in 配信する（[CLI installer](#cli-installer-user-scope) 参照）。それ以外で project skills が残るのは `skills` / `commons` リポ自身の dogfood 用途のみ（build pipeline が SSOT から生成）。

## v0.x 同梱スキル

合計 16 件: OzzyLabs 全リポジトリ共通の 11 件 (reference-only な `policy` companion を含む)、Claude Code 専用 2 件 (`usage-guard` / `skill-observability`)、内部運用専用 3 件 (`health` / `topics` / `phase-issue`) をバンドル。（旧 project-scope レイアウトを片付ける `migrate` subcommand は撤去済み — [#151](https://github.com/ozzy-labs/skills/issues/151)）。

> **破壊的変更（ADR-0028 R4）:** 旧 `lint` / `test` / `lint-rules` skill は削除し、**`verify`**（発見エンジンによる build + 型 + test + lint の複合検証）に一本化した。`/lint` `/test` は `/verify` に置き換える。既存 install 環境は `npx @ozzylabs/skills update --prune` で削除分が消える。詳細は [#182](https://github.com/ozzy-labs/skills/issues/182)。

| スキル | 用途 |
| --- | --- |
| `commit` | 変更をステージし Conventional Commits でコミット |
| `commit-conventions` | コミット / ブランチ / PR の命名規則 |
| `drive` | Issue → merge-ready な PR まで自律駆動するループ |
| `health` | リポジトリ状態と skill catalog 整合性を `health-check.mjs` エンジンで 16 領域確認し、推奨アクションを inline 表示（`--deep` で `要確認` 項目を追加調査、`--fix` で安全語彙 — prune / delete / fetch と `--deep` 昇格 drop — を中央 autonomy policy（`policy-read.mjs`）の gate に従って実行: reversible-local=`proceed`（実行 + audit trail）/ irreversible の stash drop=`ask`（個別確認）、`--yes` は明示 opt-out。policy 不在は fail-safe に `ask`）。既定は read-only |
| `implement` | Issue または指示をもとに、ブランチ作成・実装 |
| `lessons-triage` | セッション教訓 queue（`~/.agents/lessons/queue.jsonl`、dotfiles の `lesson-capture.sh` hook が蓄積）を消化し、transcript から User Skills 改善の教訓を抽出して承認分のみ ozzy-labs/skills へ issue 起票。HITL — issue 起票は中央 autonomy policy の externally-visible gate（batch-confirm: 全教訓を 1 回一括承認）に従う、リポ編集・auto-apply なし |
| `phase-issue` | Phase-N tracking issue を生成。cross-session handoff context / 決定事項表 / PR ごとのタスク / DoD / Phase N+1 outlook を含む構造化 issue body を組み立てて `gh issue create` で起票。既定は引数で全項目を渡す非対話モードで、不足分を対話で補う Claude Code companion を同梱。`--draft` で起票せず stdout に出力 |
| `policy` | 中央 autonomy policy 契約（ADR-0028 R3）を定義する被参照 companion（非 user-invocable）。アクション 3 クラス（reversible-local / externally-visible / irreversible）・gate 語彙（`proceed` / `batch-confirm` / `ask`）・`~/.agents/policy.yaml`（user）+ `.agents/policy.yaml`（repo・user を上書き）階層・現行挙動相当のゼロコンフィグ既定を規定。`policy.schema.json`（schema SSOT）と、2 ファイルをマージして有効 policy を JSON 出力する all-adapter な `policy-read.mjs`（信頼できない値は `ask` に fail-safe）を同梱 |
| `pr` | 変更を push し PR を作成・更新 |
| `review` | コード変更や PR を 11 観点（正確性 / セキュリティ / 規約 / アーキテクチャ / 互換性 / 保守性 / テスト / パフォーマンス / 可観測性 / ユーザビリティ / ドキュメント整合性）でレビュー。JSON 構造化出力を併載し、`drive` のループ終了判定を機械化する。`--axes` で自動選別を上書き、`--deep` で観点別 subagent 並列起動（Claude Code のみ） |
| `ship` | lint + commit + PR 作成を一括実行 |
| `skill-metrics` | observability イベントログ（`~/.agents/observability/events.jsonl`）を read-only 集計し、skill 別発火件数 + 注目イベント（fallback / HITL 却下 / loop 上限 / 中断）を提示。小 n ガードで分母が十分なときのみ率を出す。ローカル完結・送信なし（反映は `lessons-triage`）。下記「Observability」を参照 |
| `skill-observability` | **Claude Code 専用。** skill 改善ループの計測層を定義する被参照 companion。イベント契約（`event.schema.json`・単一 SSOT）と fail-open な emit substrate（`obs-emit.mjs`）を同梱。metadata のみ・privacy ファースト（`additionalProperties:false` が payload を拒否・repo id は hash）。下記「Observability」を参照 |
| `usage-guard` | **Claude Code 専用。** Usage Limit（5 時間 / 週次）を OAuth 使用率エンドポイントで監視し 95%（env 上書き可）超過で auto pause/resume。caller（`drive` 等）が checkpoint で Read する pause/resume エンジン形態と、`/usage-guard "<継続コマンド>"` 単体形態を同梱。endpoint → JSONL → fail-open。任意で PreToolUse ceiling hook を併用 |
| `topics` | research-driven な GitHub topics 設定（ozzy-labs scope）。`topics.mjs` エンジンで公式制約（lowercase / hyphen / 50 chars / max 20）の検証、`gh api search/repositories` で人気度測定（session 内キャッシュ）、broad+narrow / 単数複数比較、ozzy-labs 慣行ハードコード（`claude-code` 例外・`*-cli` 除去・`multi-agent` 形固定）を行い、`--apply` で適用（policy の `externally-visible` batch-confirm 明示 opt-out）、`--dry-run` で分析のみ |
| `verify` | ビルド + 型 + テスト + lint の複合検証を `verify.mjs` エンジンで一発実行。検証コマンド発見連鎖（AGENTS.md「検証」節 → package.json scripts → justfile/Makefile/lefthook target → 言語 heuristic）で発見し、最初にヒットした段で確定（段跨ぎ禁止・同段内は全実行）、各コマンドに出典（`source`）を付けて直列実行し JSON サマリを返す。`--dry-run` で発見のみ。旧 `lint-rules` の拡張子別表を内包（ADR-0028 R4、[#179](https://github.com/ozzy-labs/skills/issues/179) を吸収） |

### Observability（skill 改善ループ）

`skill-observability` はデータ駆動の skill 改善ループ（捕捉 → 集計 → 反映）の計測基盤を敷く被参照 companion。3 つのアーティファクトを同梱する:

- **`event.schema.json`** — イベント契約の単一 SSOT。`obs-emit.mjs` と test が**同じファイル**を読むため doc/code の drift が起きない。フィールド名は OpenTelemetry GenAI セマンティック規約の**形**に寄せる（`skill`≈`gen_ai.agent.name` / `operation`≈`gen_ai.operation.name`。experimental なので密結合はしない）。`additionalProperties:false` が機械的 privacy ガード — payload / diff / token / path 等の未知フィールドは検証で弾かれ書き込まれない。
- **`obs-emit.mjs`** — fail-open な append+validate write substrate。1 呼び出しにつき検証済みイベント 1 件を `~/.agents/observability/events.jsonl`（HOME-anchored・追記専用・OTel 非依存）へ記録する。自身は何も捕捉せず throw もしない（検証拒否・失敗は警告して exit 0）ため observability が被計測 skill を壊さない。`--repo` で渡した repo 識別子は hash 化（raw 不保存）。
- **`obs-derive.mjs`** — 痕跡導出 **SessionEnd capture hook**（自己申告バイアスを回避する主経路）。セッション終了後に transcript を読み、どの skill が発火したか（model 呼出の `Skill` tool use=`invoke_agent` / user 入力の `/slash-command`=`slash_command`）を導出し、発火ごとに `start` 1 件 + `heartbeat`（空 window が「発火 0」と「hook 未発火」を区別可能に）を emit する。skill の引数は記録しない。merge/abort の outcome は意図的に導出しない（deferred: セッション終了時の merge 状態は未確定・abort 推定はノイズ）。本リポは settings/hook を配らないため wiring は手動 opt-in（`~/.claude/settings.json` の SessionEnd に `obs-derive.mjs` の絶対パスを登録。snippet は skill の「SessionEnd hook を有効化」節）。

```bash
node obs-emit.mjs --skill=drive  --event=outcome --status=completed
node obs-emit.mjs --skill=review --event=signal  --name=review.loop_iter --value=2
node obs-emit.mjs --skill=drive  --event=heartbeat
```

**`skill-metrics`** skill（shipped・全 adapter）がこのログを read-only 集計し、skill 別発火件数 + 注目イベントを提示する（小 n ガードで低頻度データに誤解を招く `1/1 = 100%` 率を出さない）。

この契約の上に別 PR で構築する（[#162](https://github.com/ozzy-labs/skills/issues/162) で追跡）: outcome 導出（`gh`/`git` の merge ground truth + session→PR linkage）、反映チャネル（privacy 洗浄済みロールアップを `lessons-triage` issue に HITL で反映）。

リポ固有スキル（例: `road` の `improve-loop` / `road-repo-context`）は本パッケージには含まない。

## CLI installer (user scope)

CLI は CRUD 対称の verb（`add` / `update` / `list` / `remove` ＋ `fork` / `diff`、`install`/`uninstall` は alias）。**scope は `--target`** で決まる（無し=user / 指定=project repo）:

```bash
# user scope — 検出した CLI 向けに全 skill を追加（非対話/CI は --adapter 必須）
npx @ozzylabs/skills add

# adapter / skill を明示
npx @ozzylabs/skills add --adapter=codex-cli --skills=drive,review

# catalog × installed 状態
npx @ozzylabs/skills list --json

# 更新（編集は保護）・bundle から消えた skill を削除
npx @ozzylabs/skills update --prune

# アンインストール（確認必須）
npx @ozzylabs/skills remove --skills=topics --yes

# project scope — 対象 repo に相対 ref のまま書込（commit する。Claude cloud 用）
npx @ozzylabs/skills add --target=./my-repo
```

対応 adapter: `claude-code` / `codex-cli` / `gemini-cli` / `copilot`。**対話実行では `--adapter` は `$HOME` 配下の CLI 検出から既定**、非対話（CI）では必須。installed skill は **editable** で、CLI は per-item 来歴マーカー（`.ozzylabs-skills.json`）で管理対象を追跡（共有 `.agents/skills/<name>` base は参照カウント）。`update` は content hash で**ローカル編集を検出し clobber しない**（`--take-theirs` / `--keep-mine` で解決）。

旧 `sync-project` / `migrate` subcommand は撤去済み（project scope は `add --target`）。編集済み skill には `update --merge` で 3-way マージ（base=install 時スナップショット / mine=編集 / theirs=現上流。conflict は `<<<<<<<` マーカーで残す）。

### Hook 配線

2 つの skill は Claude Code hook を extra file として同梱する: usage-guard の PreToolUse ceiling（`usage-guard-hook.mjs`）と skill-observability の SessionEnd capture（`obs-derive.mjs`）。有効化には hook エントリの `command` に **絶対パス**を書く必要があり、そのパスは user-scope install（`~/.claude/skills/…`）と本リポでの dogfood（`<repo>/.claude/skills/…`）で異なる。`hooks add` がこのパスを自動解決する:

```bash
# usage-guard の PreToolUse ceiling を ~/.claude/settings.local.json に配線
npx @ozzylabs/skills hooks add usage-guard

# skill-observability の SessionEnd capture を配線（--scope=user で settings.json）
npx @ozzylabs/skills hooks add observability --scope=user

# 書き込まずに settings の diff を確認（非対話/CI では適用に --yes 必須）
npx @ozzylabs/skills hooks add usage-guard --dry-run

# CLI が書いたエントリのみ削除（他の hook はそのまま）
npx @ozzylabs/skills hooks remove usage-guard
```

install 済み skill dir から script を解決し（無ければ先に `add --skills=usage-guard`）、settings の diff を提示してから確認する（非対話では `--yes` 必須）。既定は `settings.local.json`（`--scope=user` で `settings.json`）を編集し、再 add は冪等 no-op、自分が書いたエントリのみ操作し、壊れた JSON settings は上書きしない。リポは依然 settings/hooks を配信せず、要求時にローカル settings を書くだけ。

## Consumer セットアップ

skills を **user skills** として 1 コマンドで install する:

```bash
npx @ozzylabs/skills add
```

このコマンドは canonical skills を user-scope の skill ディレクトリ（Claude Code なら `~/.claude/skills/{name}/SKILL.md`）に配置する。マシン上の全プロジェクトが per-repo 設定なしで skills を利用できる。

### Adapter opt-in

対話実行では `--adapter` は `$HOME` 配下で検出した CLI が既定。明示する場合はカンマ区切り（非対話/CI では必須）:

```bash
npx @ozzylabs/skills add --adapter=claude-code,codex-cli
```

| Adapter id | User-scope install target |
| --- | --- |
| `claude-code` | `~/.claude/skills/{name}/SKILL.md` |
| `codex-cli` | `~/.agents/skills/{name}/SKILL.md` + `AGENTS.md.snippet` のマージ |
| `gemini-cli` | `~/.gemini/settings.json` のマージ + `AGENTS.md.snippet` のマージ |
| `copilot` | `~/.github/copilot-instructions.md` への snippet マージ |

オプション・install target の詳細は `npx @ozzylabs/skills add --help` を参照。

### CI で利用する場合

GitHub Actions 上では `ozzy-labs/skills` composite action を使う。action は内部で `npx @ozzylabs/skills add` を呼び出し、ランナーの `$HOME/.claude/skills/`（および `$HOME/.agents/skills/`）にスキルを取り込む:

```yaml
- uses: ozzy-labs/skills@v1
  with:
    skills: drive,review   # 既定: '' (バンドルされた全スキルを取り込む)
    adapter: claude-code   # 既定: claude-code
    # version: latest      # 既定: npm の latest。再現性が必要なら version を pin する
```

action は user scope (`$HOME/.claude/skills/`) のみにインストールする。`target` input は意図的に持たず、consumer がリポジトリ直下の `.claude/skills/` に誤って書き込めない設計とした。実際に動く end-to-end サンプルは [`examples/ci-with-skills.yaml`](../examples/ci-with-skills.yaml) を参照。

複数 job 共通の install step を独自に書きたい場合は、CLI を `run:` step から直接呼んでもよい:

```yaml
- name: Install OzzyLabs skills
  run: npx --yes @ozzylabs/skills add --adapter claude-code
```

### 旧 push 型フローからの移行

以前は push 型 sync flow 経由で skills を **project skills** として配信していた（`dist/{adapter-id}/` を consumer リポの `.claude/skills/` 等にコピー）。本方針変更により全 consumer が user skills only に移行済み。[issue #100](https://github.com/ozzy-labs/skills/issues/100) で 14 consumer 全件に `chore/migrate-to-user-skills` PR を配信して完了。新規 consumer は次の手順を実施:

1. `.claude/skills/` / `.agents/skills/` 等、in-repo skill ミラーを削除する（`migrate` subcommand は撤去済み。手動で削除）。
2. `.commons/sync.yaml` から `skills_commit` / `skills_adapters` を取り除く。
3. 各 contributor が自分のマシンで `npx @ozzylabs/skills add` を 1 度実行する。

## Adapter 出力

`pnpm build` は `scripts/adapters/` 配下の各 adapter を実行し、`dist/{adapter-id}/` に書き出す:

| Adapter | 出力 | ソース |
| --- | --- | --- |
| `claude-code` | `dist/claude-code/.claude/skills/{name}/SKILL.md` | `SKILL.claude-code.md`（あれば）/ なければ canonical `SKILL.md` |
| `codex-cli` | `dist/codex-cli/.agents/skills/{name}/SKILL.md` + `AGENTS.md.snippet` | canonical `SKILL.md` |
| `gemini-cli` | `dist/gemini-cli/.gemini/settings.json` + `AGENTS.md.snippet` | canonical `SKILL.md` |
| `copilot` | `dist/copilot/.github/copilot-instructions.md.snippet` | canonical `SKILL.md` |

### Claude Code コンパニオンファイル

skill は canonical `SKILL.md` に加えて、任意で `.agents/skills/{name}/SKILL.claude-code.md` を持てる。Claude Code adapter は companion が存在すればそのまま出力し、各 skill が Claude Code 固有の wrapper（次アクション `AskUserQuestion` / `argument-hint` / `disable-model-invocation` / `allowed-tools` 等）を canonical `SKILL.md` を汚さずに同梱できる。

Companion frontmatter contract:

| フィールド | 必須 | 備考 |
| --- | --- | --- |
| `description` | ◯ | canonical の `description` を Claude Code 向けに短縮してもよい |
| `disable-model-invocation` | 任意 | boolean — 自動呼び出しを抑止 |
| `allowed-tools` | 任意 | カンマ区切りツール一覧 |
| `argument-hint` | 任意 | `/skill-name <hint>` 形式のヒント |
| `user-invocable` | 任意 | `false` で reference-only skill 扱い |

`name` はディレクトリ名から導出するため、companion frontmatter に含めない。

## ローカル開発

```bash
pnpm install
pnpm build         # dist/ を再生成
pnpm test          # adapter ユニット + 統合テスト
pnpm lint:all
```

`dist/` は commit 対象で、CI が `pnpm build` の出力と一致することを検証する。`.agents/skills/*/SKILL.md` または `.agents/skills/*/SKILL.claude-code.md` を編集したら `pnpm build` を実行し、生成された `dist/` の差分も同じコミットに含める。

## リリース運用 (maintainer 向け)

`@ozzylabs/skills` は [release-please](https://github.com/googleapis/release-please) + OIDC [Trusted Publishers](https://docs.npmjs.com/trusted-publishers) で npm に publish する。パイプラインの実体は `.github/workflows/release.yaml`:

1. **`main` への commit**: Conventional Commits (`feat:` / `fix:` / `feat!:` 等) で version bump を駆動する。
2. **Release PR**: `release-please` が `package.json` / `.release-please-manifest.json` の `version` と `CHANGELOG.md` を更新する PR を自動で開く / 更新する。maintainer がレビューして squash-merge する。
3. **Tag + GitHub Release**: release PR の merge で `v<x.y.z>` tag と GitHub Release が作られる。
4. **`npm publish --provenance`**: `publish` job が `pnpm install --frozen-lockfile` → `pnpm build` → `npm publish --provenance --access public` を実行する。認証は OIDC のみ (`NPM_TOKEN` secret は使わない)。`permissions: { id-token: write, contents: read }` で GitHub Actions の OIDC token を npm 側の trusted publisher 設定 (<https://www.npmjs.com/package/@ozzylabs/skills/access>) と突き合わせて検証する。

### npm payload の中身

payload は `package.json#files` で宣言し、`tests/npm-pack-payload.test.mjs` で検証する:

- `dist/{adapter-id}/` — consumer が読む正準ペイロード (`claude-code`, `codex-cli`, `gemini-cli`, `copilot`)
- `dist/sync/replace-snippet.sh` — snippet 同期ヘルパー
- `bin/install.mjs` — CLI installer entry point ([issue #98](https://github.com/ozzy-labs/skills/issues/98) で本体実装)
- `schemas/` — sync-target 用 schema
- `README.md`, `LICENSE`, `action.yaml`

skills repo 自身の dogfood mirror (`.agents/skills/`, `.claude/skills/`) と source layout (`src/`, `scripts/`, `tests/`) は意図的に除外する。

### Trusted Publishers 設定

OIDC trust 関係は npm registry 側で 1 度だけ設定する:

- Package: `@ozzylabs/skills`
- Workflow: `.github/workflows/release.yaml`
- Repository: `ozzy-labs/skills`
- Environment: (なし)

詳細は npm 公式の [Trusted Publishers ドキュメント](https://docs.npmjs.com/trusted-publishers) を参照。

## 規約

- Commit: [Conventional Commits](https://www.conventionalcommits.org/)（`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`）
- ブランチ: `<type>/<short-description>`（例: `feat/add-debug-skill`）
- PR: squash merge のみ、タイトルは Conventional Commits 形式

## License

[MIT](./LICENSE)
