# 0001. Observability measurement design

- Status: Accepted
- Date: 2026-07-03
- Deciders: ozzy
- Tags: observability, skills, measurement, privacy, hitl, dogfooding
- Refs: [ozzy-labs/skills#162](https://github.com/ozzy-labs/skills/issues/162), handbook [ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) (R5)

## Context

The skill-improvement loop already had capture (`lesson-capture.sh` SessionEnd hook), triage (`lessons-triage`), and repo/catalog health (`health`), but **no measurement layer**: skills could be fixed, yet the improvement could not be quantified, so the loop never closed ([#162](https://github.com/ozzy-labs/skills/issues/162)).

The pre-work verified the actual bottleneck with real data: open issues were **0**, recent closes were healthy, and `[lessons]` issues were historically **0** — so the loop is rate-limited **upstream** (signal generation), not downstream (fix throughput). Observability fills the missing input.

Two forces set the altitude:

- **Data volume.** The scope is a **single author's dogfooding** (measuring skills the author ran, reflected into the author's own repo) — explicitly **not fleet telemetry**. At single-author, low-frequency volume, statistical significance (rates, confidence intervals, `pass^k`) is unreachable; forcing them would mislead.
- **Bias.** Asking the model to self-report mid-run loses exactly the worst runs — the ones that abort are the least likely to emit. Ground truth (`gh`/`git` + transcript artifacts) does not have this hole.

`skill-observability`, `skill-metrics`, and `lessons-triage` are all skills-repo artifacts and the scope is explicitly non-fleet, so per the [2-tier ADR rule](https://github.com/ozzy-labs/handbook/blob/main/conventions/project-docs-layout.md) this is a **skills-repo-internal feature design** and belongs in a project ADR, not the handbook. Handbook [ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) R5 fixed the loop-closure *direction* at the cross-repo level; this ADR fixes the measurement layer's design detail and cross-references it. (The issue's PR4 plan named a handbook ADR; it is re-routed here for that reason — this is the skills repo's first project ADR.)

## Decision

### 1. Artifact-derived primary, inline emit subordinate

Capture is reconstructed **after the fact** from ground truth, not self-reported. `obs-derive.mjs` (SessionEnd hook, `adapters: claude-code`) reads the session transcript and derives which skills ran through two channels — model-invoked `Skill` tool uses (`operation: invoke_agent`) and user-typed `/slash-commands` (`operation: slash_command`, filtered to real installed skills so built-ins like `/clear` do not pollute the data). This avoids the self-report bias where aborting runs drop their emits.

Inline emit (`obs-emit.mjs`, all-adapter, T1) is the **subordinate** path, limited to semantic signals that leave no artifact trace: `review.loop_iter`, `review.deep_to_quick_fallback`, `usage_guard.fail_open`, `hitl.rejected`, `loop.hit_cap`. Native OTel (T2) is a separate surface (Decision 7).

A per-session `heartbeat` records "the observer ran", so an empty window reads as **"0 invocations"** and not "the hook never fired".

### 2. Counts + notable events, with a min-n guard

The contract does not force rates or confidence intervals. `skill-metrics` rolls the log up into per-skill **invocation counts** plus **notable friction events**, and suppresses any rate whose denominator is below `min_n` (`DEFAULT_MIN_N = 5`, env-overridable via `SKILL_METRICS_MIN_N`) — a "1/1 = 100% abort" rate is never shown. The week-over-week `trend` inherits the same guard: a rate delta is emitted only when **both** generations clear it; count deltas are always shown.

### 3. Privacy, strictest mode

Events are **metadata only**. `event.schema.json`'s `additionalProperties: false` is a mechanical guard: any unknown field (payload, diff, token, path) fails validation and is **never written**. Repo identifiers are stored only as `repo_hash` (a 12-hex-char sha256 prefix, pattern-enforced); raw repo name / cwd / PR values cannot pass validation. Reflection (sending anything outward) is always **opt-in / HITL** — the substrate itself has no send path.

### 4. Fail-open

An emit failure must never break the observed skill. `obs-emit.mjs`, `obs-derive.mjs`, and `skill-metrics.mjs` all swallow errors, warn to stderr, and exit 0 / return an empty rollup. A `&&`-chained caller is never broken by observability.

### 5. Reflection folded into `lessons-triage` (no third channel)

The only reflection path is `lessons-triage`, made *metrics-primed*: it reads the `skill-metrics` rollup to **order** which transcripts to read first, then files a privacy-scrubbed **backlog-pointer** `[lessons]` issue. The issue points at *where to look*, not the fix — diagnosis and the fix-PR happen locally where the transcript lives. Filing is gated by the central autonomy policy's `externally-visible` class (default `batch-confirm`); `auto-ok` (which lets `backlog --auto` consume an issue) is **human-only**. No third observability→issue path is created.

### 6. Single-author dogfooding scope

The design targets one author's own repo, not a fleet. Cross-machine pooling (aggregating events across machines) is out of scope and deferred; single-author count displays suffice.

### 7. Native OTel is a separate surface

The JSONL log (`~/.agents/observability/events.jsonl`) is **OTel-independent** and completes the core KPIs on its own. Native OTel (T2) is **not** an integration backbone — a skill cannot read the user's backend, and it is normally OFF. It is treated as optional power-user enrichment on a separate surface, never a dependency. Field names follow the OpenTelemetry GenAI semantic-convention *shape* (`skill` ≈ `gen_ai.agent.name`, `operation` ≈ `gen_ai.operation.name`) without hard-coupling to the still-experimental spec.

`event.schema.json` is the **single SSOT**: both `obs-emit.mjs` (runtime validate) and the test suite read that exact file, so the event shape has no doc/code drift.

## Consequences

### Positive

- The captured core is reliable and low-noise; the worst runs are not systematically dropped.
- Privacy is guaranteed mechanically (schema rejection), not by convention.
- Fail-open means observability can never break the skill it observes; the heartbeat keeps a coverage gap from reading as success.
- The loop closes through existing skills (`lessons-triage` → `backlog` → `drive`), adding no new reflection surface.
- One schema SSOT keeps doc and code in lockstep.

### Negative / Trade-offs

- **Outcome is not auto-derived at capture time** (see Deferred). The rollup's outcome counts are only populated by the T1 semantic path today, not by ground-truth `gh`/`git` derivation.
- Counts-only limits statistical inference by design; trend interpretation is qualitative until volume grows.
- Single-author scope means no cross-machine aggregation.
- Fail-open can hide coverage gaps (mitigated, not removed, by the heartbeat).
- T1 semantic emit is defined but not yet broadly wired into the skills that could emit it.

### Deferred (explicitly reserved until data volume justifies)

- **Outcome ground-truth derivation** — *intentionally deferred*, per `obs-derive.mjs`'s own note: at SessionEnd the merge state is unconfirmed and a session→PR linkage plus delayed re-evaluation are needed, so it is hard to capture there. `event.schema.json` **does** define an `outcome` event (`status` ∈ {completed, aborted, fallback}) and `skill-metrics` **can** aggregate it, but T0 auto-derivation is unimplemented — outcome currently arrives only via T1 semantic emit. Delayed outcome re-evaluation (revert detection) is the #162 "保留" item.
- `pass^k` and confidence intervals (single-author volume never reaches significance).
- Statistical / significance-tested trend — basic week-over-week count deltas shipped in [#206](https://github.com/ozzy-labs/skills/pull/206), but the richer statistical trend is deferred.
- Cross-machine event pooling.
- Revert detection (the delayed-outcome re-evaluation above).
- An eval harness (golden-task regression) to verify a fix actually improved a skill.
- Broad rollout of T1 prompt emit across skills.

## Alternatives considered

- **Self-report inline emit as the primary path** — rejected: it loses the worst (aborting) runs, biasing the headline KPIs upward. Kept only as a subordinate path for artifact-invisible signals.
- **Rates + confidence intervals as the core metric** — rejected: at single-author low frequency the denominator never clears significance; a "1/1" rate misleads. Counts + a min-n guard instead.
- **Native OTel as the integration backbone** — rejected: the backend is not readable from a skill and is normally OFF; the JSONL log self-completes the core. OTel stays optional enrichment.
- **A dedicated observability → issue reflection channel** — rejected: it would be a third path with its own gate. Folded into `lessons-triage` instead.
- **Fleet telemetry with richer payloads** — rejected: out of scope (single-author dogfooding) and at odds with the metadata-only privacy guard.

## References

- Issue: [ozzy-labs/skills#162](https://github.com/ozzy-labs/skills/issues/162) (observability & improvement loop, reduced/artifact-derived edition)
- Related handbook ADR: [ADR-0028](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-skills-architecture-engine-judgment-policy-catalog.md) (R5 = loop closure; this ADR fixes R5's measurement-layer detail)
- 2-tier ADR rule: handbook [`conventions/project-docs-layout.md`](https://github.com/ozzy-labs/handbook/blob/main/conventions/project-docs-layout.md) (why this is a project ADR)
- Implementation (SSOT): [`.agents/skills/skill-observability/event.schema.json`](../../.agents/skills/skill-observability/event.schema.json), [`obs-emit.mjs`](../../.agents/skills/skill-observability/obs-emit.mjs), [`obs-derive.mjs`](../../.agents/skills/skill-observability/obs-derive.mjs), [`.agents/skills/skill-metrics/skill-metrics.mjs`](../../.agents/skills/skill-metrics/skill-metrics.mjs), [`.agents/skills/lessons-triage/SKILL.md`](../../.agents/skills/lessons-triage/SKILL.md)
- Increments: [#163](https://github.com/ozzy-labs/skills/pull/163) (PR1a contract), [#164](https://github.com/ozzy-labs/skills/pull/164) (PR1b capture hook), [#165](https://github.com/ozzy-labs/skills/pull/165) (PR2 skill-metrics), [#204](https://github.com/ozzy-labs/skills/pull/204) (PR3 reflection channel), [#206](https://github.com/ozzy-labs/skills/pull/206) (weekly routine + trend)
