# Cursor Provider — Node-Sidecar Execution Runtime (Phase 2) — Implementation Plan

**Branch:** `feat/cursor-provider` (main repo at `~/Developer/ai/archon`, currently on this branch).
**Status:** READY — root cause proven, fix validated end-to-end by a spike against the real failing worktree.
**Supersedes:** two locked decisions in `docs/plans/cursor-provider.plan.md` — see §9.
**Scope question answered:** *Yes — switch to `SqliteLocalAgentStore` (the SDK default).* It natively resolves
the multi-process write race the sidecar introduces, and works under Node (its native runtime). Rationale +
proof in §4.

---

## 1. TL;DR / Goal

The cursor provider's tools (Read/Grep/Shell) **hang forever** in any git repository when the
`@cursor/sdk` runs **in-process under Bun** (which is how Archon runs). They work perfectly when the
SDK runs under **Node**. Since Archon executes every workflow inside a git worktree, the provider is
currently unusable for real runs.

**Fix:** execute the SDK in a short-lived **Node child process** (a "sidecar"). The Bun parent
(`CursorProvider`) spawns `node cursor-runner.mjs`, passes the request via stdin + env, the child runs
`Agent.create → send → run.stream()` and forwards raw `SDKMessage`s as JSONL on stdout, and the parent
runs our **existing, unchanged** `translateSdkMessage` / `finalizeResult` to yield `MessageChunk`s.

This was **proven by a spike** (see §5): against the real `…/lexup-new/worktrees/archon/task-fix-issue-40`
git worktree, `read` + `grep` + `shell` all completed and returned a clean `result` chunk
(`tool_results=2`, `isError=false`), where the in-process Bun path hung.

---

## 2. Root cause (proven, not inferred)

The user reported: *"Could not read live files (Read/Grep/Shell all failed in this session)"* in cursor
workflow runs (run ids `f19470b6-…`, `fa1d5246-…`). Investigation (all reproduced locally with a real
`CURSOR_API_KEY`):

| Test | Result |
|------|--------|
| Plain non-git dir | tools **work** |
| Any git repo (1-file `git init`) | tools **hang** — `tool_call` stuck `status=running`, never `completed`/`error` |
| Git worktree (`.git` is a file pointer) | hangs too |
| Same dir, remove `.git` | **works** (controlled isolation: `.git` is the trigger) |
| Sandbox on / off / omitted | no effect |
| `settingSources: ['project']` vs `[]` | no effect (only changes context size) |
| Fake/short-circuit **all** spawned `git` commands | still hangs (so not the git-CLI detection) |
| `node:fs` / `node:fs/promises` reads of `.git` | **zero** (only `.gitignore` `access()` checks) |
| **Same SDK call under Node instead of Bun** | **WORKS** — `running → completed`, `finished` in ~2s |

**Conclusion:** it is a **Bun ↔ `@cursor/sdk` runtime incompatibility**, NOT a Cursor server bug, NOT
`rg`/`cursorsandbox`, NOT proprietary `.git` handling. The `.git` presence merely selects a heavier
code path in the SDK's tool runtime (extra async/child-process/stream machinery) that **deadlocks under
Bun**; a plain dir avoids that path so it "worked" under Bun. The error string the model reported
("Tool failed; this may be temporary") is the model's own narration after the tool never resolves — it
is not in the SDK package (server/agent-loop side).

The "Tool failed in git repos" symptom is in the same family as Cursor forum bug #157606 (`.git` causes
hangs) and #161855 (SDK local agents `realpath()`/git-root mis-scoping), but the actionable finding for
us is the Bun-vs-Node split.

> Two earlier conclusions were WRONG and are corrected here: it is not "server-side / unpatchable", and
> it is not the sandbox. The Node A/B test is the decisive evidence.

---

## 3. Architecture (validated)

```
CursorProvider.sendQuery()  [Bun, in Archon's process]
  │  build effectivePrompt (incl. shell workingDirectory directive), resolve model/apiKey/mcp/sandbox
  │  resolve node binary (Bun.which('node'))
  ▼
  spawn  node  packages/providers/src/community/cursor/cursor-runner.mjs
      ├─ stdin  : one JSON line { prompt, cwd, model, resumeSessionId, storeRoot, settingSources,
      │                           mcpServers?, sandbox? }
      ├─ env    : CURSOR_API_KEY (+ inherited)
      └─ stdout : JSONL, one object per line:
                   { "kind":"agent", "agentId": "agent-…" }
                   { "kind":"msg",   "message": <raw SDKMessage> }   // many
                   { "kind":"final", "status": "finished|error|cancelled", "result"?, "usage"? }
                   { "kind":"error", "message": "…" }                // on throw
  │  read stdout line-by-line →
  │    kind=agent → state.sessionId = agentId
  │    kind=msg   → translateSdkMessage(message, state)  → yield MessageChunk[]   (UNCHANGED logic)
  │    kind=final → finalizeResult(state, {result, sessionId, usage, structuredOutput}) → yield
  │    kind=error → yield { type:'result', isError:true, errorSubtype:'cursor_error', errors:[…] }
  ▼
  abort → proc.kill(); SDK's detached rejections die with the child (no parent crash-guard needed)
```

Key properties:
- The **Bun parent never imports `@cursor/sdk`** → the native-`sqlite3` `bun build --compile` crash is
  sidestepped *in the parent*; only the Node child loads the SDK (it needs `node_modules` → source
  installs, consistent with cursor being source-only).
- The SDK's detached background rejections are **isolated in the child** → the load-bearing
  `installSdkRejectionGuard` is **no longer needed in the long-lived server** (it dies with the child).
- The console fence moves **into the runner** (redirect `console.*` → stderr) so stdout stays pure JSONL.
- `translateSdkMessage` / `finalizeResult` / `usage.ts` / `redact.ts` / `capabilities.ts` / `config.ts`
  are **unchanged**.

---

## 4. Storage decision — SWITCH to `SqliteLocalAgentStore` (the SDK default)

**Answer to "should we swap the cursor SDK to SQLite now?": Yes.**

Phase 1 chose `JsonlLocalAgentStore` for ONE reason: to dodge the native-`sqlite3`
`bun build --compile` crash. The Node sidecar eliminates that reason (the SDK — and its sqlite3 — now
load under Node, never in the compiled Bun binary's process). With that gone, SQLite is the better
choice **specifically because of the new concurrency model the sidecar introduces.**

### 4a. The new risk the sidecar introduces — and why SQLite resolves it

In-process (Phase 1) all agents shared **one store instance in one Bun process** — writes coordinate
in-memory. With the sidecar, each run is a **separate Node process**, and parallel DAG cursor nodes mean
**multiple processes writing one shared store concurrently.**

`JsonlLocalAgentStore` writes **fixed shared append logs** (verified empirically):

```
<root>/agents.ndjson   <root>/checkpoints.ndjson (~40KB for a 1-turn run)   <root>/runs.ndjson   <root>/run_events.ndjson
```

Multiple processes appending to the same ndjson files (records far exceeding the atomic-append size) →
interleaved/corrupt records. To make JSONL safe you'd have to invent per-scope store dirs + thread a
stable scope key through the provider contract — extra moving parts.

`SqliteLocalAgentStore` (verified under Node, see §4b) lays out:

```
<stateRoot>/index.db          ← single SQLite database (file-locked: concurrent multi-process writes serialized)
<stateRoot>/<per-agent checkpoint dirs>   ← no shared-file contention
```

SQLite's locking is *designed* for exactly this — concurrent writers from multiple processes are
serialized (worst case a retryable `SQLITE_BUSY`, never corruption), and checkpoints are per-agent. So a
**single stable `stateRoot` (`getArchonHome()/cursor/store`) is concurrency-safe as-is** — resume finds
any agent via `index.db`, parallel nodes don't corrupt it, and **no contract change / no scope-key
threading is needed.** This is simpler *and* safer than the JSONL workaround.

### 4b. Correct API (verified under Node)

```js
import { SqliteLocalAgentStore } from '@cursor/sdk';
const store = await SqliteLocalAgentStore.open({
  workspaceRef: cwd,                         // REQUIRED — workspace path; used for cwd scoping + default state root
  stateRoot: join(getArchonHome(), 'cursor', 'store'),  // explicit stable root (overrides the cwd-derived default)
});
// … pass `store` as local.store to Agent.create / Agent.resume; await store.dispose() when done.
```

- `.open()` takes an **options object** `{ workspaceRef, stateRoot? }` — NOT a path string. (My earlier
  `.open('/path')` crash was passing a string → `workspaceRef` undefined → `getDefaultSdkStateRoot(undefined)`
  hashed undefined. Correct call confirmed working under Node: opens `index.db`, `agents.list()` runs.)
- `workspaceRef` = the run cwd (the worktree). `stateRoot` = the stable Archon root, so the DB persists
  across ephemeral worktrees (resume by `agentId` reads `index.db` at the stable root).
- Native `sqlite3` loads fine under Node (it even loaded under interpreted Bun; only `bun build --compile`
  broke it — and the sidecar runs under Node, so that path never applies).

> Net: storage switches to the SDK-default SQLite store at a single stable `stateRoot`. It resolves the
> multi-process race natively. JSONL is dropped (it was only ever a bun-compile workaround).

---

## 5. The proven spike (reference implementation — port verbatim)

The spike below ran green against the real worktree. Treat it as the contract; do not re-derive it.

### 5a. `cursor-runner.mjs` (Node sidecar)

```js
// Keep stdout PURE JSONL: the SDK writes settings-loader INFO lines to console.* — redirect to stderr.
for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
  console[m] = (...a) => process.stderr.write('[sdk] ' + a.map(String).join(' ') + '\n');
}
import { Agent, SqliteLocalAgentStore } from '@cursor/sdk';

const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

let store;
try {
  const cfg = await readStdin();
  // SDK-default SQLite store at a stable stateRoot (concurrency-safe across sidecar processes; §4).
  store = await SqliteLocalAgentStore.open({ workspaceRef: cfg.cwd, stateRoot: cfg.stateRoot });
  const opts = {
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: cfg.model },
    local: { cwd: cfg.cwd, settingSources: cfg.settingSources ?? ['project'], store,
             ...(cfg.sandbox ? { sandboxOptions: { enabled: true } } : {}) },
    ...(cfg.mcpServers ? { mcpServers: cfg.mcpServers } : {}),
  };
  const agent = cfg.resumeSessionId ? await Agent.resume(cfg.resumeSessionId, opts) : await Agent.create(opts);
  emit({ kind: 'agent', agentId: agent.agentId });

  let usage;
  const run = await agent.send(cfg.prompt, {
    onDelta: ({ update }) => { if (update?.type === 'turn-ended' && update.usage) usage = update.usage; },
  });
  for await (const msg of run.stream()) emit({ kind: 'msg', message: msg });
  const res = await run.wait();
  emit({ kind: 'final', status: res.status, result: res.result, usage });
  try { agent.close(); } catch {}
  try { await store?.dispose(); } catch {}
  process.exit(0);
} catch (err) {
  emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
  try { await store?.dispose(); } catch {}
  process.exit(1);
}
```

Notes: `cfg.stateRoot` = `join(getArchonHome(),'cursor','store')` (passed by the parent — the child should
not recompute Archon paths). Large tool results = very long JSONL lines — fine, `JSON.stringify` escapes
embedded newlines so newline-framing holds. The parent must buffer partial chunks and split on `\n`.

### 5b. Bun parent driver (lives in `provider.ts`)

Spawn via `Bun.spawn(['node', runnerPath], { env, stdin:'pipe', stdout:'pipe', stderr:'inherit' })`,
write the config JSON + `stdin.end()`, then read `stdout` with a `TextDecoder` + newline buffer. For
each parsed line: `agent`→ set `state.sessionId`; `msg`→ `translateSdkMessage`; `final`→
`finalizeResult` (build a `RunResult`-shaped `{id, status, result}`); `error`→ yield an `isError`
result. `await proc.exited` after the stream drains (avoids the EPIPE seen when the parent stops reading
early — drain fully). On `abortSignal`: `proc.kill()` then yield the aborted result.

---

## 6. File-by-file changes

| File | Change |
|------|--------|
| `community/cursor/cursor-runner.mjs` | **NEW.** The Node sidecar (§5a). Plain `.mjs` (no TS build step needed; runs under `node`). Must sit where `node` resolves `@cursor/sdk` from `packages/providers/node_modules` (this location does). |
| `community/cursor/provider.ts` | **REWRITE the execution core.** Replace the in-process `loadSdk()` + `Agent.create/send/run.stream` with the Node-sidecar driver (§5b). Keep: config/model/apiKey resolution, `resolveOutputSchema`, the **shell `workingDirectory` directive** (prompt-building, runtime-agnostic — keep), MCP loading via `loadMcpConfig` (resolve in parent, pass `mcpServers` to child), sandbox flag, `translateSdkMessage`/`finalizeResult` usage, abort handling, logging. Compute `stateRoot = join(getArchonHome(),'cursor','store')` and pass it (+ `cwd` as `workspaceRef`) to the child for the SQLite store (§4). Inject the spawn via a `CursorProviderDeps` seam (see §10). |
| `community/cursor/sdk-runtime.ts` | **RETIRE from the parent.** `loadCursorSdk`, `installSdkRejectionGuard`, `looksLikeCursorSdkError`, `isTransientTransportRejection` are no longer used in-process (SDK left the Bun process). Delete the file and its test, OR keep only if something still imports it (nothing should). The transient-rejection log-level fix (commit `43f2eaa3`) is **mooted** — the SDK's rejections now occur in the child; document this in the commit msg rather than silently dropping it. |
| `community/cursor/sdk-console-guard.ts` | **RETIRE from the parent** (the fence now lives in `cursor-runner.mjs`). Delete file + test unless still referenced. |
| `community/cursor/sdk-types.ts` | **KEEP** — `translateSdkMessage`/`finalizeResult` still need `SDKMessage`/`RunResult`/`CursorUsage` types. Drop the `CursorSdkModule` type (no longer dynamically imported). |
| `community/cursor/capabilities.ts`, `config.ts`, `usage.ts`, `redact.ts`, `stream-translation.ts`, `registration.ts`, `index.ts` | **UNCHANGED** (config gains nothing; index drops the retired exports). |
| `community/cursor/index.ts` | Drop exports of retired modules. |
| `packages/providers/src/index.ts` | Drop any re-exports of retired `sdk-runtime` symbols if present (none are currently re-exported beyond the provider/config/caps). |
| `packages/providers/src/types.ts` | **No change needed.** SQLite at a single stable `stateRoot` is concurrency-safe without per-scope keying, so no `sessionScopeKey` contract addition (this is the simplification SQLite buys us vs the JSONL workaround). |
| `package.json` (providers) | The cursor test split already runs `bun test src/community/cursor/`; keep. `@cursor/sdk` stays a dependency (the child resolves it). |
| `docs/.../ai-assistants.md` | Update the cursor caveat: source/`bun run` install required (now because of the Node sidecar, not only sqlite); requires `node` on PATH. |

---

## 7. Failure-mode remap

The parent no longer imports the SDK, so `cursor_sdk_unavailable` changes meaning:
- **Node missing / not on PATH:** `Bun.which('node')` → null → fail fast with a clear `result`
  (`errorSubtype: 'cursor_node_unavailable'`, message: "The Cursor provider runs the SDK in a Node
  subprocess; `node` was not found on PATH. Install Node, or run Archon from a source/`bun run` install.").
- **Sidecar spawn/exit failure** (e.g. `@cursor/sdk` not installed in the child's `node_modules`,
  runner throws before first line): the child emits `{kind:'error'}` and/or exits non-zero → parent
  yields `isError` result with the captured stderr tail (redacted via `redactSecrets`).
- `cursor_auth_missing` (no `CURSOR_API_KEY`) and `cursor_model_required` paths: keep, evaluated in the
  parent before spawning.

---

## 8. The shell `workingDirectory` directive (KEEP)

Commit `09ce364e` prepends a directive telling the model to set `workingDirectory` on Shell calls
(upstream SDK quirk: Shell returns empty without it). This is **prompt building**, runtime-agnostic →
**keep it in the parent** (it goes into `cfg.prompt`). The spike confirmed shell completes under Node;
the directive remains cheap insurance.

---

## 9. What this supersedes in `cursor-provider.plan.md`

- **Decision #6 ("Hard dependency + static/direct import of `@cursor/sdk`")** → superseded. The SDK is
  no longer imported into the Bun process at all; it is loaded by the Node sidecar. `@cursor/sdk` stays
  a `dependencies` entry (the child resolves it).
- **§9b / decision #2 ("use `JsonlLocalAgentStore` to dodge the `bun build --compile` sqlite crash")** →
  fully reversed. The Node sidecar removes the bun-compile constraint, and the sidecar's multi-process
  access makes the SDK-default `SqliteLocalAgentStore` the correct choice (native write-locking + per-agent
  checkpoint dirs). Switch to SQLite at a single stable `stateRoot` (§4). JSONL is dropped.
- The dynamic-loader + rejection-guard design (`sdk-runtime.ts`) → retired (§6).

Add a one-line "Superseded by `cursor-node-sidecar.plan.md`" note at the top of
`cursor-provider.plan.md` when this lands.

---

## 10. Tests

- **`provider.test.ts` (rework the seam):** the current `CursorProviderDeps.loadSdk` fake becomes a
  **runner-spawn fake**. Inject a `spawnRunner?: (cfg) => AsyncIterable<string>` (or a child-process
  factory) that yields scripted JSONL lines, so the pump is tested with no real `node`/SDK. Re-use the
  existing scenarios: coalesced text turn; text→tool→text coalescing; resume (assert `resumeSessionId`
  forwarded in cfg); best-effort structured output (`fullText` extraction); abort (parent kills child,
  yields aborted result); sidecar error line → `isError` result; **node-missing → `cursor_node_unavailable`**;
  MCP + sandbox flags forwarded into cfg; `stateRoot` + `workspaceRef` (cwd) forwarded into cfg.
- **`stream-translation.test.ts`, `config.test.ts`, `redact.test.ts`:** carry over **unchanged**
  (the translation/coalescing/usage/redaction logic is identical).
- **Delete** `sdk-runtime.test.ts` + `sdk-console-guard` references (retired modules).
- Keep the cursor suite in the `@archon/providers` package test split (`bun test src/community/cursor/`).
- All of `bun run validate` must pass (type-check, lint, format, generated checks, tests).

---

## 11. Verification gates (run with a real `CURSOR_API_KEY`)

- **G1 — Unit:** `bun test packages/providers/src/community/cursor/` green (fake runner).
- **G2 — Live single turn (git repo):** a `prompt:` node against a git worktree → assistant text +
  `read`/`grep`/`shell` `tool_result`s + clean `result` (`isError:false`). This is the spike, now
  through the real provider.
- **G3 — Resume:** two turns; second passes the first's `result.sessionId` → recalls prior context;
  `result.sessionId` stable.
- **G4 — Parallel-load concurrency (validates §4 SQLite choice):** run ≥3 cursor nodes **concurrently**
  in one DAG layer (shared `stateRoot`) → all succeed; `index.db` stays valid; resume each afterwards.
  Expect SQLite locking to serialize writes cleanly. If `SQLITE_BUSY` surfaces under load, confirm the
  store sets a `busy_timeout` (or add a small retry around `Agent.create`) — but corruption must not occur.
- **G4b — Resume across worktree recreation:** ❌ **Disproven empirically (2026-06-15).** The §4b
  assumption that resume "routes via `index.db` at the stable root, not the ephemeral cwd" is FALSE.
  The `@cursor/sdk` keys `Agent.resume` by the agent's `local.cwd`: a changed cwd throws
  `AgentNotFoundError` (`code: 'agent_not_found'`), and this is independent of `workspaceRef` (verified
  with both `workspaceRef = cwd` and a constant `workspaceRef`). Even same-path teardown+recreate loses
  recall. **Resume only works for sequential turns in the same persistent worktree (G3).** Archon's
  worktree paths are deterministic per conversation/branch, so in-conversation resume is correct; cross
  worktree-lifecycle resume is an SDK limitation, now documented in `ai-assistants.md`. The stable
  `stateRoot` / SQLite choice remains correct — it is what makes G4 (concurrency) pass and persists the
  store across process restarts; only the cross-cwd resume claim was wrong.
- **G5 — Node-missing path:** simulate `Bun.which('node')` → null → `cursor_node_unavailable` result,
  process does not crash.
- **G6 — `bun run validate`** green.
- **G7 — Manual end-to-end** via the web API / CLI on a real worktree (a `prompt:` node + a direct chat
  turn) — coherent streamed text (coalesced, no per-token spam), tools render, usage shows.

---

## 12. Rollback

The change is contained to `packages/providers/src/community/cursor/` + (optionally) a small additive
contract field. Revert the provider rewrite to restore the in-process path (known-broken in git repos,
but no blast radius beyond cursor — `builtIn:false`, opt-in). No DB/schema changes. No effect on other
providers.

---

## 13. Fresh-session bootstrap

1. `cd ~/Developer/ai/archon` (on `feat/cursor-provider`; the cursor work is committed here, no longer a
   worktree). Confirm `node --version` (v24 present) and `@cursor/sdk@1.0.18` in
   `packages/providers/node_modules`.
2. Read this plan + skim `docs/plans/cursor-provider.plan.md` (Phase 1) for the provider's existing
   shape and the contract (`@archon/providers/types`: `IAgentProvider`, `MessageChunk`,
   `SendQueryOptions`).
3. Mirror the proven spike (§5) — it is working code, not pseudocode.
4. Implement §6 file-by-file; resolve the scope-key call sites for §4a (grep
   `getAgentProvider(...).sendQuery` and the orchestrator chat path).
5. Tests §10; gates §11; update docs + supersede note (§9).
6. The earlier investigation proved the core facts (Bun-hang vs Node-works; JSONL = shared ndjson append
   logs → racey under the sidecar; `SqliteLocalAgentStore.open({workspaceRef, stateRoot})` works under
   Node and is multi-process-safe via `index.db` locking) — do not re-litigate them; re-verify via gates.

### Out of scope (Phase 2)
- The 125-skill / 377K-token context bloat from `settingSources: ['project']` in skill-heavy repos
  (a cost/perf concern, separate from correctness; forum #161855). Consider a follow-up to narrow
  setting sources or document the cost.
- Reporting the Bun-incompatibility upstream to Cursor (draft exists at
  `/tmp/cursor-sdk-git-tools-bug.md`; reframe as "tool runtime deadlocks under Bun in git repos,
  works under Node").
```
