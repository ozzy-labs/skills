# Observability weekly routine (loop-closure recipe)

This recipe drives the skill-improvement loop — **capture → aggregate → reflect → consume** — on a weekly cadence so the skill catalog self-improves from its own friction data. It is the "driving part" that closes ADR-0028 R5 ([#184](https://github.com/ozzy-labs/skills/issues/184)) on top of the measurement (`skill-observability`), aggregation (`skill-metrics`), reflection (`lessons-triage`), and consumption (`backlog`) layers.

The loop only turns when a human sets two boundary conditions (HATL — human **at** the loop, not in every step): **(1) approving which lessons get filed**, and **(2) applying the `auto-ok` label** to the filed issues that may be auto-consumed. Everything between those two points is automatable.

## The four stages

```text
skill-observability  →  skill-metrics  →  lessons-triage  →  backlog  →  (drive → fix-PR)
     capture               aggregate         reflect          consume
   events.jsonl        counts + notable    backlog-pointer   priority index
 (obs-derive hook)     (--snapshot + trend)  issue (HITL)       → /drive
        ▲                                                              │
        └───────────── fix ships, next window re-measures ────────────┘
```

- **capture** — the `skill-observability` SessionEnd hook (`obs-derive.mjs`) derives which skills ran from each transcript and appends events to `~/.agents/observability/events.jsonl`. Fail-open, metadata-only.
- **aggregate** — `skill-metrics --snapshot` rolls the log into per-skill counts + notable friction, writes this week's snapshot to `~/.agents/observability/snapshots/<YYYY-Www>.json`, and diffs it against last week's snapshot (`trend`: week-over-week deltas, min-n guard inherited so a rate delta appears only when both weeks clear `min_n`).
- **reflect** — `lessons-triage` reads the rollup as a *metrics-primed* prioritization index, reads the high-friction skills' transcripts first, and files privacy-scrubbed `[lessons]` **backlog-pointer** issues (HITL: the central autonomy policy's `externally-visible` gate → batch-confirm).
- **consume** — a human applies `auto-ok` to the filed issues they want auto-driven; `backlog --auto` then hands only those issues to `drive`, turning the priority index into fix-PRs.

## Schedule prompt (weekly)

Register the following prompt as a **weekly scheduled (cron) agent** — the mechanism built for a weekly cadence (a polling `/loop` would have to keep a session alive for the whole week, so it is not the right tool here). It is idempotent per run and never files or merges anything without the two HATL boundaries below.

```text
Weekly skill-observability loop pass:

1. Run `/skill-metrics --snapshot`. This writes this week's snapshot and diffs
   it against last week (trend: invocation + friction-signal deltas, min-n
   guard inherited).
2. Inspect the rollup for notable signals (fallback / hitl.rejected /
   loop.hit_cap / aborted) or a rising friction trend (positive
   signals deltas / invocations_delta on a high-friction skill).
   - If there is NOTHING notable, stop here and report "no notable friction
     this week" — do not file anything.
   - If there IS something notable, continue.
3. Run metrics-primed `/lessons-triage` with the rollup as the prioritization
   index. Filing the extracted `[lessons]` issues is an externally-visible
   action: follow the central autonomy policy's gate (zero-config
   `batch-confirm` = ONE confirmation of the whole batch, per R3). Do not file
   per-item; do not auto-file.
4. Report the filed issue URLs and stop. Applying `auto-ok` to any of them is a
   separate human decision (see HATL boundary 2). Do not apply `auto-ok`
   automatically.
```

`skill-metrics` and `lessons-triage` are read-only / HITL by construction, so the scheduled pass cannot ship a change on its own — it can only *surface* friction and (with one batch confirmation) *file pointers*.

## Consuming the filed issues

Consumption is intentionally a **second, separate** routine so that `auto-ok` labelling stays a deliberate human act between the two:

```text
Backlog consume pass:

Run `/backlog --auto --limit 3`. This hands only `auto-ok`-labelled issues to
drive (unapproved dependencies cascade-excluded), producing merge-ready fix-PRs.
Issues without `auto-ok` are never auto-consumed.
```

Because `auto-ok` is human-only (no skill applies it — see `backlog` and `lessons-triage` SKILL.md), an issue reaches `drive` only after a human has both approved its filing and applied the label.

## HATL boundaries (the two human decision points)

| # | Boundary | Where | What the human decides |
| --- | --- | --- | --- |
| 1 | **Issue-filing approval** | `lessons-triage` step 4 (`externally-visible` gate → batch-confirm) | Which extracted lessons become `[lessons]` issues |
| 2 | **`auto-ok` label** | Manual label on a filed issue | Which filed issues may be auto-driven by `backlog --auto` |

No auto-apply path exists at either boundary: without a batch confirmation nothing is filed, and without a human-applied `auto-ok` nothing is auto-consumed. The scheduled passes automate everything *between* the two boundaries (aggregation, trend, prioritized transcript reading, drive orchestration) while keeping the externally-visible and irreversible steps under human control.

## Verification note (manual follow-up)

The routine's *documented* contract (schedule-prompt shape, HATL boundaries, loop wiring) is covered by doc-content tests. Actually **running the schedule** is a dogfood activity that cannot execute inside an isolated worker environment (no `schedule` daemon, no live `~/.agents` event stream). Validate the end-to-end cadence by registering the prompt above in a real environment and observing one full weekly cycle (snapshot → trend → filed issue → `auto-ok` → `backlog --auto` → fix-PR).
