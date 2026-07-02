---
name: implement
description: Issue または指示をもとに、ブランチ作成・実装計画・コード変更を行う。Issue 番号またはテキスト指示を受け取る。
---

# implement - Issue/指示からブランチ作成・実装

Issue 読解または直接指示をもとに、ブランチ作成・実装計画・コード変更までを行う。

## 入力

- **Issue 番号の場合**（`#N` または数字のみ）: `gh issue view <N>` で内容を取得し、要件を整理する
- **テキスト指示の場合**: そのまま要件として扱う
- **引数なしの場合**: 何を実装するか確認する

## アクション分類と policy 参照

本 skill は個別の承認ゲートを prose にハードコードせず、中央 autonomy policy（`policy` skill が定義する 3 クラス・gate 語彙・`policy.yaml` 階層の SSOT）に従う。自分のアクションを次のクラスに分類し、有効 gate を引いてから実行する:

| 本 skill のアクション | クラス | policy 参照 | ゼロコンフィグ既定 gate |
| --- | --- | --- | --- |
| branch 上の実装（ファイル編集・追加・safe な削除） | `reversible-local` | `--action=branch-edit` | `proceed`（計画を提示して続行 + audit trail） |
| migration / データ削除 / CI・リリース設定変更を含む変更 | `irreversible` | `--class=irreversible` | `ask`（着手前に明示承認） |

有効 gate は sibling の `policy` skill の `policy-read.mjs` で引く（Claude Code の user-scope では `~/.claude/skills/policy/policy-read.mjs`、dogfood は `<repo>/.claude/skills/policy/policy-read.mjs`、Codex/Gemini は `~/.agents/skills/policy/policy-read.mjs`）:

```bash
node <policy skill のディレクトリ>/policy-read.mjs --action=branch-edit --repo-root="$PWD"
# => .resolved.gate（既定 proceed）
node <policy skill のディレクトリ>/policy-read.mjs --class=irreversible --repo-root="$PWD"
# => .resolved.gate（既定 ask）
```

gate 語彙は 3 値のみ:

- `proceed`: 承認を待たずに実行し、計画・変更内容を audit trail として報告に残す
- `batch-confirm`: 着手前に 1 回だけまとめて確認する
- `ask`: アクションごとに明示承認（Approval Gate）を得る

**policy 不在でも壊れない:** `policy-read.mjs` は fail-safe 設計で、読めない・不正な値は必ず厳しい側（`ask`）へ倒す。`policy` skill 自体が未配置で `policy-read.mjs` を呼べない環境では、上表のゼロコンフィグ既定 gate（`reversible-local`=`proceed` / `irreversible`=`ask`）を直接適用する。

**drive 配下との整合:** drive はユーザーから自律実行を委任されており、`reversible-local` の既定 `proceed`（計画承認をスキップして続行）はこの委任と整合する。標準の branch 実装は proceed で進み、`irreversible` と判定した変更のみ gate=`ask` で承認を求める。

## 手順

### 1. ブランチ作成

1. `git status` と `git branch --show-current` で現在の状態を確認する
2. 要件から `<type>/<slug>` 形式のブランチ名を決定する
3. `git checkout -b <branch-name>` でブランチを作成する

既にフィーチャーブランチにいる場合は、そのブランチで作業を続けるか確認する。

### 2. 実装計画とアクション分類

1. コードベースを調査する
   - 関連ファイルの特定
   - 既存の実装パターンの把握
   - 影響範囲の確認
2. 実装計画を提示する:
   - 変更するファイルとその内容
   - 影響範囲
3. 変更内容を「アクション分類と policy 参照」の表でクラスに分類し、policy の有効 gate を引く:
   - 通常の branch 上の実装のみ → `reversible-local`（既定 `proceed`）: 計画を提示して続行する（承認待ちをしない。計画は audit trail として残す）
   - migration / データ削除 / CI・リリース設定変更を含む → `irreversible`（既定 `ask`）: 明示承認を得てから実装に進む

### 3. 実装

policy で解決した gate に従い、コード変更を実行する（`proceed` は承認待ちなしで着手、`batch-confirm` は着手前に一括確認、`ask` は承認後に着手）。各ファイルの変更完了時に進捗を報告する。

### 4. 動作確認（verify）

実装完了後、`~/.agents/skills/verify/SKILL.md` を参照し、verify エンジンで複合検証（ビルド + 型 + テスト + lint）を実行する。verify は検証コマンドを発見連鎖（AGENTS.md「検証」節 → package.json scripts → task runner → 言語 heuristic）で自動発見し、出典付きで直列実行する。

エラーが出た場合はその場で修正し、再度 verify を実行する。

### 5. 完了報告

```text
実装完了:
  ブランチ: <branch-name>
  変更ファイル:
    A path/to/new-file
    M path/to/modified-file
```

## 注意事項

- .env ファイルは読み取り・ステージングしない
- `gh` CLI が未認証の場合はエラーメッセージを表示して中断する
- アクションを 3 クラスに分類し policy を引いてから実行する。個別の承認ゲートを prose にハードコードしない
- `irreversible`（migration / データ削除 / CI・リリース設定変更）と判定した変更は gate=`ask` の下で必ず明示承認を得てから着手する
