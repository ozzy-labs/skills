# 0002. usage-guard resume arming

- Status: Accepted
- Date: 2026-07-13
- Deciders: ozzy
- Tags: usage-guard, resume, resilience, claude-code, hitl
- Refs: [ozzy-labs/skills#212](https://github.com/ozzy-labs/skills/issues/212), [ozzy-labs/skills#213](https://github.com/ozzy-labs/skills/issues/213), handbook [ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md)

## Context

usage-guard's **purpose** is to prevent the failure "hit the Usage Limit → work stops → the reset arrives but work never resumes (stuck)". Pausing *before* 100% is only a **means** to keep the session alive so an in-session scheduler can fire the resume.

A review of the skill surfaced two structural gaps:

- **The resumer is prose-only (#212).** The deterministic engine (`usage-check.mjs` signal, `usage-guard-hook.mjs` ceiling) only does the *negative* half — it stops work (the hook denies). The *positive* half — actually re-entering after the reset — lives entirely as a natural-language decision table in `SKILL.md` that the model must execute. If the model mis-executes, or the session hard-interrupts at 100% before it can arm anything, nothing resumes. So the purpose is met only on the happy path.
- **In-session resume dies with the session (#213).** The two triggers the wait-loop uses — `ScheduleWakeup` and a session-scoped `CronCreate` one-shot — are both in-session primitives. A genuine 100% hard-interrupt freezes the session, and neither auto-fires across it (they restore only on an explicit `--resume`). The only primitive that survives a hard-interrupt is a **cloud Routine** (scheduled deployment), which runs on session-independent infrastructure.

Host scheduling tools (`ScheduleWakeup` / `CronCreate` / Routines) cannot be invoked from a `.mjs` — only the model can call them. So the engine cannot *itself* arm a resume; it can only make the decision deterministic and detect when a resume was missed. Per the [2-tier ADR rule](https://github.com/ozzy-labs/handbook/blob/main/conventions/project-docs-layout.md) this is skills-repo-internal design → a project ADR. #212 and #213 share this one ADR because they are two variants of the same "arm a resume" decision.

## Decision

### 1. The engine emits a deterministic `resume_plan`

`usage-check.mjs` gains a pure `buildResumePlan()` and includes a `resume_plan` field on every result (`null` when `ok`). When over threshold it is:

```json
{ "trigger": "short-recheck" | "schedule-wakeup" | "cron-oneshot" | "cron-routine",
  "wait_seconds": 12900, "fire_at": "2026-07-13T02:15:00Z" }
```

Trigger selection is **deterministic**, moving the `SKILL.md` decision table into code:

- `suspected_reflection_lag` → `short-recheck` (re-check at the short interval; never pin a long trigger on a boundary afterimage).
- else `context: "orchestration"` (durable/restart-resilient needed) → `cron-oneshot`.
- else `wait_seconds > 3600` (exceeds the `ScheduleWakeup` per-call cap) → `cron-oneshot`.
- else → `schedule-wakeup`.

`context` is threaded like `headroom` (CLI `--context`, env `USAGE_GUARD_RESUME_CONTEXT`); default derives purely from `wait_seconds`. The model's job shrinks to "execute `resume_plan.trigger` at `fire_at`" — no prose interpretation.

### 2. Pending-resume marker + SessionStart detection (self-heal for "stuck")

A caller that pauses writes a **marker** (`~/.claude/usage-guard/resume-pending.json`, atomic temp→rename) recording `{ continuation, fire_at }`, and clears it on successful resume. A **SessionStart hook** (`resume-check.mjs`) reads the marker and, if `fire_at` has already passed, surfaces "a paused resume is OVERDUE — re-run `<continuation>`". This directly detects the purpose's failure mode (stuck after reset) instead of leaving it silent.

### 3. Durable variant: `cron-routine` (#213)

For the hard-interrupt case, `context: "durable"` (or a `--durable` caller) selects `trigger: "cron-routine"` — a **cloud Routine** pre-armed to fire at `fire_at = resets_at + buffer` on session-independent infrastructure, guarded so `fire_at > resets_at` (a fire before the reset would be `session_rate_limited_error`). The continuation must be idempotent (drive already is). Where `/schedule` is unavailable the caller falls back to the in-session plan with a warning.

### 4. Division of labor (engine vs. model vs. host)

- **Engine (deterministic):** emit `resume_plan`; own the marker read/write/clear; run SessionStart detection.
- **Model:** execute `resume_plan.trigger` via the host tool; write the marker on pause; clear on resume.
- **Host:** the actual `ScheduleWakeup` / `CronCreate` / Routine firing.

### 5. Additive, backward-compatible, fail-open

`resume_plan` is an added field (null when `ok`); existing consumers ignore it. The marker/SessionStart hook is opt-in wiring. All paths remain fail-open — a marker/plan error never hard-stops.

## Consequences

### Positive

- The resume decision is testable and deterministic; the model can no longer pick the wrong trigger or silently skip arming.
- "Stuck after reset" becomes **detected and surfaced** (SessionStart), not an invisible failure.
- #213's durable path is a single extra `trigger` value on the same `resume_plan`, not a parallel mechanism.

### Negative / Trade-offs

- The engine still cannot *guarantee* the arm (host tools are model-only); it reduces, not eliminates, reliance on the model. The marker/SessionStart net catches the residual miss after the fact rather than preventing it.
- Two new HOME-anchored artifacts (`resume-pending.json`) and a new SessionStart hook to wire.

## Alternatives considered

- **Keep resume as prose (status quo).** Rejected: the review showed it is the exact gap that produces "stuck".
- **Engine arms the trigger directly.** Impossible: `.mjs` cannot call host scheduling tools.
- **Always use a cloud Routine.** Rejected as the default: heavier and `/schedule`-dependent; reserved for the durable/hard-interrupt case (#213) via `context`.

## References

- [#212](https://github.com/ozzy-labs/skills/issues/212) — code-ify the resume-arm.
- [#213](https://github.com/ozzy-labs/skills/issues/213) — durable cloud-Routine resume.
- `~/.agents/skills/usage-guard/SKILL.md` — the wait-loop and trigger table this ADR makes deterministic.
