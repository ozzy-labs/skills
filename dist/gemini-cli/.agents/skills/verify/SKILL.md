---
name: verify
description: ビルド・型・テスト・lint の複合検証を一発で実行する統合スキル。`verify.mjs` エンジンが検証コマンドを発見連鎖（AGENTS.md「検証」節 → package.json scripts → justfile/Makefile/lefthook → 言語 heuristic）で自動発見し、出典付きで直列実行して結果サマリを返す。上位段でヒットすればその段のみ実行（段跨ぎ禁止）。
---

# verify - 統合検証（発見連鎖 + 実行）

「ビルド + 型 + テスト + lint が通るか」の複合検証を一発で行う。agent 視点ではこれらは常に一体で必要なため、旧 `lint` / `test` / `lint-rules` を `verify` に統合した（[ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R4）。

決定論（検証コマンドの発見連鎖・出典判定・直列実行・結果サマリのレンダリング）は同梱の **`verify.mjs` エンジン**が担う（ADR-0028 R1、先行例 `health-check.mjs` / `usage-check.mjs` / `skill-metrics.mjs`）。本 SKILL.md は判断層 — **いつエンジンを呼ぶか・結果をどう報告するか・どこで人に確認するか** — に絞る。

## 原則

- **単一の複合検証:** verify は常に同じ意図（build + 型 + test + lint が通るか）。個別コマンドの選定はエンジンの発見連鎖に委ねる。
- **発見連鎖・段跨ぎ禁止:** 上位段でコマンドが見つかればその段のみ実行し、下位段には降りない。同段内で見つかったコマンドはすべて実行する。
- **出典の明示:** 各コマンドがどの段（出典）で見つかったかを必ず報告に含める。
- **consumer repo で機能する:** AGENTS.md 前提だけに頼らず、package.json / task runner / 言語 heuristic までフォールバックする（[#179](https://github.com/ozzy-labs/skills/issues/179) を吸収）。

## 検証コマンド発見連鎖

エンジンは以下の 4 段を上から順に評価し、**最初にコマンドを産出した段で確定**する（段跨ぎ禁止・同段内は全実行）:

| 段 | 出典 (`source`) | 発見対象 |
|---|---|---|
| 1 | `agents-md` | `AGENTS.md`「検証」節の fenced code block / インライン `コマンド` |
| 2 | `package-json` | `package.json` の scripts のうち `build` / `typecheck` / `test` / `lint`（存在するもの・lockfile から pm を判定して `<pm> run <script>`） |
| 3 | `task-runner` | `justfile` > `Makefile` > `lefthook.yaml`（最初に存在するもの）の該当 target（`build` / `typecheck` / `test` / `lint`、lefthook は `pre-commit` / `pre-push`） |
| 4 | `language-heuristic` | `go.mod`→`go build ./...` + `go test ./...` / `pyproject.toml`+`uv.lock`→`uv run pytest` / `Cargo.toml`→`cargo build` + `cargo test` |

どの段でも見つからなければ「未発見」として報告する（実行しない）。

## 手順

1. **本 SKILL.md と同じディレクトリ**の `verify.mjs` を Bash で実行する。Claude Code では `~/.claude/skills/verify/verify.mjs`（dogfood は `<repo>/.claude/skills/verify/verify.mjs`）:

   ```bash
   node <この skill のディレクトリ>/verify.mjs [--dry-run] [--json] [--repo-root=<dir>]
   ```

2. エンジンは既定で **発見したコマンド（出典付き）を直列実行**し、整形済みの結果サマリを stdout に出力する。**その出力をそのまま提示**する（再整形・再解釈しない — レンダリングはエンジンの責務）。
3. `--dry-run` は発見のみ（実行しない）。「どのコマンドが・どの出典で選ばれるか」を確認したいときに使う。
4. 失敗したコマンドがある場合は、その旨（コマンド・出典・エラー要約）をそのまま提示する。自動修正は行わない（lint の自動修正が必要なら発見された lint コマンド側の責務）。

## 入力

- 引数なし → 発見連鎖で確定した段のコマンドを直列実行し、結果サマリを提示する
- `--dry-run`（別名 `--discover`）→ 発見のみ。実行しない
- `--json` → 人間可読レポートの代わりに構造化 JSON を出力（プログラム連携・デバッグ用。`drive` / `implement` から機械判定に使える）
- `--repo-root=<dir>` → cwd 以外のディレクトリを検証する

## 出力（JSON schema v1 の要点）

- `discovery.stage` — 確定した段（`agents-md` / `package-json` / `task-runner` / `language-heuristic` / `null`）
- `discovery.commands[]` — `{ command, source, kind }`（`source` が出典、`kind` は `build` / `typecheck` / `test` / `lint` / `other`）
- `results[]` — 実行時のみ。`{ command, source, kind, status, ok, error }`
- `ok` — 全コマンド pass なら `true`、失敗ありなら `false`、未実行（`--dry-run` / 未発見）なら `null`

## 拡張子別 lint 規則（旧 lint-rules の内包）

発見連鎖は project レベルのコマンドを見つける。個別ファイルの lint / format 規則はエンジンの `LINT_RULES` として内包する（旧 `lint-rules` skill を吸収）:

| 拡張子 | コマンド |
|--------|---------|
| `.ts` / `.tsx` / `.js` / `.jsx` / `.json` | `biome check --write <file>` |
| `.md` | `markdownlint-cli2 --fix <file>` |
| `.yaml` / `.yml` | `yamlfmt <file> && yamllint -c .yamllint.yaml <file>` |
| `.toml` | `taplo format <file>` |
| `.sh` | `shfmt -w <file> && shellcheck <file>` |

## 注意事項

- `.env` ファイルは読み取らない。
- 発見連鎖は決定論。段の順序・選定規則の変更はエンジン + 本 SKILL.md の同時改訂で行う。
- verify はコマンドの selection と実行のみ。破壊的操作（commit / push / merge）は行わない。
- consumer repo で AGENTS.md「検証」節がない場合も、package.json / task runner / 言語 heuristic までフォールバックするため機能する。
