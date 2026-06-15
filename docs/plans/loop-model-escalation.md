# Patch spec: loop model-escalation on stall (capability backstop)

**Status:** proposed · **Date:** 2026-06-15 · **Repo:** archon (this repo)
**Audience:** the agent implementing this patch. Self-contained — anchors at the end.
**Builds on:** the just-landed per-iteration loop retry (A1 + B) in `executeLoopNode`
(`dag-executor.ts:2126`). This is the **complementary** feature: retry handles *transient* errors
(same model); escalation handles *capability* shortfalls (switch to a stronger model).

---

## 1. Why

A loop node (e.g. the opsx-wave-harness `impl-wN` impl loop) runs on a cheap/fast default provider
(Cursor `composer-2.5`). Two distinct failure modes:

- **Transient provider blip** → already handled by the per-iteration retry (B): retry the *same*
  model. Fixes flakiness.
- **Capability shortfall** → the cheap model genuinely *can't* make progress on a hard wave: it
  iterates without completing cycles (no new commits), eventually exhausting `max_iterations` and
  failing the loop → the wave is left incomplete → the run aborts. **This is unhandled.**

This patch adds the §13.3 "escalate-on-thrash" backstop: when a loop **stalls** (makes no progress
for N consecutive iterations), switch to a stronger fallback model for the remaining budget instead
of failing. Most waves finish on the cheap model; only the genuinely-stuck ones pull in the strong
model — the cost/quality lever that makes the cheap-default bet safe.

### Why stall-based, not count-based

Empirical calibration from a real run (`opsx-wave-harness`, run `83a7bf8e`): per-wave iteration
usage was `1, 10, 6, 9, 8` against `max_iterations: 15`. Wave sizes vary widely (1–10 cycles, one
cycle per iteration), so a **fixed iteration count is the wrong trigger**:
- a small wave (1 cycle) that gets stuck would burn all 15 iterations before failing — slow;
- a large wave (10 cycles) legitimately uses ~10 iterations while *progressing* — not thrashing.

The true signal is **progress, not count**: a wave committing a cycle each iteration is healthy at
any size; a wave that commits nothing for N iterations is stuck regardless of size. So the escalation
trigger is **"no new git commit in the loop's cwd for `stall_after` consecutive completed
iterations."** `max_iterations` stays as a generous *hard backstop*, not the primary trigger.

## 2. Feature

Add an optional `escalate` block to the loop config. When set and the loop stalls, the loop swaps
its active provider/model to the fallback for subsequent iterations.

### 2.1 Schema (`packages/workflows/src/schemas/loop.ts`)

Add to `loopNodeConfigSchema`:

```ts
/** Escalate to a stronger model when the loop stalls (no progress) on the primary model. */
escalate: z
  .object({
    /** Fallback model — a LITERAL id (e.g. "opus"), not a tier keyword. Required. */
    model: z.string().min(1, "loop.escalate requires 'model'"),
    /** Fallback provider (e.g. "claude-terminal"). Default: keep the loop's current provider. */
    provider: z.string().trim().min(1).optional(),
    /** Provider effort hint passed through (e.g. "high"). */
    effort: z.string().trim().min(1).optional(),
    /** Consecutive no-progress iterations that trigger escalation. Default: 3. */
    stall_after: z.number().int().positive().default(3),
  })
  .optional(),
```

Literal `model` matters: tier keywords resolve against `config.assistant`'s profile and would not
reliably land on the intended provider — a literal passes straight through to `escalate.provider`
(same rule as elsewhere in the executor).

### 2.2 Progress signal (v1: git commit)

The loop's concrete progress unit for a code loop is the per-cycle **git commit** (the impl loop
commits + ticks a checkbox each cycle). v1 progress detection:

- At loop start, record baseline `git -C <cwd> rev-parse HEAD`.
- After each **completed** iteration (ran to the end, no provider error — see §2.4 re: retries),
  read HEAD again. If it advanced → progress (reset the stall counter). If unchanged → increment
  the stall counter.
- `escalate` is **opt-in**, so assuming commit-per-iteration is safe (only loops that commit set it).
- **Graceful degradation:** if the cwd is not a git repo or `rev-parse` fails, log a warn, disable
  stall detection, and fall back to escalating only on `max_iterations` exhaustion (or, if you keep
  it minimal, simply don't escalate). Never crash the loop on a git error.

> Keep the progress signal behind a small internal helper so it can later become pluggable
> (e.g. "output changed", "file mtime") without touching the escalation logic.

### 2.3 Escalation state machine (inside `executeLoopNode`, `dag-executor.ts:2071`)

Maintain: `escalated: boolean = false`, `stallCount = 0`, `activeProvider/activeOptions/activeClient`
(start = primary, resolved as today at the loop dispatch).

Per iteration, after it **completes without a provider error**:
1. Compute progress (HEAD advanced?). If advanced → `stallCount = 0`; else `stallCount++`.
2. If `!escalated && stallCount >= escalate.stall_after`:
   - swap `activeProvider/activeOptions/activeClient` → fallback (see §2.5);
   - `escalated = true`, `stallCount = 0`;
   - emit a `loop_node_escalated` event + a user message (`§2.6`);
   - continue iterating (do not consume extra `max_iterations`).
3. If `escalated && stallCount >= escalate.stall_after` → **fail the loop** with a clear error
   ("escalated model also stalled after N iterations") — don't thrash the expensive model forever.

`max_iterations` remains the total hard cap across both models (unchanged semantics). `until` /
`until_bash` completion is checked exactly as today.

### 2.4 Interaction with the per-iteration retry (B)

- (B) retry = *transient/opaque provider error* within an iteration → retry the **same** model. A
  transient-failed-then-retried iteration is **not** a "completed" iteration for stall purposes —
  do **not** increment `stallCount` for it (stall is about a model that *runs fine but makes no
  progress*, not about provider errors).
- **Optional extra trigger (recommend including):** if (B) retries are *exhausted* for an iteration
  (provider keeps erroring on the primary), that is also a good moment to escalate rather than fail —
  the fallback provider may not have the same outage. If you include it, escalate (don't fail) on
  (B)-exhaustion when `escalate` is set and `!escalated`; fail if already escalated.

### 2.5 Resolving the fallback (provider/model swap)

Keep model resolution in one place. At the loop dispatch (the `if (isLoopNode(node))` branch that
calls `resolveNodeProviderAndModel` then `executeLoopNode`), when `node.loop.escalate` is present,
**pre-resolve the fallback** pair too (build a resolution from `escalate.provider ?? <loop provider>`
+ literal `escalate.model` + `escalate.effort`) and pass both (primary, fallback) into
`executeLoopNode`. On escalation the loop swaps to the pre-resolved fallback and
`deps.getAgentProvider(fallbackProvider)`. This avoids re-implementing resolution inside the loop.

Session note: `escalate` is intended for `fresh_context: true` loops (each iteration re-reads state
from disk), so switching provider mid-loop needs no session carryover. If `fresh_context` is false,
reset the session on switch (a cross-provider session can't resume). Document this; the impl loop is
`fresh_context: true`.

### 2.6 Observability

Emit a `loop_node_escalated` workflow event (and a `safeSendMessage`) with `{ nodeId, fromModel,
toModel, fromProvider, toProvider, atIteration, reason: 'stall' | 'retry_exhausted' }`. This lets the
harness report + the §13.3 calibration loop record which waves needed escalation (a wave class that
repeatedly escalates should be re-stamped harder upstream).

## 3. Acceptance criteria

1. A loop with `escalate` that **stalls** (no new commit for `stall_after` completed iterations)
   switches to the fallback provider/model for subsequent iterations (verified via the escalation
   event and the fallback client being used).
2. A loop that **progresses** (commits each iteration) NEVER escalates, even when iteration count
   approaches `max_iterations` (large but healthy wave). No false escalation.
3. After escalation, a second stall (or `max_iterations`) **fails** the loop with a clear error.
4. Composes with (B): a transient error within an iteration retries the **same** model and does not
   count toward stall. (If §2.4 optional trigger is included: (B)-exhaustion escalates once.)
5. No `escalate` config → loop behavior is byte-for-byte unchanged.
6. Non-git cwd / git failure → no crash; stall detection disabled with a warn.

## 4. Tests (`packages/workflows/`)

1. **Stall → escalate:** mock the provider to commit for 2 iterations then stop committing; assert a
   `loop_node_escalated` event fires when `stallCount` hits `stall_after`, and the fallback client is
   used afterward.
2. **No-stall large loop → no escalate:** mock commit-every-iteration for > `max_iterations`-sized
   work; assert zero escalation events.
3. **Post-escalation stall → loop fails** with the "escalated model also stalled" error.
4. **Compose with (B):** a transient error mid-iteration retries same model, doesn't bump stall.
5. **No `escalate`:** existing loop tests unchanged (regression).
6. **git-unavailable cwd:** loop runs, no crash, stall detection off (warn emitted).

## 5. Consumer usage (harness — separate change, after this lands)

The opsx-wave-harness generator will add to the `impl-wN` loop:

```yaml
escalate:
  provider: claude-terminal
  model: opus
  effort: high
  stall_after: 3
```

So a wave where cursor `composer-2.5` stalls for 3 iterations escalates to claude-terminal opus for
the rest of that wave, instead of exhausting `max_iterations` and aborting the run. (Not part of this
archon patch — noted so the contract is clear. `max_iterations` stays ~15–18.)

## 6. Out of scope

- Per-**cycle** model routing (one gnarly cycle escalates) — §13.3 calls per-wave the right grain;
  per-cycle is a later refinement.
- The "impl emitted COMPLETE but the downstream wave gate is red" case — that's cross-node (the gate
  is a separate node), needs workflow-level wiring, not a loop feature.
- Changing `max_iterations` defaults or `DEFAULT_NODE_*` retry constants.
- Reworking the change-gate (it's currently unrolled bash + prompt nodes, not a loop).

## 7. Anchor index (file:line, archon repo — re-grep, the A1+B patch shifted numbers)

| What | Location |
|---|---|
| Loop config schema (add `escalate`) | `packages/workflows/src/schemas/loop.ts` (`loopNodeConfigSchema`) |
| `executeLoopNode` | `packages/workflows/src/dag-executor.ts:2071` |
| Iteration loop (`for (let i = startIteration; i <= loop.max_iterations; i++)`) | `dag-executor.ts:2135` |
| Loop's active AI client (`getAgentProvider(workflowProvider)`) | `dag-executor.ts:2094` |
| Per-iteration retry block (B) — compose stall logic next to it | `dag-executor.ts:2126`+ |
| Loop iteration error throw / `loop_iteration_failed` event (telemetry pattern) | `dag-executor.ts:2323`, `:2404` |
| Loop dispatch — `if (isLoopNode(node))` → `resolveNodeProviderAndModel` → `executeLoopNode` (pre-resolve fallback here) | grep `isLoopNode(node)` in the dispatch section (~`dag-executor.ts:3183` pre-patch) |
| `resolveNodeProviderAndModel` (reuse for fallback resolution) | grep the function name in `dag-executor.ts` |
| Structural `errorSubtype` retryability (A1, for §2.4 interaction) | `dag-executor.ts:289-300` |
