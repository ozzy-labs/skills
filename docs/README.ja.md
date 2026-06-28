[English](../README.md) | 日本語

# @ozzylabs/skills

Claude Code / GitHub Copilot / Gemini CLI / Codex CLI 向けの OzzyLabs 正準エージェントスキルバンドル。

`.agents/skills/{name}/SKILL.md` を SSOT とし、`pnpm build` で `dist/{adapter-id}/` 配下に各 agent 向けの出力を生成する。エンドユーザーは npm package に同梱された CLI installer 経由で **user skills**（例: `~/.claude/skills/`）として install する。

[OzzyLabs handbook ADR-0016](https://github.com/ozzy-labs/handbook/blob/main/adr/0016-create-skills-repo.md) で決定された、skills を `commons` から切り出して専用リポでバージョニングする方針の実装。配布形態は **既定で user skills**（handbook ADR-0027 にて整理予定）であり、consumer は `npx @ozzylabs/skills install` で導入する。各 consumer リポ配下への project skills (`.claude/skills/`) 自動配信は廃止した。例外は **Claude mobile / web (cloud) セッション** で、これは "repo only" 動作のため `~/.claude/skills/` を参照できない。その用途で開発するリポには `npx @ozzylabs/skills sync-project --target <repo>` で相対 ref を保った project-scope payload (`dist/claude-code-project/`) を opt-in 配信する（[Project-scope sync](#project-scope-sync-claude-mobile--web-cloud) 参照）。それ以外で project skills が残るのは `skills` / `commons` リポ自身の dogfood 用途のみ（build pipeline が SSOT から生成）。

## v0.x 同梱スキル

合計 14 件: OzzyLabs 全リポジトリ共通の 11 件と、内部運用専用 3 件 (`health` / `topics` / `phase-issue`) をバンドル。`npx @ozzylabs/skills migrate` で旧 project-scope レイアウトから削除されるのは従来の汎用 10 件のみ（`lessons-triage` は project-scope 配信の対象外）。

| スキル | 用途 |
| --- | --- |
| `commit` | 変更をステージし Conventional Commits でコミット |
| `commit-conventions` | コミット / ブランチ / PR の命名規則 |
| `drive` | Issue → merge-ready な PR まで自律駆動するループ |
| `health` | リポジトリ状態と skill catalog 整合性を 16 領域に渡って確認し、推奨アクションを inline 表示（`--deep` で `要確認` 項目を追加調査） |
| `implement` | Issue または指示をもとに、ブランチ作成・実装 |
| `lint` | 全リンターを自動修正付きで実行 |
| `lessons-triage` | セッション教訓 queue（`~/.agents/lessons/queue.jsonl`、dotfiles の `lesson-capture.sh` hook が蓄積）を消化し、transcript から User Skills 改善の教訓を抽出して承認分のみ ozzy-labs/skills へ issue 起票。HITL — 1 件ずつ承認制、リポ編集・auto-apply なし |
| `lint-rules` | リンター設定リファレンス |
| `pr` | 変更を push し PR を作成・更新 |
| `review` | コード変更や PR を 11 観点（正確性 / セキュリティ / 規約 / アーキテクチャ / 互換性 / 保守性 / テスト / パフォーマンス / 可観測性 / ユーザビリティ / ドキュメント整合性）でレビュー。JSON 構造化出力を併載し、`drive` のループ終了判定を機械化する。`--axes` で自動選別を上書き、`--deep` で観点別 subagent 並列起動（Claude Code のみ） |
| `ship` | lint + commit + PR 作成を一括実行 |
| `test` | ビルド・テスト・型チェックを実行 |
| `topics` | research-driven な GitHub topics 設定（ozzy-labs scope）。公式制約（lowercase / hyphen / 50 chars / max 20）の検証、`gh api search/repositories` で人気度測定（session 内キャッシュ）、broad+narrow / 単数複数比較、ozzy-labs 慣行ハードコード（`claude-code` 例外・`*-cli` 除去・`multi-agent` 形固定）を行い、`--apply` で適用、`--dry-run` で分析のみ |

リポ固有スキル（例: `road` の `improve-loop` / `road-repo-context`）は本パッケージには含まない。

## CLI installer (user scope)

`@ozzylabs/skills` パッケージは canonical な skill バンドルを user-scope の skills ディレクトリへインストールする CLI を同梱する。出力先は常に `$HOME` 配下（project-scope 配信は意図的に未サポート）:

```bash
# 全 skill を ~/.claude/skills/ に install (Claude Code、default adapter)
npx @ozzylabs/skills install

# 一部の skill を ~/.agents/skills/ に install (Codex CLI)
npx @ozzylabs/skills install --adapter=codex-cli --skills=drive,review

# dry-run: JSON で計画のみ出力し、実コピーなし
npx @ozzylabs/skills install --skills=drive --dry-run

# 既存 install を上書き
npx @ozzylabs/skills install --upgrade

# 対話 prompt を skip (CI 等)
npx @ozzylabs/skills install --force
```

対応 adapter: `claude-code`（default）、`codex-cli`、`gemini-cli`、`copilot`。出力 path は build pipeline が `dist/{adapter-id}/` 配下に書く構造をそのまま `$HOME` に転写する。`install` subcommand は project-scope target を持たず、書き込み先は `~/.claude/skills/` のみ。**project scope** へ配信したい場合（Claude mobile / web の cloud ケース）は、次の `sync-project` subcommand を使う。

### Project-scope sync (Claude mobile / web cloud)

Claude mobile / web (cloud) セッションは "repo only" 動作で、skill を consumer リポの `.claude/skills/` からのみ discover し、`~/.claude/skills/` は参照しない。よって user scope の `install` は届かない。per-adapter の `dist/{adapter-id}/` payload もそのままでは commit できない — skill ref が `~/.agents/skills/…` に書き換えられており、cloud VM の空の `$HOME` を指してしまう。

`sync-project` は opt-in の project-scope 経路。ref が **repo-root 相対**のまま保たれ、Claude Code wrapper が `Read` する canonical `.agents/skills/<name>/SKILL.md` を `.claude/skills/` wrapper（および `.claude/agents/`）と併せて同梱した `dist/claude-code-project/` を、対象リポへコピーする:

```bash
# 全 skill を ./my-repo へ sync (.claude/skills/, .agents/skills/, .claude/agents/ を書き込む)
npx @ozzylabs/skills sync-project --target=./my-repo

# /drive ワークフロー一式のみ (drive は他に依存するのでまとめて入れる)
npx @ozzylabs/skills sync-project --target=./my-repo \
  --skills=drive,implement,ship,review,commit,pr,lint,test,commit-conventions,lint-rules

# 書き込まず JSON で plan のみ確認
npx @ozzylabs/skills sync-project --target=./my-repo --dry-run
```

`--target` は必須（暗黙の default なし）。本 subcommand はファイルを書き込むだけ — 差分を確認し、対象リポで commit して cloud セッションに認識させる。実際に Claude mobile / web app で開発するリポにのみ使い、それ以外は user-scope `install` を既定とする。

### 旧 project-scope レイアウトからの移行

旧 Renovate / push-mode sync flow で配信した汎用 skill コピーを project から取り除くには migrate subcommand を使う:

```bash
# 削除計画の確認
npx @ozzylabs/skills migrate --dry-run

# 実適用 (汎用 10 skill を .claude/skills/ と .agents/skills/ から削除し、
# .commons/sync.yaml の skills_adapters / skills_commit も削除する。
# --keep-sync-yaml で YAML 更新を skip 可能)
npx @ozzylabs/skills migrate --force
```

リポ固有の skill（汎用 10 件以外）はそのまま残す。

## Consumer セットアップ

skills を **user skills** として 1 コマンドで install する:

```bash
npx @ozzylabs/skills install
```

このコマンドは canonical skills を user-scope の skill ディレクトリ（Claude Code なら `~/.claude/skills/{name}/SKILL.md`）に配置する。マシン上の全プロジェクトが per-repo 設定なしで skills を利用できる。

### Adapter opt-in

既定では Claude Code 向け adapter 出力のみ書き出される。他の agent 向け出力を追加で取り込む場合は `--adapter` を繰り返し指定する:

```bash
npx @ozzylabs/skills install --adapter claude-code --adapter codex-cli
```

| Adapter id | User-scope install target |
| --- | --- |
| `claude-code` | `~/.claude/skills/{name}/SKILL.md` |
| `codex-cli` | `~/.agents/skills/{name}/SKILL.md` + `AGENTS.md.snippet` のマージ |
| `gemini-cli` | `~/.gemini/settings.json` のマージ + `AGENTS.md.snippet` のマージ |
| `copilot` | `~/.github/copilot-instructions.md` への snippet マージ |

オプション・install target の詳細は `npx @ozzylabs/skills install --help` を参照。

### CI で利用する場合

GitHub Actions 上では `ozzy-labs/skills` composite action を使う。action は内部で `npx @ozzylabs/skills install` を呼び出し、ランナーの `$HOME/.claude/skills/`（および `$HOME/.agents/skills/`）にスキルを取り込む:

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
  run: npx --yes @ozzylabs/skills install --adapter claude-code
```

### 旧 push 型フローからの移行

以前は push 型 sync flow 経由で skills を **project skills** として配信していた（`dist/{adapter-id}/` を consumer リポの `.claude/skills/` 等にコピー）。本方針変更により全 consumer が user skills only に移行済み。[issue #100](https://github.com/ozzy-labs/skills/issues/100) で 14 consumer 全件に `chore/migrate-to-user-skills` PR を配信して完了。新規 consumer は次の手順を実施:

1. `.claude/skills/` / `.agents/skills/` 等、in-repo skill ミラーを削除する（`npx @ozzylabs/skills migrate` で自動化可能）。
2. `.commons/sync.yaml` から `skills_commit` / `skills_adapters` を取り除く。
3. 各 contributor が自分のマシンで `npx @ozzylabs/skills install` を 1 度実行する。

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
