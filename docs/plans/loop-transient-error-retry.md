# Patch spec: retry transient/opaque provider errors in loop nodes

**Status:** implemented (A1 + B) · **Date:** 2026-06-15 · **Repo:** archon (this repo)
**Audience:** the agent implementing this patch. Self-contained — all anchors are in this file.

---

## 1. Problem (observed in production)

A `cursor`-provider workflow run (`opsx-wave-harness`, run `83a7bf8e-2b98-4ecb-bf26-958ec661f0f3`)
died because a **single transient Cursor SDK error on the first iteration of a loop node killed the
whole loop** — no retry. The loop node was an impl wave (`impl-w4`). The failure cascaded: the wave
was left incomplete, a downstream `assert-waves-complete` correctly failed, and the run aborted.

The exact error string that propagated:

```
Loop 'impl-w4' iteration 1 failed: SDK returned cursor_error — run error
```

Cursor returned an error-status `final` with **no detail** (`errors:["run error"]`) and an **empty
stderr tail**, so the provider emitted the generic `errorSubtype: 'cursor_error'` with message
`"run error"`. There is no underlying transient signal to recover from the message itself — Cursor
gave nothing actionable.

## 2. Root cause (precise — do not re-derive)

**The gap is error CLASSIFICATION, not a missing retry mechanism. Loop nodes already go through the
retry wrapper.** Verified call path:

- The node retry wrapper at `packages/workflows/src/dag-executor.ts:3417-3460` wraps
  `executeNodeInternal(...)` in a retry loop.
- `executeNodeInternal` (defined at `dag-executor.ts:751`) contains the loop dispatch at
  `dag-executor.ts:3183` (`if (isLoopNode(node)) { ... executeLoopNode ... }`). So **loop nodes are
  executed inside the retry wrapper.**
- `getEffectiveNodeRetryConfig` (`dag-executor.ts:341-358`) returns the default
  `{ maxRetries: DEFAULT_NODE_MAX_RETRIES=2 (line 327), delayMs: 3000, onError: 'transient' }` for
  loop nodes. (The `retry:` *field* is forbidden on loops at parse time —
  `packages/workflows/src/schemas/dag-node.ts:547-552` — but the DEFAULT still applies.)
- On failure, the wrapper retries only if the error is retryable
  (`dag-executor.ts:3449-3460`): `shouldRetry = !isFatal && (onError==='all' || (onError==='transient'
  && isTransient))`, where `isTransient = classifyError(new Error(output.error)) === 'TRANSIENT'`.
- `classifyError` (`packages/workflows/src/executor-shared.ts:73-83`) matches the message against
  `FATAL_PATTERNS` (line 30-40) then `TRANSIENT_PATTERNS` (line 43-59), else returns `UNKNOWN`.
- `"...cursor_error — run error"` matches **neither** pattern list → `UNKNOWN` → `isTransient=false`
  → `shouldRetry=false` → **no retry** → loop fails.

The loop iteration error is thrown at `dag-executor.ts:2279-2281`:

```
throw new Error(`Loop '${node.id}' iteration ${String(i)} failed: SDK returned ${subtype}${errorsDetail}`)
```

The structural `subtype` (`'cursor_error'`) and the `errors` array are available at
`dag-executor.ts:2265-2272` **before** they are flattened into the thrown `Error` string. The
non-loop equivalent throw is at `dag-executor.ts:1118-1132`. The Cursor provider's error result
(`errorSubtype`, redacted message) is produced at
`packages/providers/src/community/cursor/provider.ts:209` (`errorResult(...)`), with `'cursor_error'`
used at lines 209 and 529.

## 3. Goal / acceptance criteria

1. A loop-node iteration that fails with an **opaque/transient Cursor error** (`errorSubtype:
   'cursor_error'`, incl. the bare `"run error"` case) is **retried** under the existing default
   retry policy, instead of failing the loop on the first occurrence.
2. **FATAL errors still fail fast** — an auth/permission/credit Cursor error (message matches
   `FATAL_PATTERNS`, or subtype indicating auth) must NOT be retried, even though it is also a
   `cursor_error` subtype. FATAL precedence is preserved.
3. The fix is **provider-agnostic where possible** — the retry layer should remain the single
   decision point; avoid scattering provider-specific logic across the executor.
4. No regression to the existing non-loop retry behavior or to other providers.

## 4. Approach — pick (A); (B) is an optional follow-up; (C) is rejected

### (A) PRIMARY — make opaque provider errors classify as retryable

Two implementation flavors; **prefer A1** (structural), fall back to A2 (stopgap) only if A1 is
disproportionately invasive.

**A1 — structural retryability signal (clean).**
Thread the provider error `subtype` (or a derived `retryable` boolean) from the loop/non-loop SDK
error handlers through `NodeExecutionResult`, and let the retry layer (`dag-executor.ts:3449-3460`)
consider it. Concretely:
- At the loop error site (`dag-executor.ts:2265-2281`) and the non-loop site
  (`dag-executor.ts:1118-1132`), carry the `errorSubtype` onto the resulting failed `NodeOutput`
  (e.g. a new optional `errorClass`/`retryable` field on `NodeExecutionResult`/`NodeOutput`).
- In the retry decision, treat a provider "opaque run error" subtype (`cursor_error` and any
  analogous generic-failure subtypes) as TRANSIENT — **after** the existing `isFatal` check, so
  `FATAL_PATTERNS` still win.
- Keep `classifyError` as the message-based fallback; the structural signal is an additional input,
  not a replacement.

**A2 — stopgap (1-line, acceptable if A1 is deferred).**
Add `'cursor_error'` (and optionally `'run error'`) to `TRANSIENT_PATTERNS` in
`executor-shared.ts:43`. Because `classifyError` checks `FATAL_PATTERNS` first
(`executor-shared.ts:76-80`), an auth-flavored Cursor error (`unauthorized`, `invalid token`,
`401/403`, `credit balance`…) still classifies FATAL and is not retried. Residual risk: a genuinely
fatal-but-opaque `cursor_error` (e.g. an unrecoverable model-parameter rejection) would be retried up
to 2× with backoff — bounded, low harm. Note the model-parameter-rejection case has its own recovery
path (`providers/.../cursor/provider.ts:653` "recoverable model-parameter rejection"), so it is
already handled separately.

> Note on retry granularity for (A): the existing retry is **whole-loop** (the wrapper re-invokes
> `executeNodeInternal` → `executeLoopNode` from `startIteration=1`). For impl-style loops this is
> functionally a resume, not a redo: each iteration re-reads its plan + `progress.md` from disk and
> does the *next unchecked* cycle, and completed cycles are already committed. So (A) alone fixes the
> observed failure without redoing finished work. (B) only improves granularity.

### (B) OPTIONAL FOLLOW-UP — per-iteration retry inside the loop

Catch the iteration error at `dag-executor.ts:2279-2281` and retry **just that iteration** N times
(with backoff) before failing the loop node, instead of relying on the coarser whole-loop retry.
Benefits: avoids re-entering `executeLoopNode`; provider-agnostic; helps any mid-wave transient blip.
Should reuse the same retryability decision from (A) (don't duplicate classification). Larger change;
do after (A) if granularity proves necessary.

### (C) REJECTED — allow `retry:` on loop nodes

Removing the parse-time ban (`dag-node.ts:547-552`) so a workflow can set `retry: { on_error: all }`
on a loop is worse: `on_error: 'all'` would retry FATAL too, and it's still whole-loop-coarse. (A)
gives the right behavior without new surface area.

## 5. Tests (required)

Add/extend tests under `packages/workflows/` (and `packages/providers/.../cursor/` if touching the
provider):

1. **Classification:** an error string/subtype representing an opaque Cursor run error
   (`cursor_error` / `"run error"`) is treated as retryable by the retry decision used at
   `dag-executor.ts:3449-3460`. (If A1: assert via the structural signal; if A2: assert
   `classifyError("...cursor_error — run error") === 'TRANSIENT'`.)
2. **FATAL precedence preserved:** a Cursor error whose message contains a `FATAL_PATTERN`
   (e.g. `"cursor_error — unauthorized"`) is NOT retried (classifies FATAL).
3. **Loop retry integration:** a loop node whose iteration fails once with an opaque Cursor error and
   succeeds on retry completes successfully (mock the provider to fail-then-succeed); assert the
   retry actually fired (e.g. the `dag_node_transient_retry` warn at `dag-executor.ts:3463`).
4. **No regression:** an existing non-loop transient retry test still passes; a non-retryable
   (`UNKNOWN`, non-cursor) loop failure still fails without retry (so A2 didn't over-broaden).

## 6. Out of scope

- The workflow-structure fix that prevented this transient blip from *shipping a partial-change PR*
  is **already done** in the consuming repo (lexup `opsx-wave-harness`): `create-pr.trigger_rule`
  was changed from `all_done` → `one_success`, so an aborted pipeline no longer fires create-pr.
  This archon patch is the complementary fix: make the transient error **self-heal** so the wave
  (and run) doesn't abort in the first place. Do not change `create-pr` semantics here.
- Capability-based escalation (re-running a thrashing wave on a stronger model) is a separate,
  larger feature (OpenSpec note §13.3); not part of this patch.
- Do not change `DEFAULT_NODE_MAX_RETRIES` or the default delay unless a test demonstrates need.

## 7. Verification before handing back

- `archon validate workflows <any>` unaffected (no schema change unless A1 adds an optional field —
  if so, keep it optional and backward-compatible).
- Run the package test suite for `packages/workflows` (and `packages/providers` if touched).
- Confirm the four acceptance criteria in §3 hold.

## 8. Anchor index (file:line, archon repo)

| What | Location |
|---|---|
| Loop iteration error throw (impl-w4's error) | `packages/workflows/src/dag-executor.ts:2279-2281` |
| Loop error subtype/errors available structurally | `dag-executor.ts:2265-2272` |
| Non-loop SDK error throw (equivalent) | `dag-executor.ts:1118-1132` |
| Node retry wrapper (wraps loops too) | `dag-executor.ts:3417-3460` |
| Retry decision (isFatal/isTransient/shouldRetry) | `dag-executor.ts:3449-3460` |
| `getEffectiveNodeRetryConfig` + defaults | `dag-executor.ts:341-358` (`DEFAULT_NODE_MAX_RETRIES` @327) |
| `executeNodeInternal` (contains loop dispatch) | `dag-executor.ts:751`; loop dispatch @`3183` |
| `classifyError` + pattern lists | `packages/workflows/src/executor-shared.ts:73-83` (FATAL @30, TRANSIENT @43) |
| `isTransientNodeError` | `dag-executor.ts:361-369` |
| Loop `retry:` field ban (schema) | `packages/workflows/src/schemas/dag-node.ts:547-552` |
| Cursor `errorResult` / `cursor_error` subtype | `packages/providers/src/community/cursor/provider.ts:209` (also @529) |
| Cursor "run error" degrade behavior (tests) | `packages/providers/src/community/cursor/provider.test.ts:469-490` |
