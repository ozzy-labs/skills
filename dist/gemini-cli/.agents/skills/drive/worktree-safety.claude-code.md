# drive worktree safety (Claude Code-specific)

A reference that carves out the **execution details** of `SKILL.claude-code.md`'s Phase Final-1 (parent worktree consistency check) and Phase Final-5 (subagent worktree cleanup). The overlay body itself only links here, keeping its own content concise. These are procedures specific to Claude Code's worktree mechanism (`.claude/worktrees/agent-<id>/`, the shared git directory, harness locks).

## Alignment with the execution mechanism (Workflow method / Agent tool method)

This reference's contamination detection, recovery, and cleanup apply to **both the Workflow method (canonical) and the Agent tool method (fallback)**. The worker launch mechanism differs, but since both use the same worktree path convention (`.claude/worktrees/agent-<id>/`) and shared git directory, the mechanism is common:

- **Workflow method `agent({ isolation: 'worktree' })`**: the runtime provisions the worktree. However, **a worktree where the worker left a commit (every drive worker commits) is treated as "having changes" and is not subject to the runtime's automatic deletion, so it persists**. Therefore, (a) the worker's git operations can still pollute the parent via the shared git directory (→ the 7 contamination-detection axes in Phase Final-1 can't be skipped), and (b) cleanup of surviving worktrees is performed by the parent (on the conversation side, after the workflow returns) via the Phase Final-5 procedure. The runtime only takes care of cleanup for "worktrees of agents that finished with no changes."
- **Agent tool method `Agent({ isolation: "worktree" })`**: both the provisioning and cleanup of the worktree are done on the conversation side. The detection, recovery, and cleanup procedures are as described below.

With either method, Phase Final-1 through Final-5 are run **on the conversation side, after the worker (workflow / Agent) completes**.

## 7 contamination-detection axes (Phase Final-1)

A fail-safe for the case where a subagent pollutes the parent's `HEAD` / `index` / `refs/heads/main` via the shared git directory (originating from [#66](https://github.com/ozzy-labs/skills/issues/66) / [#77](https://github.com/ozzy-labs/skills/issues/77) / [#89](https://github.com/ozzy-labs/skills/issues/89)). During the Phase 20 (opshub) run, "contamination recurred in 3 of 4 parallel subagents even with the prompt prohibition alone" was observed, and during the `/sync-consumers` epic run, "a discrepancy between the subagent return value's self-report and reality (a worktree was holding `refs/heads/main`)" was observed. Detection consists of 7 axes + cross-checking the subagent return value's `final_head_state`.

1. Whether `git rev-parse HEAD` and `git rev-parse $(git symbolic-ref HEAD)` match (that HEAD is not detached)
2. Whether `git diff HEAD --stat` is empty (whether the index has diverged from HEAD)
3. Whether `git status --short` is empty (whether the working tree is clean)
4. Whether the parent's base branch (usually `main`) matches `git rev-parse origin/<base-branch>`, or includes the SHA of a PR merged via `--merge`
5. Whether `git rev-parse refs/heads/main` matches `git rev-parse origin/main` (whether the `refs/heads/main` ref is stuck. `git reset --hard origin/main` alone doesn't update the ref — if HEAD points to the subagent branch, only the subagent branch gets reset, and the main ref remains stuck at the old SHA)
6. Whether `git symbolic-ref HEAD` points to `refs/heads/main` (the base branch) (and not to a subagent branch)
7. **Whether a subagent worktree is holding `refs/heads/main`** (originating from [#89](https://github.com/ozzy-labs/skills/issues/89)). Scan each subagent worktree (`.claude/worktrees/agent-<id>/`) with `git worktree list --porcelain`, and warn if any shows `branch refs/heads/main`. A subagent should stay self-contained within its own worktree branch (`feat/...`, etc.); holding `refs/heads/main` is a signal that the subagent performed an operation that violated the prompt (e.g., `git symbolic-ref HEAD refs/heads/main`):

   ```bash
   git worktree list --porcelain | awk '/^worktree/{w=$2} /^branch refs\/heads\/main/{if(w!="<parent-root>") print "WARN: "w" holds refs/heads/main"}'
   ```

In addition, if the subagent return value's `final_head_state.symbolic_ref` is `refs/heads/main` or empty (detached), it's recorded as a warning as a signal of a discrepancy with the self-report too ([#89](https://github.com/ozzy-labs/skills/issues/89)).

## Recovery sequence (Phase Final-1)

If any of these don't match, output a warning at the end of the aggregate report. Recovery is performed in an order that reliably avoids the worktree lock:

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

`git checkout main`-style commands are deliberately not used (since the parent worktree holds main, it would fail with `fatal: 'main' is already used by worktree at ...`). Running `git update-ref refs/heads/main` **first** is load-bearing — if done afterward, `reset --hard origin/main` would end up targeting the subagent branch, and the main ref would remain stuck at the old SHA.

## Cleanup execution steps (Phase Final-5)

The per-status cleanup policy (which statuses to delete, and which to leave in place) follows the canonical's (`SKILL.md`) Phase Final-5. This section covers the Claude Code worktree-mechanism-specific execution steps (originating from [#69](https://github.com/ozzy-labs/skills/issues/69) / [#90](https://github.com/ozzy-labs/skills/issues/90)).

1. Keep the list of subagents launched this time. Note each subagent's worktree path (`.claude/worktrees/agent-<id>/`) and its return-value `status`
2. **Wrap the processing of each worktree in a subshell** (originating from [#90](https://github.com/ozzy-labs/skills/issues/90)). Since a side effect of `git worktree remove` has been observed to put the parent shell's cwd into a "No such file or directory" state, causing every subsequent git command to fail, wrap it in a subshell so the cwd loss doesn't propagate:

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

   The cwd change doesn't propagate to the parent when the subshell exits, so the next iteration also starts in a clean state. `cd <parent-worktree-root>` is stated explicitly for each subshell (as a safeguard).

3. Key points of worktree cleanup:
   - Get the branch held by that worktree via `git worktree list --porcelain` (don't rely on pattern matching)
   - Run `git worktree remove -f -f <path>` (the double `-f -f` force is required to release the Claude Code harness's `lock`)
   - Delete the obtained branch with `git branch -D <branch>`
4. If a synthetic branch in the form `worktree-agent-<id>` (originating from the Claude Code harness implementation) remains, delete it with `git branch -D worktree-agent-<id>`. In practice this is a required item, since in the Phase 20 (opshub) run it was left behind in 4 of 4 cases. If detection fails, leave it as a warning, but **always run `git branch --list 'worktree-agent-*'` at the end to confirm the remaining count is 0** (if any remain, output the count and branch names in the warning)

The warning format when there's a worktree left over for anything other than `merged`, or a worktree where cleanup itself failed:

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
