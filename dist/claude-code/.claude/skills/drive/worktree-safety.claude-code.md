# drive worktree safety（Claude Code 固有）

`SKILL.claude-code.md` の Phase Final-1（親 worktree 整合性チェック）と Phase Final-5（subagent worktree cleanup）の**実行詳細**を切り出したリファレンス。overlay 本体はここへリンクするだけに留め、記述量を抑える。Claude Code の worktree 機構（`.claude/worktrees/agent-<id>/`・共有 git directory・harness lock）に固有の手順。

## 実行機構との整合（Workflow 方式 / Agent tool 方式）

本リファレンスの汚染検出・recovery・cleanup は **Workflow 方式（canonical）と Agent tool 方式（fallback）の両方**に適用する。worker の起動機構は異なるが、いずれも同じ worktree path 規約（`.claude/worktrees/agent-<id>/`）と共有 git directory を使うため、機構は共通:

- **Workflow 方式 `agent({ isolation: 'worktree' })`**: ランタイムが worktree を provision する。ただし **worker が commit を残した worktree（drive worker は全て commit する）は「変更あり」としてランタイムの自動削除対象にならず残存**する。したがって (a) worker の git 操作は依然として共有 git directory 経由で親を汚染し得る（→ Phase Final-1 の汚染検出 7 軸は省略不可）、(b) 残存 worktree の cleanup は Phase Final-5 の手順で親（会話側・workflow return 後）が実行する。ランタイムが cleanup を肩代わりするのは「無変更で終わった agent の worktree」のみ。
- **Agent tool 方式 `Agent({ isolation: "worktree" })`**: worktree の provision も cleanup も会話側で行う。検出・recovery・cleanup 手順は下記のまま。

いずれの方式でも Phase Final-1〜Final-5 は worker（workflow / Agent）の**完了後に会話側で**実行する。

## 汚染検出 7 軸（Phase Final-1）

subagent が共有 git directory 経由で親の `HEAD` / `index` / `refs/heads/main` を汚染するケースに備える fail-safe（[#66](https://github.com/ozzy-labs/skills/issues/66) / [#77](https://github.com/ozzy-labs/skills/issues/77) / [#89](https://github.com/ozzy-labs/skills/issues/89) 由来）。Phase 20 (opshub) 実行で「prompt 禁止だけでは subagent 4 並列のうち 3 件で汚染再発」、`/sync-consumers` epic 実行で「subagent 戻り値の自己申告と実態が乖離（worktree が `refs/heads/main` を握っていた）」が観察された。検出は 7 軸 + subagent 戻り値の `final_head_state` 交差確認で構成する。

1. `git rev-parse HEAD` と `git rev-parse $(git symbolic-ref HEAD)` が一致するか（HEAD が detached でないこと）
2. `git diff HEAD --stat` が空か（index が HEAD と乖離していないか）
3. `git status --short` が空か（working tree が clean か）
4. 親のベースブランチ（通常 `main`）が `git rev-parse origin/<base-branch>` と一致するか、または `--merge` で merged された PR の SHA を含むか
5. `git rev-parse refs/heads/main` と `git rev-parse origin/main` が一致するか（`refs/heads/main` ref が stuck していないか。`git reset --hard origin/main` だけでは ref が更新されず、HEAD が subagent branch を指す場合は subagent branch が reset されるだけで main ref は古い SHA のまま残る）
6. `git symbolic-ref HEAD` が `refs/heads/main`（ベースブランチ）を指しているか（subagent branch を指していないか）
7. **subagent worktree が `refs/heads/main` を握っていないか**（[#89](https://github.com/ozzy-labs/skills/issues/89) 由来）。`git worktree list --porcelain` で各 subagent worktree (`.claude/worktrees/agent-<id>/`) を走査し、`branch refs/heads/main` を出すものがあれば warning。subagent は自 worktree branch (`feat/...` 等) で完結すべきで、`refs/heads/main` を握る = subagent が prompt 違反の操作 (例: `git symbolic-ref HEAD refs/heads/main`) を行った signal:

   ```bash
   git worktree list --porcelain | awk '/^worktree/{w=$2} /^branch refs\/heads\/main/{if(w!="<parent-root>") print "WARN: "w" holds refs/heads/main"}'
   ```

加えて、subagent 戻り値の `final_head_state.symbolic_ref` が `refs/heads/main` または空（detached）の場合は self-申告とも乖離している signal として warning に記録する（[#89](https://github.com/ozzy-labs/skills/issues/89)）。

## recovery シーケンス（Phase Final-1）

いずれかが不一致なら、集約レポート末尾に warning を出す。recovery は worktree lock を確実に回避する順序で行う:

```text
⚠️ Parent worktree drift detected:
  HEAD:                 <sha> (symbolic-ref: <ref>)
  refs/heads/main:      <sha> (expected: origin/main = <sha>)
  index diff:           <files>
  working tree:         <files>
  Recovery (push 前の汚染に対する確実な回復シーケンス):

    # 1. 現状把握 + subagent branch 名を保存
    #    step 3 で HEAD を main に切替えると `git symbolic-ref HEAD` は main を返すため、
    #    step 5 で参照する branch 名はここで変数に保存しておく必要がある
    SUBAGENT_BRANCH=$(git symbolic-ref --short HEAD)
    git rev-parse HEAD
    git rev-parse refs/heads/main
    git rev-parse origin/main
    git symbolic-ref HEAD
    git status --short
    git diff HEAD origin/main --stat  # 内容比較。空なら reset で安全に消せる

    # 2. main ref を origin/main に揃える (HEAD が subagent branch を指していても影響なし)
    git update-ref refs/heads/main origin/main

    # 3. HEAD を main に切替 (git checkout main は worktree lock で失敗するため update-ref 系を使う)
    git symbolic-ref HEAD refs/heads/main

    # 4. index + working tree を HEAD (= origin/main) と同期
    git reset --hard HEAD

    # 5. subagent stuck branch を削除 (HEAD だったため deletable に変わる。step 1 で保存した変数を使う)
    git branch -D "$SUBAGENT_BRANCH"
```

`git checkout main` 系は意図的に使わない（親 worktree が main を握っているため `fatal: 'main' is already used by worktree at ...` で失敗する）。`git update-ref refs/heads/main` を **先に**実行する点が load-bearing — 後にすると `reset --hard origin/main` が subagent branch を target にしてしまい、main ref が古い SHA で stuck したまま残る。

## cleanup 実行手順（Phase Final-5）

cleanup の status 別ポリシー（どの status を削除し、どれを残置するか）は canonical（`SKILL.md`）の Phase Final-5 に従う。ここは Claude Code worktree 機構固有の実行手順（[#69](https://github.com/ozzy-labs/skills/issues/69) / [#90](https://github.com/ozzy-labs/skills/issues/90) 由来）。

1. 今回起動した subagent のリストを保持する。各 subagent の worktree パス（`.claude/worktrees/agent-<id>/`）と戻り値 `status` を控える
2. **各 worktree の処理は subshell で囲む**（[#90](https://github.com/ozzy-labs/skills/issues/90) 由来）。`git worktree remove` の副作用で親 shell の cwd が「No such file or directory」状態になり、以降の git コマンド全てが fail する現象が観察されたため、subshell で囲って cwd 喪失を伝播させない:

   ```bash
   for WT_ID in <agent-id-1> <agent-id-2> ...; do
     (
       cd <parent-worktree-root>  # subshell 内で明示的に親 root に cd
       WT_PATH=".claude/worktrees/agent-$WT_ID"
       BRANCH=$(git worktree list --porcelain | awk -v p="$WT_PATH" '$1=="worktree" && $2 ~ p {getline; getline; if($1=="branch") print $2}' | sed 's|refs/heads/||')
       git worktree remove -f -f "$WT_PATH"
       [ -n "$BRANCH" ] && git branch -D "$BRANCH"
       git branch -D "worktree-agent-$WT_ID"
     )
   done
   ```

   subshell の終了で cwd 変化は親に伝播せず、次の iteration も clean state で始まる。`cd <parent-worktree-root>` は subshell ごとに明示する（保険）。

3. worktree cleanup の要点:
   - `git worktree list --porcelain` で当該 worktree が握っている branch を取得する（パターンマッチに頼らない）
   - `git worktree remove -f -f <path>` を実行する（`-f -f` の二重 force は Claude Code harness の `lock` 解除のため必須）
   - 取得した branch を `git branch -D <branch>` で削除する
4. `worktree-agent-<id>` 形式の synthetic branch（Claude Code harness 実装由来）が残っていれば `git branch -D worktree-agent-<id>` で削除する。Phase 20 (opshub) では 4/4 で残置されたため実態は必須項目。検出失敗時は warning に留めるが、**最後に `git branch --list 'worktree-agent-*'` を必ず実行して残存件数が 0 であることを確認する**（残存ありなら warning に件数と branch 名を出す）

`merged` 以外で残置された worktree がある場合、または cleanup 自体に失敗した worktree がある場合の warning 形式:

```text
⚠️ Stale worktrees / branches detected:
  preserved (failed):
    .claude/worktrees/agent-<id>  [<branch>]  ← #<N> failed; resume 可能
  cleanup failed:
    .claude/worktrees/agent-<id>  [<branch>]  reason: <error>
  Manual cleanup:
    git worktree remove -f -f <path>
    git branch -D <branch>
```
