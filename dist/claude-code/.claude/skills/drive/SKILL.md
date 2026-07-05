---
description: Automatically cycles through implementation, PR creation, self-review, and fixes from an Issue or an instruction to produce a merge-ready PR. Supports single/multiple Issues/PRs and explicit dependency notation. Can optionally run through to merge. In orchestration, detects and self-resolves cross-cutting concerns before merge, leaving no follow-up within a single run.
argument-hint: <#N | #N,#N | #N-N | instruction> [--merge] [--concurrency N] [--review=quick|final-deep|deep] [--no-usage-guard]
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch, AskUserQuestion, Agent, Workflow
---

# drive

Read `~/.agents/skills/drive/SKILL.md` and follow its workflow steps.

**Important:** for each phase, Read the corresponding skill's SKILL.md and execute **only the workflow steps**. **Ignore entirely** the "next action suggestions" section and the "completion report" section within the SKILL.md you read. Transitions between phases are controlled by this skill.

## Claude Code-specific additions

### Input parsing

Parse `$ARGUMENTS` and identify the target list (Issue/PR/instruction), dependency notation, and options (`--merge`, `--concurrency N`, `--review=<mode>`, `--no-usage-guard`). Deterministic expansion, DAG/wave construction, and mode branching are delegated to `drive-plan.mjs` (`~/.claude/skills/drive/drive-plan.mjs`; for dogfooding, `<repo>/.claude/skills/drive/drive-plan.mjs`), the same as the canonical, and aggregate-report formatting is delegated to `drive-report.mjs`.

- 1 target with no dependency notation (`->`) → single mode
- 2 or more targets, or dependency notation present → orchestration mode

Handling of `--review`:

- Default is `quick`
- Single mode: accepts all of `quick` / `final-deep` / `deep`
- Orchestration mode: forces `--review=quick`; if `final-deep` / `deep` is specified, shows a warning and falls back to `quick` (cost management)

Handling of usage-guard:

- **Enabled by default (opt-out)**. A plain drive with no checkpoints inserted runs only when `--no-usage-guard` is explicitly added.
- If `--no-usage-guard` is not specified, the usage-guard engine is called at the checkpoints described later in "usage-guard wiring (default ON, disabled via `--no-usage-guard`)"; on Usage Limit overage, it waits until the budget recovers before re-entering itself.
- `--usage-guard` is accepted as a backward-compatible **deprecated no-op alias** (it doesn't need to be explicit since it's ON by default; behavior is identical to the default). It is never force-added to the continuation command.
- **The original argument list is saved** at parse time (used to assemble the continuation command `/drive <元の引数>` and the resume line in the failure-time report `再開: /drive <元の引数>` — canonical's Phase 5 / Phase Final-6, only when there's a leftover `failed` / `merge-ready` / `skipped` —). `--no-usage-guard` is included in what's saved, and carried over to the continuation command, only if the user specified it. `--usage-guard` is a no-op alias, so it's neither saved nor added.

### Autonomous execution

AskUserQuestion is not used at all — including for plan approval — up through the merge step (or merge confirmation) (fully autonomous execution).

### usage-guard wiring (default ON, disabled via `--no-usage-guard`)

**Enabled by default.** Pauses work before the Claude Code Usage Limit (5-hour = Current / weekly = Weekly) reaches 100%, and automatically resumes once the budget recovers. **Only when `--no-usage-guard` is specified does this section's processing not run at all, leaving drive's core behavior unchanged** (since pause/resume is Claude-specific, the wiring is confined to this overlay; precedent: `review --deep`). `--usage-guard` is accepted as a deprecated no-op alias, but since it's enabled by default, behavior doesn't change.

> **Claude-only**: the usage-guard engine depends on the OAuth usage-rate endpoint and `ScheduleWakeup`, so it only works on Claude Code (the `usage-guard` skill gated by `adapters: claude-code` = #121). The base SKILL.md is ON by default, but since this overlay isn't included in the build output for other adapters (codex/gemini/copilot), it effectively remains a no-op there.

#### Graceful degrade (skill absent)

Since it's ON by default, drive is **not stopped with an error** even in an environment where the usage-guard skill / `usage-check.mjs` **doesn't exist** (e.g., `~/.claude/skills/usage-guard/` not installed). At the start of each checkpoint, check for the existence of the `usage-guard` skill (`~/.claude/skills/usage-guard/SKILL.md`; in user-scope, `~/.claude/skills/usage-guard/SKILL.md`), and **if its absence is detected, emit a one-line warning** (e.g., "⚠️ usage-guard degraded: skill not installed, proceeding normally without monitoring") **and proceed normally as-is** (treated as fail-open — subsequent checkpoints are also skipped). This is a mandatory requirement of being ON by default: the guard's own absence must never hard-stop drive.

#### checkpoint trigger points

When `--no-usage-guard` is not specified (= default ON), usage-guard is called only at the following **entry points to a resumable unit**:

| Mode | checkpoint |
|---|---|
| Single mode | **before each target's Phase 1 (implement) begins** |
| Single mode | **before each review-loop iteration** (before each pass in Phase 3 begins) |
| Orchestration | **before each wave begins** (at the start of the wave loop in Phase 1..N) |
| Orchestration | **before each worker dispatch** (immediately before launching a worker within the same wave) |

**Checkpoints are always placed at boundaries where re-entry can happen cleanly.** It **does not pause** mid-implement (partway through implementation, before a PR exists), partway through a review pass, or partway through a commit/push — pausing there risks losing track of progress on re-entry. Since drive has idempotent resume (detecting an existing PR and resuming from Phase 3), any of the boundaries above can safely resume from where they left off on re-run.

#### Steps at a checkpoint

At each checkpoint, run the following:

1. Read the `usage-guard` engine (`~/.claude/skills/usage-guard/SKILL.md`; in user-scope, `~/.claude/skills/usage-guard/SKILL.md`) and run its "lightweight wait-loop" (= run `usage-check.mjs` in the same directory via Bash to get JSON).
   - **At the wave / worker-dispatch checkpoint (orchestration), gate headroom-aware (#141)**: wave dispatch definitively launches **N uninterruptible workers**, and they consume budget while running. Judging by the current value alone can't account for the projected consumption of a whole wave, and the threshold can be overshot mid-wave (observed in practice: `five_hour` 86% → 98% after 1 wave, with 3-worker concurrency). To prevent this, the dispatch checkpoint passes `usage-check.mjs --headroom <pct>` and gates on the **projected post-dispatch value** (`util + reserve(N) >= threshold`). `reserve(N)` is a reservation proportional to the concurrency level `N` (`--concurrency`, default `min(4, tasks in wave)`). **A rough guideline is `reserve = N × per_worker_pct`** (`per_worker_pct` is the projected consumption per heavy worker; take the observed `86→98 / 3-worker ≈ 4pt/worker` as the initial value, overridable via the `USAGE_GUARD_DISPATCH_HEADROOM` env var). Example: `concurrency=3`, `per_worker≈4pt` → `--headroom 12` → pause before dispatch if `threshold(95) − 12 = 83%` is exceeded. The larger `--concurrency` is, the larger the reserve grows.
   - **The single-mode Phase 1 / review-loop checkpoint doesn't pass headroom** (= default 0, gating on the current value, as before). Since the consumption of 1 unit can be absorbed at an interruptible boundary, no reserve is needed.
2. `ok: true` (both budgets are below threshold; at the dispatch checkpoint, `util + reserve` is below threshold) → **proceed normally**. Move straight on to the next phase / wave / worker dispatch.
3. `ok: false` (either budget exceeds the threshold) → defer to usage-guard's wait-loop. A post-reset buffer (`resume_buffer_seconds`, default +300 seconds) is folded into `wait_seconds`, and the wait extends to `resets_at + buffer` (avoiding a re-bounce from re-entering right at the reset boundary):
   - In-session, wait ≤1h → set up a heartbeat with `ScheduleWakeup(min(wait_seconds, 3600))` and **wait** (no re-entry and no budget consumption while waiting). If `wait_seconds` exceeds 3600, re-check in multiple installments.
   - Non-`/loop` orchestration (Agent tool / Workflow drive), wait >1h, needing restart resilience → set a `CronCreate` (`recurring: false`, durable) to **`resets_at + resume_buffer_seconds`**, and re-submit the continuation command when it fires (a single wall-clock shot, restart-resilient; the one-shot auto-deletes after firing). Since this being ON by default makes this path (>1h, non-`/loop`) easy to hit, prefer **`CronCreate` (one-shot, durable)** over `ScheduleWakeup` in that case. See usage-guard SKILL.md §Lightweight wait-loop, "Choosing the resume trigger", for details.
   - **When a reflection lag is suspected (`suspected_reflection_lag: true`), don't set a long-duration CronCreate at the boundary — instead re-check with `ScheduleWakeup` at a short interval (`wait_seconds` ≈ 180 seconds)** (this catches a false 100% caused by the residual image of the prior window right after the boundary, once recovery is confirmed, avoiding a false negative from a ~5h stall; see usage-guard SKILL.md §Behavior: reflection-lag detection).
   - On waking, self-re-enter via the continuation command **`/drive <元の引数>`** (since it's ON by default, `--usage-guard` is never force-added; `--no-usage-guard` is carried over only if the user specified it — though since this section doesn't run at all when `--no-usage-guard` is set, the actual continuation command can simply pass the original arguments as-is). drive's idempotent resume detects the existing PR / branch / completed workers and **resumes from where it left off** (no duplicate side effects, even across a wait).
   - Repeat steps 3–4 until `usage-check.mjs` returns `ok: true`.

> Pass the **original argument list** as-is to the continuation command (since it's ON by default, adding `--usage-guard` is unnecessary — the guard keeps taking effect by default after resume too).

#### Granularity and duplication (two-layer defense against in-wave overshoot, #141)

Orchestration pauses at the granularity of **wave boundaries / worker-dispatch boundaries**. There's a structural failure mode here:

- **Failure mode (in-wave overshoot)**: even if the boundary checkpoint dispatches with `ok:true`, the N launched workers **consume budget while running**. Since the boundary checkpoint has no effect while things are running, the threshold can be crossed and 100% reached mid-wave. `ok:false` is only **detected after the fact** at the next boundary, and can't prevent overshoot within that wave (observed in practice: 86% pre-dispatch, threshold 95 → 3-worker concurrency → 98% while running). **Lowering the threshold is a stopgap that can't account for concurrency and is not a substitute.**

This is closed off with a **two-layer defense**:

1. **A resumable pause at the boundary (headroom-aware, preventive)**: at the wave / worker-dispatch checkpoint, pass `usage-check.mjs --headroom <pct>` (with `reserve(N)` computed from `--concurrency`) and gate on the **projected post-dispatch value**, stopping the dispatch itself preemptively (step 1 of "Steps at a checkpoint" above). On a headroom trip, the wait is until the budget edge + buffer (headroom recovers when the budget resets).
2. **The mid-unit ceiling (#123 PreToolUse hook, a reliable ceiling)**: a mid-unit overage in an already-launched, running worker can't be stopped at a boundary. The #123 hook — which **takes effect before every tool call and also reaches inside subagents** — is the only reliable ceiling. In environments running `/drive`'s wave parallelism, it's **recommended to wire up the `matcher:"*"` hook by default** (#141). Previously, due to the risk of the **pre-#139** hook hard-stopping on a transient outlier, it remained only a "recommended addition," but since **#139 (file kill-switch / reflection-lag ALLOW / debounce / spike rejection) resolved the hard-stop risk**, wiring it by default has become safe. In the unlikely case of a false deny, it can be released immediately with **`touch ~/.claude/usage-guard/DISABLE`** (usage-guard SKILL.md §Disabling). See usage-guard SKILL.md §Enabling the PreToolUse hook for wiring steps.

> The boundary pause (headroom-aware) and the mid-unit hook are **each insufficient on their own**. headroom is the "stop dispatch preemptively" prevention; the hook is the "reliable ceiling during execution." Only when both are in place is overshoot practically closed off.

- The prompt itself passed to the worker (subagent) can remain unchanged. Since the worker runs single mode, **the parent inserting a headroom-aware checkpoint before worker dispatch (ON by default)** is what provides wave-granularity budget handling.

#### fail-open (surfacing degradation)

If usage-check's signal acquisition fails completely (both the endpoint → JSONL fallback fail), usage-guard returns `ok: true` (fail-open). drive proceeds normally as-is — **a bug in the guard itself must never hard-stop drive**.

However, fail-open means the **guard is effectively OFF**. When the `source` of the JSON obtained at a checkpoint is anything other than `endpoint` / `cache` (especially `fail-open`), the drive caller **leaves the degradation explicitly in the report** (e.g., "⚠️ usage-guard degraded: source=fail-open, not actually monitoring"). See usage-guard SKILL.md §Environment requirements for the causes of the endpoint path being unusable (api.anthropic.com egress / permission to read `~/.claude/.credentials.json`) and how to recover. The PreToolUse hook on a running worker likewise emits a degradation warning to stderr.

### Choosing the orchestration execution mechanism

For orchestration worker parallel execution, **the Workflow method is canonical (default)**. It rides natively on the harness via Claude Code's Dynamic Workflows (a deterministic script + journal resume + parallel `agent()` launches), delegating wave execution, worker distribution, progress observation, and interrupt/resume to the runtime ([ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R2). It falls back to the conventional Agent tool method (the "subagent dispatch" section) **only in environments where the Workflow tool is unavailable** (Dynamic Workflows disabled — `disableWorkflows` — / an older version).

| | Workflow method (canonical) | Agent tool method (fallback) |
|---|---|---|
| Concurrency control | runtime manages the cap (max 16) and queueing | manual semaphore |
| worktree isolation | `agent({ isolation: 'worktree' })` | `Agent({ isolation: "worktree" })` |
| Return-value validation | structured validation via `schema` (mismatches auto-retry) | parent parses free-form JSON |
| Progress monitoring | `/workflows` UI + `log()` | `gh pr list` 30-second polling |
| Interrupt/resume | journal resume (`resumeFromRunId`; completed workers restored from cache) | manual re-run (PR detection via drive's idempotent resume) |

### Orchestration via the Workflow method (canonical)

Phase 0 (DAG / wave construction) and the plan display are done **on the conversation side, before launching the Workflow** (since a workflow can't accept mid-run user input, all approval-related steps are placed before/after launch). Pass the wave configuration via `args` and assemble a script of the following form:

```js
export const meta = {
  name: 'drive-orchestration',
  description: 'drive: wave 単位で worker を並列実行し merge-ready PR 群を作る',
  // pure literal（args を参照できない）。起動時に drive-plan.mjs の wave 数へ合わせて書く
  phases: [{ title: 'Wave 1' }, { title: 'Wave 2' }],
}

// worker 戻り値 contract。canonical（~/.agents/skills/drive/SKILL.md）の戻り値 JSON を Schema 化した
// もので、フィールドは canonical と 1:1。runtime が schema 不一致を検出して自動リトライする。
// status は worker では最大 merge-ready（self-merge しないため merged は現れない）。
const WORKER_SCHEMA = {
  type: 'object',
  required: ['target', 'status', 'final_head_state'],
  properties: {
    target: { type: 'string' },                    // "#N"
    title: { type: 'string' },
    branch: { type: 'string' },
    pr_url: { type: 'string' },
    pr_number: { type: 'number' },
    status: { enum: ['merge-ready', 'failed'] },    // worker は self-merge しない
    review: { type: 'object' },                     // { mode, axes_applied, by_axis, total, iterations }
    cross_cutting_gaps: { type: 'array', items: { type: 'string' } },
    final_head_state: { type: 'object' },           // { symbolic_ref, rev_parse_HEAD, status_short }
    error: { type: 'string' },
  },
}

// worker prompt。Agent tool 方式「subagent dispatch」節の制約と同一(runtime の worktree 隔離は
// cleanup を肩代わりするが worker の git 操作自体は防がないため制約は省略不可)。
const workerPrompt = (target) => [
  `~/.agents/skills/drive/SKILL.md を Read し、target ${target} について単一モード Phase 1-3 を実行せよ。`,
  '- Phase 4（マージ）は実行しない。merge-ready で停止し gh pr merge を一切呼ばない（self-merge 禁止）。',
  '- main / 親 ref への書き込み禁止: git checkout main / switch main / symbolic-ref HEAD refs/heads/main /',
  '  update-ref refs/heads/main / reset --hard origin/main（main を指す状態で）/ branch -m / push origin main。',
  '- Edit/Write の file_path は自 worktree path（.claude/worktrees/agent-<id>/）配下の絶対パス限定。まず pwd で確認。',
  '- 依存元 wave がある target は依存元 PR の headRefName をベースに stacked PR を作る。',
  '- 戻り値は WORKER_SCHEMA の JSON（status は最大 merge-ready、final_head_state / cross_cutting_gaps 含む）。',
].join('\n')

// args は drive-plan.mjs --json の出力そのもの（会話側で Phase 0 に実行して渡す）:
//   { waves: string[][], deps: { "#N": string[] }, concurrency, review, options: { merge }, ... }
// waves は target 文字列の二次元配列、deps は target → 依存 target[] の map（canonical と同形）。
const results = []
const failed = new Set()

for (const [i, wave] of args.waves.entries()) {
  // 依存元が failed の target は dispatch せず skipped（canonical の失敗 semantics）。deps は
  // drive-plan.mjs の deps map をそのまま参照する（wave 要素に依存情報を再掲しない）。
  const runnable = wave.filter((t) => !(args.deps[t] ?? []).some((d) => failed.has(d)))
  for (const t of wave) {
    if (runnable.includes(t)) continue
    const upstream = (args.deps[t] ?? []).filter((d) => failed.has(d))
    results.push({ target: t, status: 'skipped', error: `upstream failed: ${upstream.join(',')}` })
    log(`${t} skipped (upstream failed: ${upstream.join(',')})`)
  }

  // 同一 wave 内の独立 worker は parallel() で並列（バリア = wave 完了）。wave 列の for-await が
  // 依存バリア。pipeline() は stage 間バリアがないため依存 wave には使わない（意図的に parallel）。
  // runtime が concurrent cap（最大 16）を管理。--concurrency がそれより小さければ、会話側で
  // runnable を args.concurrency 件ずつのスライスに整形して直列に流す。
  const waveResults = await parallel(
    runnable.map((t) => () =>
      agent(workerPrompt(t), {
        label: t,
        phase: `Wave ${i + 1}`,
        isolation: 'worktree',
        schema: WORKER_SCHEMA,
      }),
    ),
  )

  for (const r of waveResults) {
    if (!r) continue
    results.push(r)
    if (r.status === 'failed') failed.add(r.target)
    log(`${r.target} → ${r.pr_url ?? '-'} (${r.status})`)
  }
}
return { results }
```

The `workerPrompt(target)` in the script must always include the following (the skeleton is already embedded in the script above; identical constraints to the Agent tool method's "subagent dispatch". The runtime's worktree isolation takes care of cleanup, but doesn't prevent the worker's git operations themselves, so the prompt constraints can't be omitted):

- Instructions to Read the canonical SKILL.md and run single-mode Phase 1-3 (**do not run Phase 4 merge; stop at `merge-ready`**)
- A list of commands prohibited for writing to main / the parent-side ref
- The Edit / Write tool's `file_path` constraint (limited to its own worktree path)
- Merge prohibition (never call `gh pr merge`)
- Base-branch rule (a target with an upstream wave dependency is stacked on headRefName; since it doesn't self-merge, it's stacked regardless of `--merge`)
- The return-value JSON contract (`status` capped at `merge-ready` / includes `final_head_state` / `cross_cutting_gaps`; matches the `WORKER_SCHEMA` above)

Notes specific to the Workflow method:

- **`Date.now()` / `Math.random()` / argument-less `new Date()` cannot be used within the script** (the runtime throws, for resume determinism). If a timestamp is needed, pass it via `args`
- **Observability is handled by the `/workflows` UI and `log()`** (`p` to pause / `x` to stop / per-agent token monitoring). The Agent tool method's `gh pr list` 30-second polling is **unnecessary** (the Workflow method doesn't poll for PR detection)
- The `await` between waves is an **intentional barrier** from the dependency relationship (don't turn it into a pipeline)
- Workers within the workflow are fixed to `acceptEdits` and inherit the session's allowlist. To avoid permission prompts during a long-running run, confirm before launch that the necessary commands are on the allowlist
- **Interrupt/resume is the Workflow's journal resume**: re-entering via `Workflow({scriptPath, resumeFromRunId})` restores unchanged `agent()` calls (completed workers) from the journal/cache and continues from the incomplete wave. This is the primary mechanism replacing the conventional "detect a PR via 30-second `gh pr list` polling and re-run manually." drive's idempotent resume (detecting an existing PR) remains as a secondary safety net (it also takes effect inside workers)
- **Phase Final-1 through Final-6 are run on the conversation side after the workflow ends.** Since a worker's worktree contains changes, it's not subject to the runtime's automatic deletion; Final-2 audit / Final-3 reconciliation are performed within this surviving worktree, and cleanup (the Final-5 section) is done last. The worktree path convention (`.claude/worktrees/agent-<id>/`) is the same
- **The folding for Final-3 reconciliation is also done on the conversation side after the workflow returns** (group the gaps by `source_pr`, and fold them in parallel per PR with `parallel()`; within the same PR it's sequential). Alternatively, a separate small workflow dedicated to reconciliation may be launched
- The Final-4 merge (parent-centralized, dependency-order merge when `--merge` is specified) and the bulk-merge confirmation when `--merge` is not specified (the AskUserQuestion in the "After completion" section) are performed after the workflow returns
- **The wave checkpoint is inserted on the conversation side** (default ON; omitted when `--no-usage-guard` is specified). Since the workflow script runs deterministically and can't call either Read on the SKILL.md or `ScheduleWakeup`, launch the workflow per wave, and **before** each wave's launch, run the "usage-guard wiring" section's checkpoint on the conversation side **headroom-aware** (deriving `--headroom` from `--concurrency`; #141) (if `ok`, launch the next wave's workflow; if over, wait → re-enter via `/drive <元の引数>`, restoring completed workers from cache via `resumeFromRunId` and continuing). While the workflow is running (a mid-unit overage in an already-dispatched worker), the #123 PreToolUse hook serves as the ceiling (§Granularity and duplication)

### subagent dispatch (orchestration mode, Agent tool method fallback)

In orchestration mode, each target is run in parallel with the `Agent` tool:

- **isolation:** `"worktree"` (mandatory)
- **subagent_type:** `general-purpose`
- **prompt:** since a subagent can't call a slash command, have it Read `~/.agents/skills/drive/SKILL.md` and instruct it to run the single-mode workflow (Phase 1-3) for target #N. **The worker does not run Phase 4 (merge)** — after review passes, it stops at `merge-ready` and returns JSON without ever calling `gh pr merge` (the same even when `--merge` is specified; the parent centrally manages the merge in Phase Final-4). Have it return the final result as JSON
- **Prohibition on writing to main / the parent-side ref (must be stated explicitly in the prompt):** the subagent is self-contained within its own worktree branch. The following commands are all **prohibited** — they pollute the parent worktree's `HEAD` / `index` / `refs/heads/main` via the shared git directory ([Issue #66](https://github.com/ozzy-labs/skills/issues/66) / [Issue #89](https://github.com/ozzy-labs/skills/issues/89)). Since the worktree is deleted on the parent side, there's no need to switch back to main:
  - `git checkout main` / `git switch main` / `git checkout HEAD~` (moving HEAD)
  - `git symbolic-ref HEAD refs/heads/main` (symbolically switching HEAD to main)
  - `git update-ref refs/heads/main <sha>` (directly rewriting the main ref)
  - `git reset --hard origin/main` (if run while its own branch points to main, this propagates indirectly to the parent)
  - `git branch -m <new-name>` (breaks the worktree-branch binding)
  - `git push origin main` / `git push origin HEAD:main`
- **Require `final_head_state` in the return-value JSON (must be stated explicitly in the prompt):** on completion, the subagent must include the output of its own worktree's `git symbolic-ref HEAD` / `git rev-parse HEAD` / `git status --short` in the `final_head_state` field of the return-value JSON. If `symbolic_ref` is `refs/heads/main` or empty (detached), the parent-side Phase Final-1 raises a warning. This is a countermeasure against the observed discrepancy between the self-reported "no main checkout" and reality ([Issue #89](https://github.com/ozzy-labs/skills/issues/89)), making the self-attestation verifiable
- **The Edit / Write tool's `file_path` constraint (must be stated explicitly in the prompt):** the `file_path` passed to a subagent's Edit / Write tool must always be limited to an absolute path starting with its own worktree path (`.claude/worktrees/agent-<id>/`). A parent worktree path (a path directly under the repo root that doesn't include `.claude/worktrees/`) must never be passed. The pollution observed in Phase 20 (opshub) occurred **via the absolute path argument of Edit/Write, not via `cd`**, which is why this constraint is decisive. It's safe to check its own worktree path with `pwd` before execution and then pass it to the tool ([Issue #77](https://github.com/ozzy-labs/skills/issues/77))
- **Merge prohibition (must be stated explicitly in the prompt):** the subagent never calls `gh pr merge` at all (neither `--auto` nor `--delete-branch`). If it were to self-merge, it would already be merged, cross-cutting couldn't be folded in, and follow-up would remain. In addition, `--delete-branch` fails to delete a branch held by its own worktree (`fatal: '<branch>' is already used by worktree at ...`). All merging and cleanup of local branches / worktrees is handled on the parent side in Phase Final (Final-4 merge / Final-5 cleanup) ([Issue #69](https://github.com/ozzy-labs/skills/issues/69) / [#166](https://github.com/ozzy-labs/skills/issues/166))
- **Out-of-scope impact check (must be stated explicitly in the prompt):** if the subagent adds an enum / field / CLI flag, it greps the whole repo for the corresponding help strings / error messages / samples/docs and checks whether they're in sync. If not in sync, it includes the fix in its own PR if feasible. If it clearly exceeds its own scope, it records it in the return-value JSON's `cross_cutting_gaps: string[]` field in the form `<file>:<line> — <symbol> not synced`, to be aggregated into the parent's Phase Final-2 audit ([Issue #70](https://github.com/ozzy-labs/skills/issues/70))
- **The base branch when there's an upstream wave dependency:** since the worker doesn't self-merge, the upstream also remains unmerged during the run. So regardless of `--merge`, **it creates a stacked PR based on the upstream PR's headRefName** (the parent reassigns the downstream's base to main when merging in dependency order in Phase Final-4)
- **Parallel launch:** independent subagents within the same wave are launched in parallel via **multiple tool calls in a single message**
- **Concurrency:** `min(4, tasks in wave)`, overridable with `--concurrency N`; exceeding 8 only warns
- **When the number of tasks in a wave exceeds the concurrency level:** wait for a free slot via a semaphore approach (wait for a previously launched subagent to complete before launching the next)

### Observability and interrupt/resume

When Phase 0 completes (before launching the Workflow, on the conversation side), display the wave configuration and target list. Output the aggregate report in Phase Final. The mechanisms for progress observation and interrupt/resume differ by method:

**Workflow method (canonical):**

- Progress is handled by each worker's single-line `log()` output and the `/workflows` UI (`p` to pause / `x` to stop / per-agent token monitoring). **No `gh pr list` polling is done**
- Interrupt/resume is the **Workflow's journal resume**: re-entering via `Workflow({scriptPath, resumeFromRunId})` restores completed workers (unchanged `agent()` calls) from the journal/cache and continues from the incomplete wave. This replaces the conventional "poll `gh pr list` every 30 seconds from the wave-launch time and resume via PR detection"
- State finalization has the worker return-value JSON (`schema`-validated) as the SSOT

**Agent tool method (fallback):**

- Since the `Agent` tool returns only the final result, streaming intermediate reports aren't possible. The parent records the wave-launch time `<T>` in ISO 8601 and polls `gh pr list --author @me --state open --search "created:>=<T>" --json number,url,headRefName,title` at 30-second intervals. It detects new PRs from the diff against known PRs and displays the URL immediately
- Interrupt/resume is manual re-run (drive's idempotent resume detects the existing PR / branch and continues from Phase 3)

### Phase Final-1: parent worktree consistency check

A fail-safe for the case where a subagent pollutes the parent's `HEAD` / `index` / `refs/heads/main` via the shared git directory (originating from [Issue #66](https://github.com/ozzy-labs/skills/issues/66) / [Issue #77](https://github.com/ozzy-labs/skills/issues/77) / [Issue #89](https://github.com/ozzy-labs/skills/issues/89)). **For the execution details of the 7 detection axes (+ cross-checking the return value's `final_head_state`) and the recovery sequence, see the "7 contamination-detection axes" and "Recovery sequence" sections of [`worktree-safety.claude-code.md`](worktree-safety.claude-code.md).** If any of them don't match, output a warning + recovery steps at the end of the aggregate report.

### Phase Final-2: cross-cutting audit (pre-merge, parallel within worker worktrees)

Follows the detection content of the canonical's (`~/.agents/skills/drive/SKILL.md`) Phase Final-2 (worker-report aggregation / enum-flag sync / stale wording / lockfile drift / docs-code). Claude Code-specific execution:

- Run grep within each worker's worktree (`.claude/worktrees/agent-<id>/`, which persists until Final-5). Fetch the PR-specific diff with `gh pr diff <N>` and `rg` the extracted symbols within that worktree
- Run **in parallel per PR** (with the Agent tool method, multiple tool calls in a single message; with the Workflow method, `parallel()` on the conversation side after return). Attribute each gap to `source_pr` and pass it to Final-3

### Phase Final-3: reconciliation (folding into the originating PR, parallel per PR)

Following the canonical's Phase Final-3, group the gaps by `source_pr` and fix/push in the originating PR's worktree. Claude Code-specific execution:

- In the worker worktree (`.claude/worktrees/agent-<id>/`) corresponding to each gap's `source_pr`, Edit the target file (`file_path` limited to its own worktree path) → lint → commit (`fix(sync): ...`) → `git push`
- **Parallel per PR** (no collision, since each uses a separate worktree; multiple tool calls for the Agent tool method, `parallel(gaps.groupBy(pr))` for the Workflow method). **Multiple gaps within the same PR are sequential** (they share the same worktree)
- No full review loop is run (lint pass only). A gap where folding conflicts / that spans multiple PRs falls back to a dedicated reconciliation PR, which is merged at the tail of Phase Final-4 with main as the base after all content PRs have merged (see canonical Final-3). A folding failure is left as a warning via fail-soft

### Phase Final-4: dependency-order merge (centralized by the parent)

Following the canonical's Phase Final-4, the parent merges in topological order when `--merge` is specified. Claude Code-specific notes:

- **`POLICY_GUARD_PROCEED=merge gh pr merge --squash` does not add `--delete-branch`** (since the worker worktree still holds that branch and remains, deleting the local branch would fail due to the worktree lock. Deletion of the branch / worktree is consolidated into Final-5 cleanup). `POLICY_GUARD_PROCEED=merge` conveys `--merge`'s proceed override to the PreToolUse `policy-hook.mjs` (wired via `hooks add policy`), avoiding a deny stemming from gate=`ask` (canonical's "Merge and the autonomy policy" / [#195](https://github.com/ozzy-labs/skills/issues/195))
- If a phantom conflict appears after reassigning the downstream PR's base (`gh pr edit <下流> --base main`), run `git rebase origin/main` → `git push --force-with-lease` within the downstream's worktree (limited to its own worktree branch; the parent ref is left untouched) before merging the next one
- The parent worktree's HEAD / main ref is not touched. Since the merge goes through the `gh` API (a remote operation), the parent's local git state proceeds unchanged

### Phase Final-5: subagent worktree cleanup

Runs after Final-4's merge. The per-status cleanup policy (`merged` is deleted / `merge-ready` and `failed` are left in place) follows the canonical's Phase Final-5. **For the Claude Code worktree-mechanism-specific execution steps (avoiding cwd loss via a subshell, releasing the `-f -f` lock, checking for leftover `worktree-agent-*` synthetic branches), see the "Cleanup execution steps" section of [`worktree-safety.claude-code.md`](worktree-safety.claude-code.md)** (originating from [Issue #69](https://github.com/ozzy-labs/skills/issues/69) / [Issue #90](https://github.com/ozzy-labs/skills/issues/90)). If anything other than `merged` is left over, or cleanup itself fails, output a list of leftovers and manual cleanup steps as a warning at the end of the aggregate report.

### On interruption

If interrupted at any phase, confirm the next action with AskUserQuestion:

- **"Fix the error and resume"** → resume from the interrupted phase
- **"Abort"** → end

In orchestration mode, if only some tasks fail, after outputting the Phase Final report, confirm the resume targets with AskUserQuestion.

### After completion

#### Single mode

1. **When `--merge` is specified:** run the merge following the Phase 4 procedure, report the result, and end
2. **When `--merge` is not specified:** call AskUserQuestion (don't set the `answers` parameter)
   - **"Merge the PR"** → run the merge with `POLICY_GUARD_PROCEED=merge gh pr merge --squash --delete-branch` and report the result (since AskUserQuestion's explicit approval satisfies the `ask` gate, `POLICY_GUARD_PROCEED=merge` is prefixed so it passes through the PreToolUse `policy-hook.mjs`; see the canonical's "Merge and the autonomy policy")
   - **"Make additional changes"** → end

#### Orchestration mode

Phase Final runs Final-1 (consistency) → Final-2 (audit) → Final-3 (reconciliation), regardless of whether `--merge` is present (to finalize the PRs gap-free). The only branch point is the Final-4 merge:

1. **When `--merge` is specified:** the parent merges in dependency order in Phase Final-4, followed by Final-5 cleanup (cleaning up merged workers) → outputting the Final-6 aggregate report, and ending
2. **When `--merge` is not specified:** after completing through Final-3, call AskUserQuestion (don't set the `answers` parameter)
   - **"Merge all PRs in bulk"** → run Phase Final-4's dependency-order merge, followed by Final-5 cleanup → output the Final-6 report
   - **"Handle individually"** → output the Final-6 report and end. `merge-ready` worktrees remain left in place. The user cleans them up after merging, either via `/health` area #7 or manually
