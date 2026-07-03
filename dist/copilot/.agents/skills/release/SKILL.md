---
name: release
description: release-please PR を検出（`gh pr list --author app/release-please --state open`）し、固定チェックリスト（version bump と含有 commit type の SemVer 整合 feat→minor / fix→patch / `!` or BREAKING CHANGE→major、CHANGELOG 整合、CI 全 green）で検証してから、既定は承認ゲート（外部可視・実質不可逆）を通して `gh pr merge --squash` する。マージ後は publish workflow を polling（30s 間隔・上限 20 分）で監視し `npm view <pkg> version` で反映確認する（npm 配布リポのみ）。`--auto` は全検証 pass 時のみゲートを skip（fail 時は停止）。npm publish は OIDC Trusted Publishers 前提（`NPM_TOKEN` 不使用）。
---

# release - release-please PR の検証 → ゲート付きマージ → publish 監視

merged 以降〜配布（release-please PR の処理、npm OIDC publish の監視）は skill 化されておらず、リリース時だけ手作業に戻っていた。health の draft release `要対応`（領域 14）を閉じる経路もなかった。本スキルはその一連を一本化する: release-please PR を検出し、固定チェックリストで検証し、**既定は承認ゲート**を通してマージし、publish workflow を監視して npm への反映まで見届ける。

リリースは **外部可視かつ実質不可逆**（公開済みバージョンは撤回できない）なので、判定は固定チェックリスト（決定論）に閉じ、Claude が「良さそう」で勝手にマージしない。承認ゲートは中央 autonomy policy（`policy` skill の `irreversible` gate）に従う。

**スコープ**: 単一リポジトリの release-please PR の検証・マージ・publish 監視。automation dependency PR（renovate / dependabot）は `/deps` の責務、release-please 以外の PR は対象外。cross-repo は将来検討。

## 入力

```text
release
  --repo owner/repo   (省略時は cwd の origin から解決)
  --auto              (全検証 pass 時のみ承認ゲートを skip。検証 fail 時は --auto でも停止)
```

- `--auto` は routine / `/loop` / `schedule` 連携用の opt-in。無人実行では対話できないため、**固定チェックリスト**（下記）と policy gate が唯一の境界になる。
- `--auto` を付けても **検証が 1 つでも fail したらマージしない**（後述「承認ゲート」）。リリースは不可逆なので、`--auto` は「人の確認を省く」だけで「検証を省く」ものではない。

## 手順

### 1. 検出

```bash
gh pr list --author app/release-please --state open --json number,title,url,headRefName
```

- **0 件の場合**: 「リリース対象なし」と提示し、あわせて **draft release の有無を併記**して終了する（health 領域 14 相当の可視化）:

  ```bash
  gh release list --limit 10   # draft 列が true のものを併記
  ```

  draft release が残っていれば「未 publish の draft release があります」と案内する（release-please PR が無いのに draft がある場合は手動 release / workflow 失敗の可能性）。

- **1 件以上**: 各 PR について 2. の検証に進む。通常 release-please PR は 1 リポにつき 1 本。複数あれば 1 本ずつ扱う。
- **フォールバック**: `app/release-please` author で 0 件だが、`github-actions[bot]` が release-please-action を代理投稿している構成もある。その場合はタイトル（`chore(main): release <version>` 等）と `changelog-path` の差分で release-please PR かを確認する。

### 2. 検証チェックリスト（固定・決定論）

下表を**全項目**確認する。1 つでも fail なら「検証 fail」としてマージに進まず、失敗項目を提示して停止する（`--auto` でも停止）。

| # | 項目 | 合格条件 |
| --- | --- | --- |
| 1 | **SemVer 整合** | PR の version bump が、含有 commit type から導かれる期待 bump と一致（下記「SemVer 整合規則」） |
| 2 | **CHANGELOG 整合** | CHANGELOG エントリが含有 commit を過不足なく反映（追加 commit が漏れていない／存在しない項目が無い） |
| 3 | **CI 全 green** | PR の全 check が green（`gh pr checks <N>`。fail / cancel → red、running / queued → pending。いずれも fail 扱い） |

材料の取り方:

- **含有 commit**: `gh pr view <N> --json commits`、または `git log origin/main..<headRefName>`。各 commit の Conventional Commits type（`feat` / `fix` / `perf` / …）と `!` / body の `BREAKING CHANGE` を抽出する。
- **version bump**: PR タイトル（`chore(main): release <version>`）と `.release-please-manifest.json` の from→to、`package.json` の version diff から確定する。
- **CHANGELOG**: PR の `CHANGELOG.md` diff に、含有 commit（release をトリガする type）が過不足なく載っているかを突き合わせる。
- **CI**: `gh pr checks <N>`。1 つでも green 以外なら fail。

#### SemVer 整合規則（fixture 化可能な決定論規則）

含有 commit の type 集合から**期待 bump** を次の優先順（major > minor > patch > none）で決める:

| 含有 commit の条件 | 期待 bump |
| --- | --- |
| いずれかに `!`（例 `feat!:`）または body に `BREAKING CHANGE` | **major** |
| （breaking 無し）いずれかに `feat` | **minor** |
| （breaking / feat 無し）いずれかに `fix` または `perf` | **patch** |
| release をトリガする type が 1 つも無い（`docs` / `chore` / `refactor` / `test` / `style` / `ci` / `build` のみ） | **none**（release PR 自体が立たない） |

この規則は決定論であり、`tests/release.test.mjs` が fixture（commit type リスト → 期待 bump、`!` / BREAKING CHANGE 含む）で再実装して固定する。規則を増減する場合は本表と test を同時改訂する（Claude の自由判断で条件を足さない）。

> **pre-1.0 の注意（この repo 固有）:** release-please-config.json に `bump-minor-pre-major: true` / `bump-patch-for-minor-pre-major: true` が設定された 0.x パッケージでは、`0.y.z` の間だけ breaking→minor / feat→patch に**降格**される（1.0.0 未満は破壊的変更を minor で扱う SemVer 慣行）。検証時は対象パッケージの現行 major が 0 かを確認し、0 なら降格後の期待 bump と突き合わせる。上表の標準規則は major ≥ 1 に適用する。

### 3. 承認ゲート（中央 autonomy policy に従う）

`gh pr merge --squash` は **不可逆アクション**（irreversible）。個別ゲートを prose にハードコードせず、中央 autonomy policy（`policy` skill が定義する 3 クラス・gate 語彙の SSOT）に従う。分類とゼロコンフィグ既定:

| 本 skill のアクション | クラス | policy 参照 | ゼロコンフィグ既定 gate |
| --- | --- | --- | --- |
| release PR merge（`gh pr merge --squash`） | `irreversible` | `--action=merge` | `ask`（承認 Gate を維持） |

有効 gate は sibling の `policy` skill の `policy-read.mjs` で引く（user-scope では `~/.claude/skills/policy/policy-read.mjs`、dogfood は `<repo>/.claude/skills/policy/policy-read.mjs`、Codex/Gemini は `~/.agents/skills/policy/policy-read.mjs`）:

```bash
node <policy skill のディレクトリ>/policy-read.mjs --action=merge --repo-root="$PWD"
# => .resolved.gate（既定 ask）
```

検証結果と `--auto` の組み合わせで挙動が決まる:

- **検証 fail（1 項目でも）**: マージしない。失敗項目を提示して停止する。`--auto` でも同じ（リリースは不可逆のため検証は省略不可）。
- **全検証 pass + `--auto` 未指定**（既定）: 検証結果サマリ（version / 主要変更 / チェックリストの pass 状況）を提示し、policy gate に従う:
  - gate=`ask`（ゼロコンフィグ既定）: 承認を求め、承認された場合のみ `gh pr merge <N> --squash` を実行する。
  - gate=`batch-confirm`: サマリを 1 回提示して一括確認 → 承認で merge。
  - gate=`proceed`: 確認なしで merge。
- **全検証 pass + `--auto` 指定**: **承認ゲートを skip** して `gh pr merge <N> --squash` を直列実行する（irreversible gate の明示 opt-out）。

**policy 不在でも壊れない:** `policy-read.mjs` は fail-safe 設計で、読めない・不正な値は厳しい側（`ask`）へ倒す。`policy` skill 未配置の環境では上表のゼロコンフィグ既定 gate（`irreversible`=`ask`）を直接適用する。

### 4. publish workflow の監視

マージ後、対応する release workflow run を特定して polling する（**npm 配布リポのみ**。publish workflow が無いリポは 6. へ）:

```bash
# merge 後に発火した release workflow run を特定（例: name=Release）
gh run list --workflow release.yaml --branch main --limit 5 --json databaseId,status,conclusion,headSha,createdAt

# 特定した run を green（success）まで polling
gh run view <run-id> --json status,conclusion,jobs
```

- **polling 間隔 30 秒・上限 20 分**（最大 40 回）。上限到達時は「workflow 監視タイムアウト」として run の URL を提示し、後続の手動確認を促す。
- workflow が `success` になったら `npm view <pkg> version` で npm への反映を確認する（`<pkg>` は `package.json` の `name`。例 `npm view @ozzylabs/skills version`）。PR の version と一致すれば **配布完了**。
- workflow が `failure` になったら 5. の失敗案内に進む。

このリポの publish は OIDC Trusted Publishers（`release.yaml` の `publish` job が `needs: release-please` + `if: release_created` でゲートされ、`npm publish --provenance --access public` で発行）。詳細は「前提」節を参照。

### 5. 失敗時の案内

publish workflow が `failure` の場合、失敗ログを要約して原因を案内する（自動修正はスコープ外）:

```bash
gh run view <run-id> --log-failed   # 失敗 step のログのみ取得して要約
```

よくある原因（OIDC Trusted Publishers 文脈）:

| 症状 | 原因 | 対処の案内 |
| --- | --- | --- |
| `403 Forbidden — you don't have permission` | **Trusted Publisher 未登録** / workflow filename・repo 名の不一致 | npmjs.com の Settings → Publishing を確認 |
| `OIDC token not available` | workflow / job の **`permissions: id-token: write` 不足** | permissions を追加 |
| provenance が付かない | private repo からの publish / CircleCI（provenance 未対応） | GitHub-hosted runner + public repo を確認 |
| npm CLI が古い | npm CLI v11.5.1 未満 / Node 22.14 未満 | `npm install -g npm@latest` を確認 |

自動修正は本スキルのスコープ外。CI の再実行・修正が要る場合は `/ci-fix` 等に接続できる旨を案内する。

### 6. publish workflow なしリポの分岐

配布物を持たない（npm publish workflow が無い）リポでは、**マージ + tag / GitHub Release の確認**で完了とする:

```bash
gh release list --limit 5     # release-please が作成した Release / tag を確認
```

release-please のマージで tag と GitHub Release が作成されていれば完了。npm 反映確認（4. の `npm view`）は行わない。

## 前提: npm publish は OIDC Trusted Publishers

- npm publish は **OIDC Trusted Publishers** を使う（knowledge `standards/npm-trusted-publishers` の方針）。長寿命の **`NPM_TOKEN` は使わない**（漏洩リスク・ローテーション負担のため）。
- publish workflow は `permissions: id-token: write` を持ち、`--provenance` で attestation を自動付与する（`npm view <pkg> dist.attestations` で確認可能）。
- **private repo からの publish は public パッケージでも provenance が付かない**（source link 秘匿のため）点に注意。

## エラーハンドリング

| 状況 | 動作 |
| --- | --- |
| `--repo` 未指定で GitHub remote 不在 | エラーを提示し `--repo owner/repo` の明示を促す。マージしない |
| `gh` 未認証 / rate limit / network | エラーを提示して中断（マージ・publish 監視に進まない） |
| release-please PR 0 件 | 「リリース対象なし」+ draft release 有無を併記して終了 |
| 検証 fail（SemVer / CHANGELOG / CI のいずれか） | 失敗項目を提示して停止（マージしない）。`--auto` でも停止 |
| merge 失敗（branch protection 等） | 失敗を提示。手動マージを促す |
| publish workflow タイムアウト（20 分） | run URL を提示し手動確認を促す |
| publish workflow failure | `gh run view --log-failed` の要約 + よくある原因を案内 |

## スコープ外

| 項目 | 除外理由 |
| --- | --- |
| 1. automation dependency PR（renovate / dependabot） | `/deps` の責務。本スキルは release-please PR のみ |
| 2. 判定条件の自由化 | 検証は固定チェックリストのみ。LLM の自由判断でマージ可否を決めない（再現性・リリースの不可逆性のため） |
| 3. publish 失敗の自動修正 | ログ要約 + 原因案内まで。修正は `/ci-fix` 等に接続 |
| 4. cross-repo release | 現時点では単一リポのみ |
| 5. release-please PR 自体の生成 | release-please-action（CI）の責務。本スキルは生成された PR の検証・マージ・監視のみ |

## 注意事項

- `.env` ファイルは読み取り・ステージングしない。
- リリースは外部可視・実質不可逆。既定は承認ゲート（`irreversible`=`ask`）を維持する。`--auto` は明示 opt-out だが、**検証 fail 時は `--auto` でも停止**する。
- 検証は固定チェックリスト（SemVer 整合 / CHANGELOG / CI green）でのみ判定する。Claude は再判定しない（迷ったら停止）。
- npm publish は OIDC Trusted Publishers（`NPM_TOKEN` 不使用）。
- 新規 runtime 依存は追加しない（Node stdlib + `gh` / `git` / `npm` のみ）。
