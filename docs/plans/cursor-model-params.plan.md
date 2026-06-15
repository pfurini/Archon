# Cursor Provider — Generalized Model Parameters (effort / thinking / context / fast) — Implementation Plan (v3)

> **v3 — after two adversarial Codex passes + live SDK probing.** v1 (committed
> static map, fail-soft drop, `[fast]`/`[1m]` suffix, default-variant merge,
> "assert run.model") was **rethink**. v2 fixed the suffix + static map but was
> **revise** — it failed OPEN to premium on the cost default, overclaimed
> determinism from an SDK-unobservable outcome, under-specified provenance, and
> tripped the `EFFORT_MAPS` invariant. v3 fixes those: **fail-CLOSED cost default**,
> **minimal (in-play-only) emission**, **presence-based provenance + fail-loud
> invalid config**, **full thinking-state mapping**, **durable-stale catalog +
> retry-on-rejection**, and **capability-flip-last + invariant exemption**.

## 0. What the adversarial passes + live probing changed

Confirmed flaws and the evidence that settled each:

1. **Static map + fail-soft + capability flip = a silent lie.** With
   `effortControl: true` but `effort` silently dropped on an unmapped model, the
   executor's unsupported-knob warning never fires (it only fires when caps are
   `false` — `dag-executor.ts:560/579`). Violates Archon's fail-fast principle
   (`model-validation.ts:244`). And the static map buys nothing: the sidecar
   already runs the SDK under node with `CURSOR_API_KEY` present
   (`cursor-runner.mjs:57`), so a **live** `Cursor.models.list()` is cheap.
   → **Fix: live disk-cached catalog (v1); fail-LOUD on an explicit knob the
   resolved model can't express.**

2. **"Merge the default variant" contradicts "never set hidden params" and (v1)
   froze stale defaults.** The opus default variant includes a hidden
   `cyber=false`. → **Fix: only emit PUBLIC params (those in the model's
   `parameters[]`), and (v3) **only the knobs actually in play** — never fill
   un-requested params from the default variant (that would pin a catalog snapshot
   over the server's own newer default). Un-set params keep the model's default.**

3. **The resolved params / billed tier are UNOBSERVABLE via the SDK — proven.**
   I probed `run.wait().model` and the streamed `system.model`:
   - Sent NO params → `run.model = {"id":"composer-2.5"}` (no params).
   - Sent `params:[{fast:false}]` → `run.model = {"id":"composer-2.5","params":[{"id":"fast","value":"false"}]}`.
   - `system.model` was `undefined` for local agents in both cases.
   So `run.model` **echoes the request verbatim** — it does NOT report what the
   server resolved/merged. Codex's proposed "assert run.model" fix is therefore
   *also* false confidence. → **Fix (v3): stop trying to observe OR force-determine
   resolution. Emit only in-play knobs; accept that merge-vs-replace and billed tier
   are unobservable in-band. The live gate proves request-shape acceptance only; tier
   is confirmed ONCE on the Cursor dashboard.**

4. **The `[fast]`/`[1m]` model-string suffix breaks tier/alias resolution —
   confirmed in code.** `resolveModelSpec` (`model-validation.ts:207-220`)
   matches `small|medium|large` by EXACT string and `@name` exactly; anything
   else is a literal. So `large[fast]` stops being the `large` tier (becomes a
   bogus literal) and `@fast[fast]` throws "Unknown alias". The suffix only works
   on already-literal models, and stripping it pre-resolution means touching the
   shared resolver. → **Fix: drop the suffix from v1. `fast`/context-window come
   from config-level `assistants.cursor.*` defaults. Per-node control + any
   suffix is Phase B and must strip pre-resolution + reject suffixes on
   tier/alias refs.**

5. **Stateful paths untested.** The runner uses the same options object for both
   `Agent.create` and `Agent.resume` (`cursor-runner.mjs:68`); DAG retries and
   `persist_session` re-runs reuse `nodeOptions`/`resumeSessionId`. → **Fix: add
   resume/persist/concurrency/clamp tests (§4).**

**Verdict adopted: rethink → this v2.**

## 1. Goal

Let Archon set Cursor per-model knobs (`effort`, `thinking`, context-window,
`fast`) portably, translating canonical Archon options into **validated**,
**minimal** Cursor `ModelSelection.params` (only the knobs in play), sourced from
the **live** model catalog, failing loudly when a requested knob can't be honored.

### Verified catalog facts (live `Cursor.models.list()`)
| Cursor param | Values | Family | Canonical home |
|---|---|---|---|
| `effort` | low/medium/high/xhigh/max | Claude | `effort:` (low/medium/high/max) — exists |
| `reasoning` | none/low/medium/high/extra-high\|xhigh | GPT/Codex | same canonical `effort:` |
| `thinking` | false/true | Claude | `thinking:` — exists |
| `context` | 300k/272k/200k/1m (per-model) | most | config-level `assistants.cursor.context` (v1) |
| `fast` | false/true | composer/gpt/some-claude | config-level `assistants.cursor.fast` (v1) |
| `cyber` | false | opus (hidden) | NEVER emitted |

Constraints: param id varies per model (`effort` vs `reasoning`); value vocab
diverges (`xhigh` vs `extra-high`; `max` absent on GPT); SDK runs only under node;
NodeConfig `context:` is already session-mode (`fresh`/`shared`) — unavailable.

## 2. Knob delivery (v1)

- **`effort`** — existing canonical `effort:` node field (`dag-node.ts:178`).
- **`thinking`** — existing `thinking:` node field (`dag-node.ts:179`), coerced
  to a boolean (enabled→`true`).
- **`fast`** — `assistants.cursor.fast?: boolean` in `.archon/config.yaml`
  (install/repo). **Default `false` (standard tier) from v1** — Archon runs
  background workflows, not live IDE iteration; standard is ~6× cheaper at
  identical quality, and the Cursor catalog default is `fast=true` (premium), so
  we set `false` explicitly. This is the implicit-default knob; when it can't be
  applied (catalog truly unavailable, no last-good snapshot) it **fails closed**
  unless `assistants.cursor.allowPremiumOnDegraded: true` (§3 degraded policy) —
  the cost default never silently bills premium. Per-node override = Phase B.
- **context-window** — `assistants.cursor.context?: '1m' | 'max' | '<model
  value>'` in config. Unset → no `context` value emitted (no implicit default).

No model-string suffix, no new per-node structured fields, no change to the
shared model resolver. effort/thinking are already portable; fast/context are
Cursor-scoped config defaults.

## 3. Translation contract (minimal, fail-loud)

`resolveCursorParams(catalog, modelId, knobs): { params: ModelParameterValue[] }`
— pure, in `model-params.ts`. **Emit ONLY the knobs actually in play** — never
fill un-requested params (see "Why not full-set" below).

**Knob provenance = presence in its source (no separate provenance type needed).**
- **`effort` / `thinking`** — explicit iff present in `nodeConfig` (the executor
  flattens node/workflow values into `nodeConfig.effort`/`.thinking`,
  `dag-executor.ts:632`; absence ⇒ not requested).
- **`fast` / `context`** — explicit iff the key is present in `assistantConfig`
  (`Object.hasOwn(assistantConfig, 'fast')`). `parseCursorConfig` must therefore
  distinguish **present-but-invalid** (→ fail-loud, `cursor_config_invalid`) from
  **absent** (→ use default) — it currently drops invalid silently
  (`config.ts:13`), which must change for these keys.
- **Implicit `fast=false`** — applies only when `fast` is absent from config.

**Knob → param value mapping:**
- `effort` (canonical low/medium/high/max) → the model's `effort` OR `reasoning`
  param, value clamped via one central table (`max` → first of
  `[max, xhigh, extra-high, high]` the model allows).
- `thinking` (`ThinkingConfig`, NOT a boolean — `dag-node.ts:56`): `enabled`→`'true'`,
  `disabled`→`'false'`, **`adaptive`→`'true'`** (closest to Cursor's binary
  thinking; documented). The `budgetTokens` sub-field is ignored (Cursor has no
  equivalent).
- `context` (`'1m'`/`'max'`/literal) → the model's largest `context` value (or the
  exact literal when present).
- `fast` (boolean) → `'true'`/`'false'`.

**Resolution steps:**
1. Look up `modelId` in the catalog (see §4 for the durable-stale fallback).
   - **Available** → step 2.
   - **Unavailable** (truly cold cache, never fetched, AND refresh failed) → see
     the degraded policy below.
2. For each knob **in play**, find the matching PUBLIC param id. If the model
   lacks it:
   - **explicit knob** → **throw `CursorModelParamsError`** (fail-loud).
   - **implicit `fast`** on a no-`fast` model (e.g. gemini) → omit (nothing to apply).
3. Clamp the value; collect `{ id, value }`. **Hidden params (not in the model's
   public `parameters[]`, e.g. `cyber`) are never emitted** — and emitting only
   in-play knobs means we never even read them.
4. Return the params; provider sets `cfg.modelParams`; runner sets `model: { id, params }`.

**Degraded policy when the catalog is truly unavailable (finding 1 — fail
closed, don't fail open to premium):**
- The default `fast=false` is a **cost-control** guarantee. If it cannot be
  applied, proceeding param-less makes the server apply its own default
  (`fast=true`, premium) — silently inverting the cost default at exactly the
  wrong moment. A `getLog().warn` is **not** user-visible (`MessageChunk` has no
  warning variant — `types.ts:231`; the only visible warning path is the
  capability-gated `safeSendMessage`, `dag-executor.ts:579`, which we are
  removing by flipping caps).
- Therefore: **fail closed** — yield a visible `cursor_model_params_unavailable`
  result and do **not** spawn the sidecar, UNLESS the user opts in with
  `assistants.cursor.allowPremiumOnDegraded: true` (then proceed param-less + a
  `system` MessageChunk noting premium-tier billing).
- This degraded case should be **rare**: §4's catalog keeps the last good
  snapshot **durably** (TTL only schedules a *refresh attempt*; a failed refresh
  keeps serving the stale snapshot). Truly-cold = first-ever run with no network.

**Why not the "full public param set" (finding 2 — dropped):** the SDK does not
report resolved params (`run.model` echoes the request — §0.3), so emitting all
public params cannot *prove* determinism. Worse, filling an un-requested param
from the catalog's default-variant value **pins a snapshot** that overrides the
server's own (possibly newer) default and asserts a value the user never asked
for. An un-set param already resolves to the model's current default under both
merge and replace semantics, so full-set adds risk with no benefit. Emit only
what is in play.

## 4. Module breakdown (under `packages/providers/src/community/cursor/`)

| File | Responsibility |
|---|---|
| `catalog.ts` (new) | `loadCursorCatalog({ stateRoot, apiKey, refresh })` — read disk cache; serve a **durable last-good snapshot** (TTL only schedules a refresh *attempt*; a failed refresh keeps serving the stale snapshot, never discards it); persist `fetchedAt` + (if available) a catalog hash, not just SDK version (finding 5 — SDK pin ≠ catalog freshness); **serialize refresh writes** (lock/temp+rename) so parallel sidecars don't race; expose cache age. `refresh` default = spawn `cursor-catalog.mjs` under node; injectable in tests. |
| `cursor-catalog.mjs` (new) | one-shot node helper: `Cursor.models.list()` → JSON on stdout. SDK stays in node. |
| `model-params.ts` (new) | pure `resolveCursorParams` + clamp table + `CursorModelParamsError`. |
| `config.ts` (edit) | parse `fast?: boolean`, `context?: string`, `allowPremiumOnDegraded?: boolean`. **Fail-loud on present-but-invalid** values for these keys (don't silently drop — `config.ts:13`); preserve key presence for provenance (`Object.hasOwn`). |
| `provider.ts` (edit) | load catalog; gather knobs + provenance; `resolveCursorParams`; on throw → `errorResult(..., 'cursor_model_params_unavailable')` (sidecar not spawned); on SDK param-rejection from a stale catalog → invalidate + refresh once + retry once, then fail (finding 5); put `modelParams` on `CursorRunnerConfig`. |
| `cursor-runner.mjs` (edit) | extract a **pure `buildAgentOptions(cfg)`** that returns `{ model: { id, ...(params?) }, local, ... }` for BOTH `Agent.create` and `Agent.resume` (line ~68/76) → unit-testable; line ~58 uses it (finding 6). |
| `capabilities.ts` (edit) | flip `effortControl: true`, `thinkingControl: true` — **applied LAST, after provider fail-loud is airtight** (finding 4: this removes the only user-visible generic warning, `dag-executor.ts:579`). |
| `effort.ts` (edit) | the `effortControl===true ⇔ EFFORT_MAPS[id]!=null` invariant (`effort.test.ts:64`) breaks for cursor — its effort mapping is per-model catalog-driven, not a static `EffortMap`. Add cursor to a **dynamic-catalog allowlist** the invariant exempts (preferred), rather than a misleading static row. |
| `types.ts` (edit) | extend `CursorProviderDefaults` with `fast?`, `context?`, `allowPremiumOnDegraded?`. |

The translation is pure TS reading a plain-JSON catalog → **fully unit-testable
in Bun**; the only SDK-touching code is the tiny node helper (injectable
`refresh` in tests).

## 5. Test-First Plan (write tests before each module)

### 5.1 `model-params.test.ts` (core; fixture catalog: composer-2.5, claude-opus-4-8, gpt-5.4, gemini-3-flash)
- effort Claude → `{id:'effort',value:'high'}`; effort GPT → `{id:'reasoning',value:'high'}` (id swap).
- effort `max` on gpt-5.4 (no max) → clamps to `extra-high`; on opus → stays `max`.
- **thinking all three states (finding 7):** `enabled`→`'true'`, `disabled`→`'false'`,
  `adaptive`→`'true'`; thinking on gpt-5.4 (no `thinking` param) → **throws**.
- fast false → `{id:'fast',value:'false'}`; **explicit** fast on gemini (no param) → **throws**;
  **implicit** fast on gemini → omitted (no throw).
- context `1m` on a 300k-max model → clamps to `300k`.
- **minimal emission (finding 2):** setting only `fast=false` on opus → output is
  EXACTLY `[{id:'fast',value:'false'}]` — does NOT fill `thinking`/`context`/`effort`,
  and never contains `cyber`.
- **hidden-param exclusion is a property of `parameters[]`, not one fixture
  (finding 8):** assert nothing outside the model's public `parameters[]` is ever
  emitted, across all fixtures.
- unknown model + a knob → **throws** `CursorModelParamsError`; unknown model + no
  knobs → `{ params: [] }`.

### 5.2 `catalog.test.ts`
- fresh cache within TTL → no `refresh()` call.
- expired TTL → schedules refresh; **refresh fails → still serves the durable stale
  snapshot** (finding 1/5 — never discards last-good).
- cold cache (no snapshot) + `refresh()` rejects → load failure (provider decides
  fail-closed vs opt-in, §3 degraded policy).
- **stale-within-TTL drift / param rejection (finding 5):** simulate the SDK
  rejecting a param the cached catalog blessed → invalidate + refresh once + retry
  once → then fail; assert exactly one refresh+retry.
- concurrent cold-cache callers → serialized writes, no torn/duplicated file.
- cache records + exposes `fetchedAt`/age.

### 5.3 `provider.test.ts` (extend; use existing `spawnRunner` seam)
- effort `high` on a gpt model → `cfg.modelParams` has `{id:'reasoning',value:'high'}`.
- explicit config `fast:false` → `cfg.modelParams` has `{id:'fast',value:'false'}`.
- catalog lacks the model + an **explicit** knob → `cursor_model_params_unavailable`,
  sidecar NOT spawned.
- **implicit default, catalog available:** no explicit knobs → `cfg.modelParams` is
  `[{id:'fast',value:'false'}]`.
- **implicit default, catalog DOWN, fail-closed (finding 1):** no explicit knobs,
  no last-good snapshot, `allowPremiumOnDegraded` unset → `cursor_model_params_unavailable`,
  sidecar NOT spawned.
- **opt-in premium-on-degraded:** same but `allowPremiumOnDegraded: true` → sidecar
  spawned param-less + a visible `system` MessageChunk noting premium billing.
- **explicit `fast:false` + catalog refresh failure (finding 8):** explicit ⇒
  fail-closed (distinct from implicit) — proves the provenance split.
- **mixed explicit effort + implicit fast + catalog DOWN (finding 8):** fails due to
  the **explicit effort**, not the implicit fast.
- **invalid explicit config value (finding 3/8):** `assistants.cursor.fast: "yes"` →
  `cursor_config_invalid` (not silently dropped).
- `assistants.cursor.fast: true` → `{id:'fast',value:'true'}` (opt into premium).
- **resume path:** `resumeSessionId` set + knobs → `cfg.modelParams` present on the
  resume call too.

### 5.4 `runner-options.test.ts` (finding 6 — pure `buildAgentOptions`)
- create (no `resumeSessionId`) with `modelParams` → `{ model:{ id, params } }`.
- resume (with `resumeSessionId`) with `modelParams` → same `{ model:{ id, params } }`
  shape passed to `Agent.resume`.
- no `modelParams` → `{ model:{ id } }` (no `params` key) — byte-for-byte today.
- (doc comment: changed params on a RESUMED agent may not take effect server-side —
  unobservable, §0.3.)

### 5.5 Stateful / capability
- `persist_session` re-run with CHANGED knobs: request-shape forwarded; comment notes
  resumed-agent re-application is unobservable.
- capability invariant test (finding 4): `effortControl===true` for cursor passes via
  the dynamic-catalog allowlist exemption in `effort.test.ts`, AND a test proves an
  unsupported explicit effort/thinking **errors before spawn** (so the removed DAG
  warning is compensated by provider fail-loud).

### 5.6 Generator/helper smoke (only when `CURSOR_API_KEY` present; skipped in CI)
- `cursor-catalog.mjs` prints valid JSON; `composer-2.5` has a `fast` param.

## 6. Acceptance Criteria / Success Metrics

A. **Translation (hermetic):** all §5.1 cases green — id-swap, max-clamp, all three
   thinking states, **minimal emission** (only in-play knobs, never `cyber` or other
   non-public params), and **fail-loud throws** for unsupported explicit knobs / unknown
   models.
B. **Catalog:** §5.2 green — TTL hit/miss, durable stale snapshot on refresh failure,
   serialized writes, and the param-rejection → invalidate+refresh+retry-once path.
C. **Wiring + fail-loud:** §5.3 green — knobs reach `cfg.modelParams`; explicit
   unsupported → error result + sidecar NOT spawned; provenance split proven
   (explicit `fast:false` fails-closed vs implicit fail-closed-unless-opt-in); invalid config →
   `cursor_config_invalid`; resume carries params.
D. **Honest observability:** docs + a code comment state resolved params / billed tier
   are NOT observable via the SDK (`run.model` echoes the request — proven). The live
   gate (`__cursor-live-gates.ts`, needs key) asserts only that effort/thinking/context/
   fast combos on composer-2.5, claude-opus-4-8, gpt-5.4 run **without** `cursor_error`
   (request-shape acceptance, NOT billed tier). **Metric:** 100% of combos accepted.
E. **Tier confirmation (manual, one-time):** Cursor dashboard shows a DEFAULT run bills
   **standard** (implicit `fast=false`) and `assistants.cursor.fast: true` bills **fast**.
   Only semantic proof of the tier change; out of the automated suite.
F. **Cost-safety + non-regression (finding 1/6):** `bun run validate` green; no new
   ESLint warnings; capability invariant green. The cost default **fails closed**, not
   open: with the catalog truly unavailable and no last-good snapshot, a default
   (implicit `fast=false`) run is BLOCKED with a visible error unless
   `allowPremiumOnDegraded: true` — it never silently bills premium. With a durable
   snapshot present (the normal case), runs proceed at standard.
G. **Docs:** cursor provider doc covers effort/thinking support, `assistants.cursor.fast`/
   `context`/`allowPremiumOnDegraded`, the fail-closed degraded behavior, the thinking
   state mapping, and the observability caveat. `CHANGELOG.md` notes the billing change.

## 7. Phasing

- **Phase 1 (this plan): mechanism + standard-tier default.** Live catalog +
  minimal fail-loud translation (explicit=fail-closed, implicit `fast=false`=
  fail-closed-unless-opt-in) + effort/thinking (per-node) + fast/context (config) +
  **default `fast=false`** + capabilities flip (applied last) + request-shape gate +
  docs. The default-tier change is called out in `CHANGELOG.md` (billing change:
  Cursor runs now bill standard, not premium, unless `assistants.cursor.fast: true`)
  and is revertible by flipping a single default constant.
- **Phase 2 (deferred): per-node fast/context + optional model-string suffix.**
  Requires stripping the suffix BEFORE `resolveModelSpec` in the shared resolver
  and validation that REJECTS suffixes on tier/alias refs (`model-validation.ts`).

## 8. Risks & Residual Unknowns

- **OQ2 (resolved differently):** we DON'T try to control merge-vs-replace. We emit
  only in-play knobs; un-set params keep the model's own current default under either
  semantic. Full-set was dropped (§3 "Why not the full public param set").
- **U1 — billing unobservable in-band.** `run.model` echoes the request (proven);
  accepted, dashboard-confirmed once (E). The live gate proves request-shape only.
- **U2 — catalog staleness/drift (finding 5).** A server-side catalog change without
  an SDK bump can make a within-TTL snapshot stale → mitigated by the param-rejection
  → invalidate+refresh+retry-once path, plus a recorded `fetchedAt`/age. A truly cold
  cache + dead network + a knob = **fail-closed** (explicit) or fail-closed-unless-opt-in
  (implicit `fast`), never silent premium.
- **R1 — value-vocab drift** (`xhigh`↔`extra-high`): centralized clamp table.
- **R2 — `models.list()` latency:** warm/stale runs do zero network; only a cold
  cache fetches. The durable snapshot means steady-state is network-free.
- **R3 — `adaptive` thinking → `'true'`** is a lossy judgment call (Cursor thinking is
  binary). Documented; revisit if Cursor adds graduated thinking.

## 9. Validation Commands
```bash
bun test packages/providers/src/community/cursor/model-params.test.ts
bun test packages/providers/src/community/cursor/catalog.test.ts
bun test packages/providers/src/community/cursor/provider.test.ts
CURSOR_API_KEY=... node packages/providers/src/community/cursor/cursor-catalog.mjs   # helper smoke
CURSOR_API_KEY=... bun packages/providers/src/community/cursor/__cursor-live-gates.ts # request-shape gate
bun run validate
```
