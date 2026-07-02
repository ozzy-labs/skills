---
name: topics
description: GitHub topics 候補を `topics.mjs` エンジンで制約検証・人気度測定・broad+narrow / 単数複数比較・ozzy-labs 慣行ハードコードして選定し、policy の `externally-visible` gate（既定 batch-confirm）に従って `gh repo edit --add-topic` で適用する。スコープは ozzy-labs 内利用のみ。
---

# topics - research-driven GitHub topics setup（ozzy-labs scope）

GitHub topics の選定は、毎リポで「候補列挙 → 公式制約 validation → 人気度確認 → broad+narrow / 単数複数比較 → ozzy-labs 慣行と整合 → `gh repo edit --add-topic` 適用」の手作業を繰り返している。本スキルは選定段階の判断と適用段階の作業を一本化する。

決定論（公式制約 validation・人気度取得・broad+narrow 5x 判定・単数複数比較・ozzy-labs 慣行の変換 / 除外 / ハードコード保持・最終選定・レンダリング）は同梱の **`topics.mjs` エンジン**が担う（[ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R1、先行例 `usage-check.mjs` / `skill-metrics.mjs` / `policy-read.mjs` / `health-check.mjs`）。本 SKILL.md は判断層 — **いつエンジンを呼ぶか・結果をどう提示するか・どこで人に確認するか（policy gate）** — に絞る。

**スコープ**: ozzy-labs 配下リポジトリの利用に限定する。クロス-org 汎用化・永続キャッシュ・他 org 用慣行は対象外（[スコープ外](#スコープ外)参照）。

## 入力

```text
topics <candidate-list>
  --repo owner/repo  (省略時は cwd の origin から解決)
  --apply            (policy の batch-confirm を明示 opt-out し、確認なしで適用)
  --dry-run          (適用せず分析だけ)
```

- `<candidate-list>` は `,` 区切り、または複数引数
- `--apply` と `--dry-run` を同時指定した場合は `--dry-run` を優先する（誤適用防止。エンジンが強制する）
- `--repo` 未指定時はエンジンが `git remote get-url origin` から `owner/repo` を抽出する。GitHub remote が見つからない場合は結果 JSON の `repo_error` に載る

## 手順

1. **本 SKILL.md と同じディレクトリ**の `topics.mjs` を Bash で実行する（引数はそのまま渡す）。Claude Code では `~/.claude/skills/topics/topics.mjs`（dogfood は `<repo>/.claude/skills/topics/topics.mjs`、Codex/Gemini は `.agents/skills/topics/topics.mjs`）:

   ```bash
   node <この skill のディレクトリ>/topics.mjs <candidate-list> [--repo owner/repo] [--dry-run]
   ```

   エンジンは既定で **整形済みテキスト**（候補数 / 制約 filter 結果 / 人気度表 / broad+narrow・単数複数の判定 / 慣行変換 / 最終 topics / apply プラン）を stdout に出力する。`--json` で構造化 JSON を得られる。

2. エンジンの出力を **そのまま提示**する（再整形・再解釈しない — 制約 validation・5x 判定・単数複数・ozzy-labs 慣行はすべてエンジンの責務）。人気度不明（API 失敗）の候補は表に `人気度不明` として明示され、5x / 単数複数比較の対象外になっている。
3. `repo_error` が立っている（GitHub remote 不在）場合は、その旨を提示し `--repo owner/repo` の明示を促す。
4. 適用（`gh repo edit --add-topic`）は下記 **policy の `externally-visible` gate** に従う。

## 適用（policy の `externally-visible` gate に従う）

`gh repo edit --add-topic` の適用は **外部可視アクション**。個別の承認ゲートを prose にハードコードせず、中央 autonomy policy（`policy` skill が定義する 3 クラス・gate 語彙の SSOT）に従う。分類とゼロコンフィグ既定:

| 本 skill のアクション | クラス | policy 参照 | ゼロコンフィグ既定 gate |
| --- | --- | --- | --- |
| topics 適用（`gh repo edit --add-topic`） | `externally-visible` | `--action=topics-apply` | `batch-confirm`（最終リストを 1 回提示して一括確認） |

有効 gate は sibling の `policy` skill の `policy-read.mjs` で引く（user-scope では `~/.claude/skills/policy/policy-read.mjs`、dogfood は `<repo>/.claude/skills/policy/policy-read.mjs`、Codex/Gemini は `.agents/skills/policy/policy-read.mjs`）:

```bash
node <policy skill のディレクトリ>/policy-read.mjs --action=topics-apply --repo-root="$PWD"
# => .resolved.gate（既定 batch-confirm）
```

flag は policy と整合させる:

- `--dry-run` 指定時: エンジンは分析のみ出力し、適用も確認もしない（`gh repo edit` を呼ばない）
- `--apply` 指定時: **`batch-confirm` の明示 opt-out**。エンジンが確認なしで `gh repo edit <owner/repo> --add-topic <topic1>,<topic2>,...` を実行し、`gh repo view --json repositoryTopics` で検証まで行う
- どちらも未指定時（`plan` モード）: エンジンは適用せず `apply_command`（実行予定コマンド）を返す。gate に従って人に確認する:
  - gate=`batch-confirm`（既定）: 最終 topics リストを 1 回まとめて提示して一括確認する（ホストの確認 UI。テキスト出力で `Apply? [Y/n]` を列挙しない。Claude Code では AskUserQuestion — `SKILL.claude-code.md` 参照）。承認されたら **同じ引数に `--apply` を付けて再実行**する
  - gate=`proceed`: 確認なしで `--apply` 付き再実行
  - gate=`ask`: 1 topic ずつ確認する

**policy 不在でも壊れない:** `policy-read.mjs` は fail-safe 設計で、読めない・不正な値は厳しい側（`ask`）へ倒す。`policy` skill 未配置の環境では上表のゼロコンフィグ既定 gate（`externally-visible`=`batch-confirm`）を直接適用する。

適用後、エンジンは実適用値（`apply.verified_topics`）を返す。期待値（`final_topics`）と実適用値の差分を最終レポートに含める。

## エラーハンドリング（エンジンが JSON に載せる）

| 状況 | エンジンの動作 |
| --- | --- |
| `gh` CLI が未認証 | `gh_available:false`。各候補の popularity は `null` + `popularity_errors` に理由。5x / 単数複数比較は対象外（0 扱いにしない）。SKILL 判断層は「人気度不明のため信頼できる比較不可」を提示する |
| GitHub Search API rate limit / network error | 該当候補のみ `popularity=null` + 理由。他候補は継続 |
| `--repo` 未指定で GitHub remote 不在 | `repo_error` を立てる。適用は行わない |
| 制約違反候補 100% | `error: no applicable candidates`。popularity API は呼ばない |
| `gh repo edit --add-topic` 失敗（`--apply` 時） | `apply.applied:false` + `apply.error`。SKILL 判断層が失敗を提示する |

## スコープ外

| 項目 | 除外理由 |
| --- | --- |
| 1. クロス-org 汎用化 | 現時点では ozzy-labs 専用。汎用化は別 issue で検討 |
| 2. 永続キャッシュ | session 内のみ（エンジンは 1 実行内で各 topic を 1 回だけ問い合わせる）。複数 session に跨る最適化は対象外 |
| 3. topics 適用部分の他リポ責務 | `commons/init-templates.sh` の `--topics` は「指定リストの適用」のみを担う。本スキルは選定支援、commons は適用、と責務を分離する。両者は人間オペレータ経由で連携する |

## 注意事項

- `.env` ファイルは読み取り・ステージングしない
- ハードコードされた ozzy-labs 慣行（`claude-code` 例外・`*-cli` 除去・`multi-agent` 形固定・`claude`+`claude-code` 併記保持）はエンジン内に実装され、機械判定（broad+narrow 5x / 単数複数）より優先する。例外を増やす場合は `topics.mjs` + 本 SKILL.md の同時改訂で行う（Claude の自由判断で慣行拡張しない）
- topics 適用は policy の `externally-visible` gate（既定 `batch-confirm`）に従う。個別の承認ゲートを prose にハードコードしない
- `--apply` は `batch-confirm` の明示 opt-out として確認をスキップするため、必ず `--dry-run` で内容を確認した後に使う運用を推奨する
