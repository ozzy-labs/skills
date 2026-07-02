---
name: review
description: コード変更や PR を 11 観点（perspectives）でレビューし、JSON 構造化出力 + 人間可読レポートで報告する。quick / deep モードを切替可能。PR 番号またはワーキングツリー差分を入力に取る。
---

# review - 多観点コードレビュー

差分を 11 観点（perspectives）でレビューし、Critical / Warning / Info に分類して JSON + 人間可読レポートで報告する。[ADR-0025](https://github.com/ozzy-labs/handbook/blob/main/adr/0025-skills-review-multi-perspective.md) の hybrid 方式（quick: 単一エージェント / deep: 観点並列サブエージェント）を採用する。

決定論（観点選別・重複統合・観点間衝突の分離・グルーピング・人間可読レポート + `<!-- review-json:v1 -->` 埋め込み）は同梱の **`review.mjs` エンジン**が担う（[ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R1、先行例 `health-check.mjs` / `usage-check.mjs` / `skill-metrics.mjs`）。本 SKILL.md は判断層 — **変更ファイルから観点を決め（`review.mjs select`）、各観点で findings を作り（LLM の判断）、`review.mjs render` で JSON + レポートに整形して投稿する** — に絞る。観点定義（`perspectives/<axis>.md`）と review-json Schema v1 は不変。

## 原則

- **findings の生成のみ LLM の判断:** 「どの観点にどんな指摘があるか」はコードを読む LLM が決める。エンジンは選別（どの観点を回すか）と集約・整形（findings をどうまとめて出すか）の決定論だけを担う。
- **内部表現は必ず JSON:** findings はすべて JSON で保持し、PR コメント・標準出力はエンジンのレンダラを通して人間可読フォーマットに変換する。
- **severity はエンジンが上書きしない:** severity 判定は対応する `perspectives/<axis>.md` の severity ガイドに従う。観点を超えて勝手に重要度を上げ下げしない。

## 入力

- **PR 番号が指定された場合**（`#N` または数字のみ）:
  - `gh pr diff <N>` で差分を取得、`gh pr diff <N> --name-only` で変更ファイル一覧を取得
  - `gh pr view <N>` で PR の説明を取得
- **引数なしの場合:**
  - `git diff` でワーキングツリーの変更を取得（`git diff --name-only` で変更ファイル一覧）
  - 変更がなければ `git diff main...HEAD`（変更ファイルは `git diff --name-only main...HEAD`）でブランチ差分を取得
  - それでも変更がなければ、レビュー対象がない旨を伝えて終了する

## オプション

- `--axes=<axis,...>`: 適用観点を明示指定（自動選別を上書き、`default_enabled: false` 観点も明示時のみ有効化）
- `--deep`: deep モードで実行（観点ごとにサブエージェント並列起動。Claude Code 環境のみ。他アダプタでは quick にフォールバック）

## 観点（11 軸）

観点定義は `perspectives/<axis>.md` を SSOT とする。frontmatter で `category` / `applies_when` / `skip_when` / `default_enabled` / 検査項目 / severity ガイド / `exit_criteria.drive_loop` を宣言する。

| category | axis | 既定 |
| --- | --- | --- |
| required | correctness, security, conventions | 常に適用 |
| design | architecture, compatibility, maintainability | applies_when マッチ時 |
| quality | testing, performance, observability | applies_when マッチ時 |
| ux | usability, documentation | applies_when マッチ時 |

観点選別ロジック（`category: required` は常に適用 / `default_enabled: false` は `--axes` 明示時のみ / `skip_when.diff_only_in` が最優先スキップ条件 / `applies_when` の OR マッチで適用）は `review.mjs` に実装されており、frontmatter を入力に決定論的に適用観点を返す。`skip_when` でサポートするキーは `diff_only_in` のみ（未定義キーは無視、forward-compat）。

## 手順

### 1. 適用観点の決定

変更ファイル一覧を `review.mjs select` に渡し、適用観点を決めさせる。エンジンは **本 SKILL.md と同じディレクトリ**にある（Claude Code では `~/.claude/skills/review/review.mjs`、dogfood は `<repo>/.claude/skills/review/review.mjs`）:

```bash
# 変更ファイル一覧（1 行 1 パス）を stdin で渡す
git diff --name-only | node <この skill のディレクトリ>/review.mjs select [--axes=<a,b>]
```

エンジンは `適用観点 (n/11):` ブロックを stdout に整形出力する。**その出力をそのまま提示**する（再整形しない）。機械可読な観点リストが必要なら `--json`（`{ axesApplied, byCategory, unknownAxes, total }`）を使う。`--axes` を渡すと選別を上書きし、その観点のみ（`default_enabled: false` 含む）を適用する。

### 2. findings の生成（LLM の判断）

適用観点それぞれについて、該当 `perspectives/<axis>.md` の検査項目・severity ガイドに従って差分をレビューし、findings を作る。**この工程だけが LLM の判断**であり、script 化しない。

各 finding は次の形で内部 JSON に積む: `{ axis, severity ("critical"|"warning"|"info"), file, line, issue, why, suggestion }`。原理的トレードオフ（例: security ↔ DX、observability ↔ performance）は finding にせず `conflicts` 配列（`{ axes, file, line, description }`）に積む（severity を付けず判断委ね）。

#### quick モード（デフォルト）

単一エージェントが適用観点を順に走査し、観点ごとに findings を内部 JSON バッファに追加する。

#### deep モード（`--deep`）

観点ごとに独立した worker（並列実行単位）を起動し、各 worker が対応する `perspectives/<axis>.md` を読み込んで JSON で findings を返す。並列実行できないホストでは観点ごとに直列で独立評価しても結果は同等。worker への入力形式:

```text
axis: <axis-name>
mode: deep
context:
  base: <base-ref>
  head: <head-ref>
  pr_number: <N (optional)>

<diff>
```

worker は観点 MD の読み込みと JSON 出力のみで完結させる（他スキルの呼び出しはしない）。deep モードの並列起動機構はホスト依存（Claude Code: `SKILL.claude-code.md` の「deep モードでの並列起動」）。並列実行機構を持たないアダプタでは quick にフォールバックする。集約は下記のとおり **worker の return 後にエンジンで**行う（workflow 内に集約 agent を追加しない）。

### 3. 集約 + レポート出力

生成した findings（と conflicts）を `{ mode, axes_applied, findings, conflicts }` の JSON にまとめ、`review.mjs render` に渡す。エンジンが重複統合（同一 `file:line:issue` を 1 件に統合し `axes_merged` を併記）・summary 計算（by_axis / total）・観点→severity→ファイルのグルーピング・人間可読レポート生成・`<!-- review-json:v1 -->` 埋め込みを行う:

```bash
# findings JSON を stdin で渡す（--input=<file> でも可）
printf '%s' "$FINDINGS_JSON" | node <この skill のディレクトリ>/review.mjs render
```

エンジンの stdout（人間可読レポート + 末尾の JSON 埋め込み）を**そのまま**提示・投稿する。PR レビューの場合、`gh pr comment <N> --body "<レポート>"` で PR にコメントする。`--json` で埋め込み対象の Schema v1 JSON のみを取り出せる。

## review-json Schema v1（契約・不変）

エンジンが埋め込む JSON は次の形（[ADR-0025](https://github.com/ozzy-labs/handbook/blob/main/adr/0025-skills-review-multi-perspective.md) Schema v1、drive がこれを再読して観点別 `exit_criteria.drive_loop` を判定する）:

```json
{
  "version": "1",
  "mode": "quick",
  "axes_applied": ["security", "correctness", "..."],
  "findings": [
    {
      "axis": "security",
      "severity": "warning",
      "file": "src/x.ts",
      "line": 42,
      "issue": "...",
      "why": "...",
      "suggestion": "...",
      "axes_merged": ["security", "correctness"]
    }
  ],
  "conflicts": [
    { "axes": ["security", "usability"], "file": "src/y.ts", "line": 10, "description": "..." }
  ],
  "summary": {
    "by_axis": { "security": { "critical": 0, "warning": 1, "info": 0 } },
    "total": { "critical": 0, "warning": 1, "info": 3 }
  }
}
```

`axes_merged` と `conflicts` は任意フィールド（重複統合・観点間衝突がある場合のみエンジンが付与）。

### Version migration policy

- `version` は単調増加の整数（文字列）。本 ADR で `"1"` を確立する
- reader 側（drive など）は `version` が現状コードの上限と一致する場合のみ機械判定を行う
- 未対応 version は `unknown_review_version` として fail-soft 終了し、JSON を無視して人間可読部分のみ扱う
- 互換破壊変更は `version` を bump し、reader は最低 N-1 まで読める実装を維持する。**Schema v1 を変更する場合はエンジン（`review.mjs`）・本 SKILL.md・drive の再読ロジックを同時に改訂する**

## 過去 PR コメントとの互換（resume）

drive が過去に投稿したコメントには JSON 埋込みがない場合がある。reader は次のように扱う:

- `<!-- review-json:v1 ... -->` を含むコメント → JSON を解析して機械判定
- JSON 不在のコメント → **legacy comment** として扱い、新規 review pass の trigger として無視する（過去コメントは消さない）
- `<!-- review-json:v<unknown> ... -->` → `unknown_review_version` として無視（fail-soft）

## 注意事項

- `Critical` を 1 件でも報告する場合は明確な悪影響（バグ・脆弱性等）の根拠を示す
- 観点の severity 判定は対応する `perspectives/<axis>.md` の severity ガイドに従う。観点を超えて勝手に重要度を上げ下げしない
- deep モードは観点数 × 並列度ぶんのトークンを消費する。drive のオーケストレーションモードでは強制的に quick にフォールバック（コスト管理）
- `Info` は提案のみ。drive の review loop では `Info` を修正対象としない
