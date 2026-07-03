---
name: ci-fix
description: 失敗した CI run のログを収集してコンテキストを整形し `/drive` へ接続する薄い wrapper。入力解決（明示 run id > 明示 branch の最新 failure > 現在ブランチの最新 failure）→ flaky 判定（`gh run rerun --failed` 1 回 + polling、`--no-rerun` で skip）→ ログ抽出（`gh run view --log-failed`、ANSI 除去 + エラー行抽出 regex は health の same-error 判定と同一）→ 指示テキスト組み立て → `/drive` 起動。`--dry-run` は指示テキストのみ出力（rerun も drive 起動もしない）。main ブランチの failure は優先度高としてレポート冒頭で明示。
---

# ci-fix - 失敗 CI run のコンテキスト整形 → drive 接続

失敗した CI run の**ログ収集とコンテキスト整形だけを担う薄い wrapper**。実装・修正・PR 作成は `/drive` の責務なので、本 skill は「どの run を対象にするか」「flaky でないか」「何が失敗したか」を確定し、整形した**指示テキスト**を単一モードの `/drive` に渡すところまでを行う。これにより health の Recent failed actions（領域 13）を閉じる経路が skill として成立する。

決定論的な処理（入力解決の優先順位 / flaky 判定フロー / エラー抽出 regex）は本 SKILL.md の固定契約であり、Claude が自由判断で順序や regex を変えない。

## 入力

```text
ci-fix [<run-id> | --branch <name>]
  --no-rerun   flaky 判定（rerun）を skip する（クレジット消費を避けたい場合）
  --dry-run    指示テキストのみ出力する（rerun も drive 起動もしない・副作用なし）
  --auto       drive 起動前の確認を skip する（Claude Code companion 参照）
```

`<run-id>` と `--branch` は同時指定しない（run id が優先）。

## 入力解決の優先順位（固定）

対象 run は下表の順で解決する。上位が解決できたら下位は評価しない（固定順・Claude は再解釈しない）。

| 順位 | 入力 | 解決方法 |
| --- | --- | --- |
| 1 | 明示 run id（`<run-id>`） | その run を対象にする |
| 2 | 明示 branch（`--branch <name>`） | `gh run list --branch <name> --status failure --limit 1` の最新 failure |
| 3 | 現在ブランチ（入力なし） | `gh run list --branch <current-branch> --status failure --limit 1` の最新 failure |

該当する failed run がない場合は「**failed run なし**」と報告して終了する（drive は起動しない）。

**main ブランチの failure は優先度高**（= merged コードの破損）として扱い、レポート冒頭で明示する。対象 run のブランチが `main` の場合は最初の 1 行で `⚠️ main branch failure (merged code broken)` を出す。

## flaky 判定（先行）

再現しない失敗（flaky）を drive に流さないため、ログ抽出の**前に** 1 回だけ再実行して判定する。`--no-rerun` 指定時はこのステップ全体を skip し、直接ログ抽出へ進む。

1. `gh run rerun <id> --failed` を **1 回だけ** 実行する（失敗した job のみ再実行）。
2. 完了まで polling する: **間隔 30 秒・上限 15 分**。`gh run view <id> --json status,conclusion` で `status=completed` まで待つ。
3. 判定:
   - 再実行が `success` で完了 → 「**flaky（修正不要）**」と報告して終了する（drive は起動しない）。
   - 再実行が再び `failure` → 再現する失敗として次の「ログ抽出」へ進む。
   - polling が上限 15 分に到達 → `要確認`（判定不能）として終了する（drive は起動しない）。

`--no-rerun` の場合は rerun せず、直近の failed run のログをそのまま抽出対象にする（flaky か否かは判定しない）。

## ログ抽出

再現する失敗のみ、失敗ログからエラー要約を抽出する。

```bash
gh run view <id> --log-failed | tail -200
```

抽出は 2 段:

1. **ANSI 除去:** `/\[[0-9;]*m/g` を空文字に置換する。
2. **エラー行抽出:** 各行に `/(error|Error|failed)[\s:].*$/` をマッチさせ、**最後にマッチした行**のマッチ部分を要約キーにする。

この 2 つの regex は **health `--deep` の same-error 判定と同一**（SSOT は `.agents/skills/health/health-check.mjs` の `stripAnsi` と `extractCiErrorKey`）。`tests/ci-fix.test.mjs` が health-check.mjs と本 SKILL.md の regex 一致を sync assertion で強制する（drift 防止）。regex を変える場合は health 側と本 SKILL.md を同時に改訂する。

## 指示テキスト（テンプレート）

drive に渡す指示テキストは次の形式で組み立てる。分からない項目は省略する（空欄で埋めない）。

```text
CI failure on <workflow-name> (branch: <branch>, run: <run-id>)

  Job:   <failed-job>
  Step:  <failed-step>
  Error: <抽出したエラー要約>
  Workflow file: <.github/workflows/xxx.yaml のパス>
  Repro: <再現コマンド（分かる場合。例: pnpm test / pnpm run lint）>

上記の CI 失敗を調査して原因を修正し、PR を作成してください。
```

`<workflow-name>` / `<failed-job>` / `<failed-step>` は `gh run view <id> --json` の出力から、workflow ファイルパスは `.github/workflows/` の該当ファイルから埋める。

## drive への接続

- **既定:** 組み立てた指示テキストを提示して確認を取り、承認後に単一モードの `/drive "<指示テキスト>"` を起動する（確認 UI の配線はホスト依存 — Claude Code は `SKILL.claude-code.md` の AskUserQuestion）。drive 起動は PR 作成という**外部可視アクション**なので既定で確認を挟む。
- **`--auto`:** 起動前の確認を skip して直接 `/drive` を起動する（外部可視アクションの明示 opt-out）。
- **`--dry-run`:** 指示テキストを出力するだけで **rerun も drive 起動も行わない**（下記「副作用の境界」参照）。

## 副作用の境界

| フラグ | rerun（`gh run rerun`） | drive 起動 |
| --- | --- | --- |
| （既定） | する（1 回） | 確認後にする |
| `--no-rerun` | しない | 確認後にする |
| `--auto` | する（1 回） | 確認なしでする |
| `--dry-run` | **しない** | **しない** |

`--dry-run` は**副作用なし**（rerun によるクレジット消費も drive の PR 作成も発生しない）。`--dry-run` と他フラグが同時指定された場合も `--dry-run` の「出力のみ」が優先される。

## スコープ外

| 項目 | 除外理由 |
| --- | --- |
| 1. 実際の修正・PR 作成 | drive の責務。本 skill は入力解決とコンテキスト整形のみ |
| 2. flaky の複数回再実行 | rerun は 1 回のみ（クレジット消費を抑える）。1 回で通れば flaky、通らなければ再現扱い |
| 3. 複数 run の一括処理 | 対象は 1 run のみ。複数失敗は個別に起動する |

## 注意事項

- `.env` ファイルは読み取り・ステージングしない
- `gh` CLI が未認証の場合はエラーメッセージを表示して中断する
- エラー抽出 regex の SSOT は health（`health-check.mjs` の `extractCiErrorKey`）。本 skill は同一 regex を文書化し、テストで一致を強制する（再掲による drift を防ぐため regex 自体を勝手に拡張しない）
- 対象 run のブランチが `main` の場合は優先度高としてレポート冒頭で明示する
