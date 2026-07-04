# Releasing `@ozzylabs/skills`

このリポの配布パイプラインと、初回リリースおよび以降の自動リリースの手順をまとめる。

## パイプライン全体像

```text
main への Conventional Commits マージ
  └─ release.yaml (on: push main)
       ├─ release-please: 次バージョンの "Release PR" を常に 1 本メンテ
       │    Release PR をマージ → Git タグ + GitHub Release 作成 (release_created=true)
       └─ publish: release_created 時のみ発火
            npm publish --provenance --access public  (OIDC Trusted Publisher)
```

- バージョン決定は `release-please-config.json`（`release-type: node` / `bump-minor-pre-major: true` / `bump-patch-for-minor-pre-major: true`）。**pre-1.0 の間は `feat` を minor、破壊的変更も minor に集約**する。
- 現在バージョンは `.release-please-manifest.json`（`"." : "x.y.z"`）で管理。Release PR マージのたびに自動更新される。
- npm publish は **OIDC Trusted Publishers**（`NPM_TOKEN` は使わない）。`package.json` の `publishConfig` は `{ access: public, provenance: true, registry: npmjs }`。

## 前提として一度だけ必要な 2 つの外部設定

### A. release-please 用のトークン（自動リリースを機能させるために必須）

**問題**: `main` には ruleset `main-protection`（`required_status_checks: [lint-and-build]`, bypass_actors なし）が掛かっている。しかし release-please が **既定の `GITHUB_TOKEN`** で作った Release PR は CI をトリガしない（GitHub は `GITHUB_TOKEN` が発火させたワークフローイベントを抑止するため）。結果、Release PR に `lint-and-build` が永遠に付かず **恒久的に `BLOCKED`** になる。これは初回だけでなく **すべての Release PR** で再発する。

**対処**: release-please に **既定でない token** を渡すと、その PR は通常どおり CI をトリガして required check を満たせる。`release.yaml` は次のように配線済み:

```yaml
token: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}
```

`RELEASE_PLEASE_TOKEN` secret を設定するまでは `GITHUB_TOKEN` にフォールバックする（＝現状の挙動のまま・破壊しない）。自動リリースを有効にするには、以下のいずれかで `RELEASE_PLEASE_TOKEN` を用意する。

#### 推奨: GitHub App トークン（org 慣行。長期 PAT を持たない）

org は Renovate を GitHub App で運用している（handbook ADR-0021）。同じ方針で、`contents: write` + `pull-requests: write` 権限を持つ App を作成し、`release.yaml` の release-please ジョブ先頭で per-run トークンを発行して渡す:

```yaml
      - uses: actions/create-github-app-token@<pin-to-sha> # v2
        id: app-token
        if: ${{ vars.RELEASE_APP_ID != '' }}
        with:
          app-id: ${{ vars.RELEASE_APP_ID }}
          private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}
      - uses: googleapis/release-please-action@<pinned> # v5.0.0
        with:
          token: ${{ steps.app-token.outputs.token || secrets.GITHUB_TOKEN }}
          ...
```

> `uses:` は本リポ慣行に従い **SHA ピン**（`# vX` コメント付き）にすること。`vars.RELEASE_APP_ID` 未設定なら app-token step は skip され `GITHUB_TOKEN` にフォールバックする（安全）。

#### 簡易: fine-grained PAT

App を作らない場合は、対象リポに `Contents: Read and write` + `Pull requests: Read and write` を持つ fine-grained PAT を発行し、リポ secret `RELEASE_PLEASE_TOKEN` に登録する。有効期限管理が必要なので長期運用は App を推奨。

### B. npm Trusted Publisher（初回 publish の前に必須）

`@ozzylabs/skills` はまだ npm 未公開（初回 publish）。OIDC Trusted Publishing を CI から通すには、npmjs.com の当該パッケージに **この `release.yaml` を指す Trusted Publisher** を事前設定する必要がある。新規パッケージは「パッケージが存在しないと TP を設定できない」鶏卵問題があるため、**初回だけは手動で publish** してパッケージを作り、その後 TP を設定して 2 回目以降を CI に委ねる（下記「初回リリース」を参照）。詳細は knowledge `standards/npm-trusted-publishers`。

## 初回リリース（v0.1.0・手動）

初回は A（Release PR が BLOCKED）と B（TP 鶏卵）を手動で回避する。`RELEASE_PLEASE_TOKEN` 設定前でも実施できる。

1. `main` が green であることを確認（`pnpm build && pnpm test && pnpm run lint:all`）。
2. ローカル or 一時的な認証で publish（OIDC が使えない初回のみ、granular token 等）:

   ```bash
   pnpm build
   npm publish --provenance --access public
   ```

3. タグと GitHub Release を作成:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   gh release create v0.1.0 --title "v0.1.0" --generate-notes
   ```

4. `.release-please-manifest.json` を `{ ".": "0.1.0" }` に更新してコミット（release-please の起点合わせ）。
5. release-please が自動生成していた **0.1.0 の Release PR（#1）は用済みなので close** する。
6. npmjs.com で `@ozzylabs/skills` に Trusted Publisher（この `release.yaml`）を設定する（B 完了）。

## 2 回目以降（自動）

A（`RELEASE_PLEASE_TOKEN`）と B（TP）が整っていれば:

1. `main` に `feat` / `fix` 等をマージすると release-please が次バージョンの Release PR をメンテする。
2. その Release PR には CI（`lint-and-build`）が走る → ruleset を満たしマージ可能。
3. `/release` skill で検証（SemVer 整合 / CHANGELOG / CI green）→ 承認ゲート → マージ。
4. マージで `publish` ジョブが発火し、OIDC で npm publish → provenance 付きで公開。

> `RELEASE_PLEASE_TOKEN` 未設定のまま Release PR をマージしたい場合は、初回同様に手動タグ + 手動 publish で出すこともできる（自動 publish を使わない運用）。

## 参考

- knowledge `tools/release-please`（"GITHUB_TOKEN で作られた PR/tag は downstream CI をトリガしない。GitHub App トークンまたは PAT を `token:` に渡す"）
- knowledge `standards/npm-trusted-publishers`
- handbook ADR-0021（Renovate を GitHub App で運用）
