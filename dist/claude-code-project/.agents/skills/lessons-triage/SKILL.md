---
name: lessons-triage
description: Consumes the session lessons queue (~/.agents/lessons/queue.jsonl), extracts lessons about User Skills from the transcript, and files only the approved ones as issues to ozzy-labs/skills. Fires on "organize the lessons," "consume the lessons," "session retrospective."
---

# lessons-triage - HITL triage of session lessons

Consumes the session meta-information accumulated in `~/.agents/lessons/queue.jsonl` by the capture hook (dotfiles' `lesson-capture.sh`) at session end, extracts from the transcript **only lessons about improving User Skills**, and files the user-approved lessons as issues in ozzy-labs/skills.

## Premises and principles

- **v1's scope is limited to improving User Skills.** General lessons (user preferences, coding conventions, etc.) are out of scope
- **No auto-apply path.** Filing issues follows the central autonomy policy's `externally-visible` gate (zero-config default `batch-confirm`), and only lessons approved via the batch confirmation are filed
- **A metrics-primed reflection channel.** `skill-metrics`'s rollup (the per-skill invocation counts + notable events output by `/skill-metrics --snapshot`) can be received as the **prioritization starting point** for triage. The `[lessons]` issue filed is not "a vehicle carrying a fix" but a **backlog pointer (a priority index of where to look)** — the rollup is attached as quantitative grounding, but **diagnosis and fixing happen locally, where the transcript is**, producing a fix-PR (the issue itself does not carry the fix; [#162](https://github.com/ozzy-labs/skills/issues/162))
- **Reflection (sending) is always explicit opt-in / HITL.** Local rollup aggregation and prioritization can be automatic, but filing an issue (external reflection) happens only for what's approved via the policy gate below. **Rollup citations must also not include verbatim transcripts, payloads, secrets, or raw repo names/cwd/PR values** (the `skill-metrics` rollup is already metadata-only, thanks to `event.schema.json`'s `additionalProperties: false`)
- **Never pass transcript content to an external CLI / external service.** Delegation to things like gemini-delegate is prohibited (the transcript may contain private repo content or secrets from terminal output)
- **No external reflection other than filing issues.** Editing the repo, creating PRs, and writing to memory are out of scope for this skill
- Writes to queue / processed are **append-only**. The queue itself is never rewritten (to avoid conflicting with the capture hook)

## Action classification and policy reference

This skill does not hardcode individual approval gates in prose, but follows the central autonomy policy (the SSOT for the 3 classes and gate vocabulary defined by the `policy` skill). It classifies its sole external-reflection action as follows:

| This skill's action | Class | Policy reference | Zero-config default gate |
| --- | --- | --- | --- |
| Filing an issue (`gh issue create`) | `externally-visible` | `--action=issue-create` | `batch-confirm` (list all lessons and make one batch selection) |

The effective gate is looked up via the sibling `policy` skill's `policy-read.mjs` (in Claude Code user-scope: `~/.claude/skills/policy/policy-read.mjs`; dogfood: `<repo>/.claude/skills/policy/policy-read.mjs`; Codex/Gemini: `.agents/skills/policy/policy-read.mjs`):

```bash
node <policy skill's directory>/policy-read.mjs --action=issue-create --repo-root="$PWD"
# => .resolved.gate (default batch-confirm)
```

- `batch-confirm` (default): present all extracted lessons in a single list and select as a batch which ones to file (one batch confirmation)
- `ask`: obtain explicit approval for each individual lesson (fallback if tightened by policy)
- `proceed`: file without approval (only if the policy explicitly opts in to automatic filing)

**Doesn't break even without a policy present:** `policy-read.mjs` is fail-safe by design — anything it can't read or an invalid value falls back to the stricter side (`ask`). In an environment where the `policy` skill itself isn't installed, the zero-config default gate above (`externally-visible`=`batch-confirm`) applies directly. In either case, it never becomes auto-apply (filing without confirmation).

## Input

| File | Role |
| --- | --- |
| `~/.agents/lessons/queue.jsonl` | Output of the capture hook. 1 line = 1 session-end event (`queued_at` / `cli` / `session_id` / `cwd` / `transcript_path` / `reason`) |
| `~/.agents/lessons/processed.jsonl` | This skill's record of what's been processed. 1 line = 1 session (`processed_at` / `session_id` / `cli` / `outcome`) |
| Rollup from `/skill-metrics --snapshot` (optional) | JSON aggregated by `skill-metrics` from events captured by `skill-observability` (`window` / per-skill `invocations` / `outcomes` / `signals` / `notable`). The **prioritization starting point** for triage (metrics-primed). Already cleansed to metadata only, containing no verbatim logs, payloads, or raw repo names/cwd/PR values |

Argument: `--limit N` specifies the maximum number of sessions to process per run (default 10, oldest first = FIFO, to consume transcripts before they expire).

## Steps

### 1. Identify unprocessed sessions

1. If `~/.agents/lessons/queue.jsonl` doesn't exist or is empty, report "queue is empty" and stop
2. Exclude `session_id`s already recorded in `processed.jsonl` from the set of `session_id`s in the queue
3. Consolidate duplicate rows for the same `session_id` (which can occur from resume round-trips, etc.) into the most recent row
4. Process up to `--limit` items, oldest first

### 2. Prefilter (batch-handling discard candidates)

Sessions matching the following skip lesson extraction and are presented together to the user as discard candidates. Record them in `processed.jsonl` after confirmation:

- The `transcript_path` file doesn't exist (expired) → `outcome: transcript-missing`
- The transcript has no trace of any skill invocation (no execution record found for an installed skill) → `outcome: no-skill-usage`
- A session in which lessons-triage itself was run → `outcome: self`

### 3. Lesson extraction

#### 3.0 Metrics-primed prioritization (optional, recommended)

In an environment where the observability layer (`skill-observability` captures → `skill-metrics` aggregates) is in place, use the `skill-metrics` rollup to **order** the close reading of transcripts (metrics-primed). First, obtain the rollup:

```bash
node <skill-metrics's directory>/skill-metrics.mjs --snapshot
# => window / skills[].invocations / outcomes / signals / notable
```

Prioritize close reading for the rollup's **notable items (fallback / HITL rejection / loop cap reached / abort)** and **skills with high abort/fallback counts**. In keeping with count-based reasoning (no rates when n is small), use the rollup as an index of "which skill to look at, in what order," not as a determination of cause (diagnosis happens in the transcript). Even if the rollup is empty, unaccumulated, or fails to fetch, triage proceeds as normal, reading all sessions oldest-first (fail-open).

Read the transcript of each remaining session, and extract events matching the following:

1. **Skill misfire / non-fire**: an unintended skill fired, or a skill that should have fired in a given situation didn't
2. **Ambiguity or error in a procedure**: following a skill's procedure as written led to a user correction or rollback
3. **Friction during execution**: repeated errors, retries, or workarounds during skill execution
4. **New skill / feature candidate**: repetitive manual work not covered by an existing skill

If the transcript is large, prioritize reading the skill-execution sections (no need for a verbatim full read). Organize each lesson as follows:

- **Target skill**: skill name ("new" for a new-candidate case)
- **Event**: what happened
- **Grounds**: a summary of the relevant part of the transcript (minimal verbatim quoting)
- **Proposed improvement**: what to change, where, in the SKILL.md / adapter wrapper

### 4. HITL approval and issue filing

Get **batch confirmation on the extracted lessons per the policy's `externally-visible` gate** (filing an issue = an externally-visible action; see "Action classification and policy reference"). With gate=`batch-confirm` (zero-config default), present all lessons in a single list and have the user select (multiSelect) as a batch which lessons to file. Only fall back to per-lesson approval if gate=`ask` (tightened by policy). Auto-apply (batch filing without confirmation) is never performed.

Only the lessons approved via batch confirmation are filed as issues, in this format:

```bash
gh issue create --repo ozzy-labs/skills --title "[lessons] <skill>: <summary>" --body "<body>"
```

Body template (a **backlog-pointer** format — focused strictly on "where to look," carrying no fix or diagnostic detail):

```markdown
## Lesson (backlog pointer)

<Description of the event. Focus strictly on which skill and where to look>

## Quantitative baseline (if metrics-primed)

- Target skill: <skill> — <N> invocations / notable <fallback|hitl.rejected|loop.hit_cap|aborted> <M> occurrences
- window: <since> to <until> (rollup is metadata only — no verbatim logs / payloads / raw paths)

## Grounds

- Session: <cli> / <queued_at>
- <Summary of the relevant part (no verbatim quoting)>

## Next action (to be carried out locally)

<Diagnose locally, where the transcript is, and produce a fix-PR. This issue does not carry the fix — it functions as a priority index>

---
Filed by lessons-triage (session: <session_id>)
```

**Do not include verbatim transcript quotes or sensitive information (tokens, internal paths, private repo content, etc.) in the issue body.** Even when citing the rollup, include **metadata only (counts, window)** — no verbatim logs, payloads, secrets, or raw repo names/cwd/PR values. Record only summaries.

### 5. Recording as processed

Append the `session_id` of each session whose lesson extraction is complete to `processed.jsonl`:

```json
{"processed_at": "<ISO 8601>", "session_id": "<id>", "cli": "<cli>", "outcome": "issues-created:<N>" }
```

`outcome` is one of `issues-created:<N>` / `no-findings` / `discarded` / `transcript-missing` / `no-skill-usage` / `self`.

### 6. Completion report

```text
lessons-triage complete:
  Sessions processed: N (discarded by prefilter: M)
  Lessons extracted:  K
  Issues filed:       J
    - <issue URL> [lessons] <skill>: <summary>
  Queue remaining:    L (consume next time via --limit)
```

## Connecting to backlog (`auto-ok` label operation, HATL point 2)

The filed `[lessons]` issue is a backlog pointer (a priority index), and connecting it to the consumption target of `/backlog --auto` ([#175](https://github.com/ozzy-labs/skills/issues/175)) closes the improvement loop's reflect → consume cycle. This connection is boundary-controlled (HATL) via the `auto-ok` label.

- **`auto-ok` is applied only by a human.** This matches backlog's label convention (backlog SKILL.md, "HATL gating for `--auto`" = `auto-ok` is applied only by a human; no automatic-grant path exists). **lessons-triage does not attach `auto-ok` when filing** (it does not pass `--label auto-ok` to `gh issue create`). Not creating an automatic-grant path in this skill is the crux of HATL.
- **Human boundary control converges on 2 points (HATL):**
  1. **Filing approval** — the `externally-visible` gate in step 4 (default batch-confirm). A human chooses which lessons become issues.
  2. **Attaching the `auto-ok` label** — a human looks at the filed `[lessons]` issue and attaches `auto-ok` only to the ones safe to send to drive without confirmation (a standing approval = setting the boundary condition).
- **How the connection flows:** after `auto-ok` is attached, `/backlog --auto` (which can be launched from a cron routine or `/loop`) sends only `auto-ok` issues to `drive` without confirmation, producing a fix-PR. A `[lessons]` issue without `auto-ok` doesn't become a `--auto` consumption target, and a human picks it up via the normal backlog presentation (default mode).
- The loop never spins automatically unless the label is attached (**there is no ungated automatic consumption**). Whether or not to attach auto-ok is the sole decision point for whether the self-improvement loop spins automatically.

For the setup that periodically runs the whole loop as a weekly routine (`skill-metrics --snapshot` → metrics-primed lessons-triage → `/backlog --auto`), see the routine recipe in README's "Observability" section.

## Notes

- Does not read `.env` files
- If the `gh` CLI is not authenticated, display an error message and abort
- The `skill-metrics` rollup is merely a read-only **prioritization starting point** (do not use it to determine cause — diagnosis and fixing happen locally, where the transcript is). Trend comparison of the rollup (week-over-week) is `skill-metrics`'s responsibility, and turning it into a weekly routine is the responsibility of the routine recipe in README's "Observability" section. This skill is responsible for filing (reflect) and connecting to backlog via `auto-ok` label operation ([#184](https://github.com/ozzy-labs/skills/issues/184))
- Future extension (a reflection route into memory / AGENTS.md / CLAUDE.md) is out of scope for this skill. The classification logic in step 4 is designed so a reflection-destination route can be added later
