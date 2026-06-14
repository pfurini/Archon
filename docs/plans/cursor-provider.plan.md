# Cursor Provider (community) — Implementation Plan

**Branch:** `feat/cursor-provider` (worktree at `/Users/paolof/Developer/ai/archon-cursor-provider`,
forked off `feat/claude-terminal-provider` @ `336a2876`).
**Status:** DRAFT — awaiting approval.
**Reference impl:** `/Users/paolof/Developer/ai/gsd-pi` branch `feat/cursor-cli`
(`src/resources/extensions/cursor-cli/`) — a *Pi/GSD extension*, NOT an Archon provider.
We port its `@cursor/sdk` translation logic into an Archon `IAgentProvider`.

---

## 1. Goal

Add a **community** AI provider `cursor` (`builtIn: false`) under
`packages/providers/src/community/cursor/` that drives the **beta `@cursor/sdk`**
(`Agent.create → agent.send → run.stream()`) and implements Archon's
`IAgentProvider` contract — `sendQuery() : AsyncGenerator<MessageChunk>`,
`getType()`, `getCapabilities()`.

Lets an Archon user with a Cursor subscription / `CURSOR_API_KEY` run workflow
nodes and direct chat against Cursor-routed models (Composer, Claude, GPT, Gemini,
Grok) on one plan.

Structural template: the existing `community/claude-terminal/` provider (same
branch). Translation logic: ported + re-targeted from gsd-pi's `sdk-adapter.ts`
/ `sdk-types.ts` / `stream-translation.ts` / `partial-builder.ts` / `redact.ts`
/ `sdk-runtime.ts`.

---

## 2. Key facts established during research

### `@cursor/sdk` API (verified against 1.0.13 in gsd-pi; **latest npm = 1.0.18**)
- `sdk.Agent.create({ apiKey, model: { id }, local: { cwd, settingSources } }) → SdkAgent`
- `agent.send(prompt, { onDelta }) → Promise<SdkRun>`
- `run.stream() → AsyncGenerator<SdkMessage>`; `run.wait() → SdkRunResult`; `run.cancel()`
- `agent.close()`
- **Token usage** arrives ONLY via the `onDelta` `turn-ended` interaction update
  (camelCase: `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`).
  Not on `run.wait()`, not on any stream message.
- `apiKey` **must** be passed explicitly — v1.0.13 does NOT read
  `process.env.CURSOR_API_KEY` itself.
- `settingSources: ['project']` required, else the SDK turns every Cursor settings
  layer OFF (ignores `.cursor/rules` + `AGENTS.md`). Do **not** add `'user'` —
  triggers a cross-tool skill scan that balloons the prompt.
- SDK fires **detached background promise rejections** (e.g. `unauthenticated`
  ConnectError on a bad key) — in a long-lived Archon server these would hit the
  process crash guard. A rejection guard is mandatory.
- SDK message union: `system | assistant | user | tool_call | thinking | status
  | task | request | <unknown>`. `assistant` messages are **incremental text
  deltas**. `tool_call` carries `status` (`running|completed|error`), flat
  `args`, optional `result`.

### Archon contract (`packages/providers/src/types.ts`)
- `MessageChunk` variants we emit: `assistant{content}`, `thinking{content}`,
  `tool{toolName,toolInput?,toolCallId?}`, `tool_result{toolName,toolOutput,toolCallId?}`,
  `system{content}`, `result{sessionId?,tokens?,structuredOutput?,isError?,errorSubtype?,errors?,cost?,stopReason?,numTurns?}`.
- `ProviderRegistration`: `{ id, displayName, factory, capabilities, builtIn,
  credentials }` — `credentials` is **required** (#1955).
- Registration wiring: `registration.ts` exports `registerCursorProvider()`
  (idempotent via `isRegisteredProvider`), called from `registerCommunityProviders()`
  in `registry.ts`, re-exported from `community/cursor/index.ts` and
  `packages/providers/src/index.ts`.

### Streaming semantics (CRITICAL — verified, not inferred)
- `ClaudeProvider` (`claude/provider.ts:659`) emits `{type:'assistant', content:
  block.text}` — **one chunk per whole content block**, coarse-grained.
- `handleStreamMode` (`orchestrator-agent.ts:1511-1536`) accumulates via
  `allMessages.join('')` (no separator) **and** calls
  `platform.sendMessage(conversationId, msg.content)` **once per chunk**.
- ⟹ Emitting raw per-token Cursor deltas would fire one `sendMessage` per token
  → bubble/message spam. **We must coalesce.**

---

## 3. Locked design decisions

1. **Direct `SdkMessage → MessageChunk` mapping.** Skip gsd-pi's intermediate
   `CursorStreamEvent` layer (it existed to share a CLI pump we don't have).
2. **Coalesce assistant text.** Buffer contiguous SDK assistant deltas; flush as
   ONE `{type:'assistant'}` chunk at each boundary (a `tool_call`, `thinking`,
   `status` change, terminal, or `turn-ended`). Emit the **buffered segment**
   (delta since last flush), not cumulative — `handleStreamMode` concatenates.
   Keep a separate `fullText` total for structured-output extraction.
3. **`structuredOutput: 'best-effort'.'** Prompt-augment with the JSON schema +
   extract JSON from `fullText`. Consistent with #2 (full-text accumulator is
   needed either way). Mirrors `claude-terminal` / Pi. Validation + re-ask handled
   by the dag-executor's existing best-effort path.
4. **apiKey resolution:** `requestOptions.env?.CURSOR_API_KEY ?? process.env.CURSOR_API_KEY`,
   passed inline to `Agent.create` (never bound to a named var, never logged).
   This honors Archon's per-user key injection via `requestOptions.env`
   (process.env-only would silently use a shared key on multi-user installs).
5. **`installSdkRejectionGuard` is REQUIRED**, not optional — load-bearing crash
   guard for the long-lived server. Port from gsd-pi `sdk-runtime.ts`.
6. **Hard dependency** on `@cursor/sdk@^1.0.18` in `packages/providers/package.json`
   (consistent with pi/codex/opencode/claude SDKs all being hard deps). Use the
   real SDK types where stable; keep thin local structural mirrors only where the
   beta types are awkward. (Alternative — dynamic import + full mirrors, gsd-pi
   style — rejected: Archon's monorepo installs deps for everyone and the
   precedent is hard-dep.)
7. **`console` fence** (`enterSdkConsoleScope`/`exitSdkConsoleScope`, ported):
   keep — the SDK's settings-loader prints `console.*` INFO lines that would
   pollute CLI stdout / structured logs. Harmless on the server.
8. **PR base:** once `feat/claude-terminal-provider` merges into `personal`,
   rebase/target the eventual cursor PR onto **`personal`** so the diff does NOT
   carry claude-terminal's commits.

### Wired-only capabilities (Phase 1 — scope APPROVED: core + resume + mcp + sandbox)
```ts
export const CURSOR_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,       // WIRED: agentId persisted as result.sessionId; resume via
                             //   JsonlLocalAgentStore at a stable stateRoot (~/.archon/cursor/)
  mcp: true,                 // WIRED: node mcp: config → AgentOptions/SendOptions.mcpServers
  hooks: false,
  skills: false,             // workspace auto-load only, no per-node injection
  agents: false,             // feasible (AgentOptions.agents) but DEFERRED — out of Phase 1
  toolRestrictions: false,   // no per-call allow/deny surface exposed
  structuredOutput: 'best-effort',  // prompt-augment + extract from run.conversation() final text
  envInjection: false,       // local agents take no env map (only CloudAgentOptions.envVars)
  costControl: false,
  effortControl: false,      // would need per-model ModelSelection.params mapping — DEFERRED
  thinkingControl: false,
  fallbackModel: false,
  sandbox: true,             // WIRED: node sandbox → LocalAgentOptions.sandboxOptions.enabled
  nativeTools: false,        // ⟹ orchestrator appends the bash run-mgmt prompt for
                             //   project-scoped chat (same path as Codex/OpenCode/Copilot)
};
```
**Deferred (feasible, not in Phase 1):** inline `agents`, `effortControl`
(per-model params), `nativeTools` (SDKCustomTool host for `manage_run`).
Rule (per `capabilities.ts` doc + CLAUDE.md Fail-Fast): flags reflect WIRED
behavior. Don't claim a capability we haven't actually plumbed.

---

## 4. File structure (`packages/providers/src/community/cursor/`)

| File | Responsibility | Source |
|------|----------------|--------|
| `index.ts` | barrel exports | new (mirror claude-terminal) |
| `capabilities.ts` | `CURSOR_CAPABILITIES` | new |
| `config.ts` | `parseCursorConfig(assistantConfig)` → `{ model?, apiKey? }` + `CursorProviderDefaults` | mirror `claude-terminal/config.ts` |
| `provider.ts` | `CursorProvider implements IAgentProvider` — the SDK pump as an async generator yielding `MessageChunk` | new, logic from gsd-pi `sdk-adapter.ts` |
| `registration.ts` | `registerCursorProvider()` | mirror claude-terminal |
| `sdk-types.ts` | SDK message/agent/run type surface (real types where stable, thin mirrors otherwise) | port gsd-pi `sdk-types.ts` |
| `stream-translation.ts` | `translateSdkMessage(msg) → MessageChunk[]`, boundary/flush + terminal-result synthesis | port + re-target gsd-pi `stream-translation.ts` |
| `usage.ts` | `mapCursorUsage(CursorUsage) → TokenUsage`, `ZERO_USAGE` | from gsd-pi `partial-builder.ts` (usage part only) |
| `redact.ts` | `redactSecrets()` for every error string | port gsd-pi `redact.ts` |
| `sdk-runtime.ts` | `installSdkRejectionGuard()` (+ console guard) | port gsd-pi `sdk-runtime.ts` + `sdk-console-guard.ts` |
| `quota-detect.ts` | classify Cursor quota-exhaustion errors | port gsd-pi `quota-detect.ts` (optional Phase 1; nice-to-have) |
| `tests/provider.test.ts` | drive the pump with a fake SDK module; assert `MessageChunk` sequence | new |
| `tests/stream-translation.test.ts` | per-message-type mapping + coalescing + terminal synth | new |
| `tests/config.test.ts` | defaults parsing | mirror claude-terminal |
| `tests/redact.test.ts` | secret masking (Bearer/sk-/JWT/cursor-key) | port |

### `provider.ts` shape (sketch)
```ts
export class CursorProvider implements IAgentProvider {
  getType() { return 'cursor'; }
  getCapabilities() { return CURSOR_CAPABILITIES; }

  async *sendQuery(prompt, cwd, resumeSessionId?, requestOptions?): AsyncGenerator<MessageChunk> {
    installSdkRejectionGuard();              // load-bearing
    enterSdkConsoleScope();
    const cfg = parseCursorConfig(requestOptions?.assistantConfig ?? {});
    const model = requestOptions?.model ?? cfg.model;          // tier/alias already resolved upstream
    const apiKey = requestOptions?.env?.CURSOR_API_KEY ?? process.env.CURSOR_API_KEY;
    try {
      const agent = await sdk.Agent.create({
        apiKey,                              // inline, never stored
        model: model ? { id: model } : undefined,
        local: { cwd, settingSources: ['project'] },
      });
      let captured;                          // last turn-ended usage
      const run = await agent.send(prompt, {
        onDelta: ({ update }) => { if (update.type === 'turn-ended' && 'usage' in update) captured = update.usage; },
      });
      requestOptions?.abortSignal?.addEventListener('abort', () => void run.cancel().catch(() => {}), { once: true });

      const state = makeTranslationState();  // pendingText buffer + fullText + sessionId
      for await (const msg of run.stream()) {
        if (requestOptions?.abortSignal?.aborted) { /* flush + abort result */ break; }
        for (const chunk of translateSdkMessage(msg, state)) yield chunk;   // includes boundary flushes
      }
      // drain: flush trailing pendingText, run.wait(), synthesize terminal result
      const result = await run.wait();
      yield* finalizeResult(state, result, captured, model);
    } catch (err) {
      yield { type: 'result', isError: true, errorSubtype: 'cursor_error',
              errors: [redactSecrets(err instanceof Error ? err.message : String(err))] };
    } finally {
      try { agent?.close(); } catch {}
      exitSdkConsoleScope();
    }
  }
}
```

### Translation map (`stream-translation.ts`)
| SDK message | Action |
|-------------|--------|
| `system` (init) | capture `sessionId = run_id ?? agent_id`; no user-facing chunk |
| `assistant` (delta) | append text to `pendingText` + `fullText`; **no emit yet** |
| `thinking` | flush `pendingText` → `assistant` chunk; emit `{type:'thinking', content}` |
| `tool_call` `running`/`started` | flush `pendingText`; emit `{type:'tool', toolName:name, toolInput:args, toolCallId:call_id}` |
| `tool_call` `completed`/`error` | emit `{type:'tool_result', toolName:name, toolOutput:stringify(result), toolCallId:call_id}` |
| `status` CANCELLED/EXPIRED | flush; record non-terminal error (surfaced by terminal synth) |
| `user`/`task`/`request` | consumed silently |
| terminal (`run.wait()` + captured usage) | flush trailing `pendingText`; emit `{type:'result', sessionId, tokens:mapCursorUsage(captured), isError, structuredOutput?, stopReason}` |

---

## 5. Core wiring (minimal, outside the provider dir)

1. `packages/providers/package.json` — add `"@cursor/sdk": "^1.0.18"`.
2. `packages/providers/src/registry.ts` — `import { registerCursorProvider }` +
   call inside `registerCommunityProviders()`.
3. `packages/providers/src/index.ts` — re-export `registerCursorProvider`,
   `CURSOR_CAPABILITIES`, `parseCursorConfig`, `CursorProvider`.
4. **Credentials catalog** (in `registration.ts`):
   ```ts
   credentials: { kind: 'static',
     specs: [{ vendor: 'cursor', displayName: 'Cursor', kinds: ['api_key'] }] }
   ```
   New vendor id `cursor`. Provider-id validation in `model-validation.ts` is
   derived from the registry, so registering is sufficient for `provider: cursor`
   to be accepted in workflow YAML.
5. **Per-user key injection (multi-user only):** verify that vendor `cursor` →
   `CURSOR_API_KEY` is mapped wherever Archon turns a stored `user_provider_keys`
   row into `requestOptions.env`. If a vendor→env map must list `cursor`, add it.
   Solo/ambient installs work without this (SDK reads `process.env.CURSOR_API_KEY`).
   → integration task, see §7.

6. **Built-in tier defaults** — add a `"cursor"` block to
   `packages/workflows/src/defaults/tier-defaults.json` (same as claude-terminal
   got in commits `81bcb550` / `f1ee3403`). Maps the `small`/`medium`/`large`
   tier keywords → concrete Cursor model ids so `model: large` resolves without
   user config. **Mapping (user-specified; CONFIRM exact ids via `Cursor.models.list()`
   at impl — these are best-guess ids, not yet verified against Cursor's catalog):**
   ```json
   "cursor": {
     "small":  { "model": "gemini-3.5-flash" },  // Gemini 3.5 Flash (CONFIRM id)
     "medium": { "model": "composer-2.5" },        // Cursor-native Composer 2.5
     "large":  { "model": "gemini-3.1-pro" }       // Gemini 3.1 Pro (CONFIRM id)
   }
   ```
   Notes: plain model ids (NO `[1m]` suffix — that's Claude-SDK syntax). No
   `effort` keys (effortControl deferred). The Gemini ids follow Cursor's
   observed convention (`gemini-2.5-pro` in the gsd-pi seed) but Gemini 3.x is
   newer than any local reference — **must** be validated at impl: run a
   `Cursor.models.list()` probe (needs `CURSOR_API_KEY`) and correct the ids if
   they differ. If this JSON is embedded in the compiled bundle,
   `bun run validate` / `check:bundled` will flag staleness — run
   `bun run generate:bundled` if required.

No changes to `@archon/web` generated types are needed for the provider to
function; `GET /api/providers` surfaces it automatically from the registry.

---

## 6. Testing

- **Unit:** fake `SdkModule` (Agent/Run stubs that emit a scripted `SdkMessage`
  sequence) → assert the exact `MessageChunk[]` from `sendQuery`. Cover: text-only
  turn, text+tool+text (coalescing across the tool boundary), thinking, error
  status, usage on `turn-ended`, abort mid-stream, bad-key rejection path.
- **stream-translation:** table-driven per message type + the boundary/flush logic
  + terminal synthesis with/without captured usage.
- **redact:** Bearer / `sk-` / `cursor-key-` / JWT masking.
- **config:** defaults parsing + override precedence.
- Add the cursor test files to the `@archon/providers` test script split if they
  use `mock.module()` on a path another file also mocks (mock-pollution rule).
- `bun run validate` (type-check, lint, format, tests, bundled/schema checks) green.
- Optional: a `e2e-cursor-smoke` default workflow (mirror `e2e-pi-smoke`) gated to
  manual/credentialed runs — added only if we want CI/manual parity.

---

## 7. Implementation order

1. **Verify `@cursor/sdk@1.0.18` API** — install, confirm `Agent.create` / `send`
   / `run.stream` / `run.wait` / `run.cancel` signatures and the `onDelta`
   `turn-ended` usage shape still hold (1.0.13 → 1.0.18 drift check). Adjust
   `sdk-types.ts`. **Gate: do not freeze translation until confirmed.**
2. Port leaf utils: `redact.ts`, `sdk-runtime.ts` (+console guard), `usage.ts`,
   `sdk-types.ts`, `quota-detect.ts`. + their tests.
3. `capabilities.ts`, `config.ts` (+ tests).
4. `stream-translation.ts` — mapping + coalescing + terminal synth (+ tests).
5. `provider.ts` — the pump (+ tests with fake SDK).
6. `registration.ts` + `index.ts`; wire `registry.ts` + providers `index.ts` +
   `package.json` dep.
7. Manual smoke: real `CURSOR_API_KEY`, run a `prompt:` node + a direct chat turn
   in the worktree app; confirm streaming renders as coherent text (no per-token
   spam), tool calls render, usage shows, session/`result` clean.
8. `bun run validate`. Then `/release`-independent PR onto `personal` (post-merge).

---

## 8. Open questions — RESOLVED via `@cursor/sdk@1.0.18` type defs

Probed the published 1.0.18 tarball (`options.d.ts`, `agent.d.ts`, `run.d.ts`,
`messages.d.ts`, `vendor/.../delta-types.d.ts`). The 1.0.13 mirrors gsd-pi used
still match; 1.0.18 is a **superset**. Core API confirmed:
`Agent.create({apiKey,model:{id},local:{cwd,settingSources}})` → `agent.send(prompt,{onDelta})`
→ `run.stream():AsyncGenerator<SDKMessage>` / `run.wait():RunResult` / `run.cancel()`.
`SDKMessage` union = `system|user|assistant|tool_call|thinking|status|request|task`
(exactly the mirrored shapes). `RunResult` has **no** usage. Sole usage channel =
`onDelta` `turn-ended` (`{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}`,
`TurnEndedUpdateSchema`). ⟹ translation + usage mapping in §4 are correct.

1. **Session resume — FEASIBLE (first-class).** Persistence is core: `agentId` +
   a `LocalAgentStore` (default SQLite under `stateRoot`, or `JsonlLocalAgentStore`).
   `Agent.get/list/resume` route by agentId (`bc-`→cloud, else local store).
   To wire: emit `agentId` as the Archon `result.sessionId`; on resume recreate the
   agent against the **same store + agentId**. Cost: needs a **stable store root**
   (worktrees are ephemeral) — e.g. `~/.archon/cursor/<codebase>/`. → `sessionResume`
   can be `true` **iff** we wire agentId persistence + stable `stateRoot`. **Scope
   decision needed** (see §10).
2. **Env injection — NO (local).** `LocalAgentOptions` has no env field; only
   `CloudAgentOptions.envVars` (cloud only). Local tool execution can't take
   per-project/per-call injected env. ⟹ `envInjection: false` is correct. (The SDK
   process inherits Archon's ambient `process.env`, but that's not scoped injection.)
3. **Effort / reasoning — via `ModelSelection.params`.** `model: { id, params?:
   [{id,value}] }`; models advertise `parameters`/`variants` through
   `Cursor.models.list()`. Effort = a per-model param (e.g. reasoning level) when the
   model exposes one — dynamic, not a global field. ⟹ `effortControl` is wireable as
   a best-effort param mapping later; **`false` for Phase 1**.
4. **Default model.** Still open (product choice). `config.ts` default e.g. a
   Cursor-routed Sonnet, or `composer` for cost; or require explicit `model:`.
   Built-in tier defaults optional (claude-terminal added some).
5. **MCP / sandbox / inline agents — ALL FEASIBLE (richer than expected).**
   - `mcp: true` — `AgentOptions.mcpServers` / `SendOptions.mcpServers` (stdio/http/sse).
   - `sandbox: true` — `LocalAgentOptions.sandboxOptions: { enabled }`.
   - `agents: true` — `AgentOptions.agents: Record<string, AgentDefinition>` (inline subagents).
   - `nativeTools` — `SDKCustomTool` (in-process `custom-user-tools` MCP) could host
     Archon's `manage_run`; bigger lift, keep `false` Phase 1.
   - structured output: prefer `run.conversation(): ConversationTurn[]` to read the
     final assistant text for JSON extraction (cleaner than scraping deltas).
   **Scope decision needed**: which of mcp/sandbox/agents land in Phase 1 vs defer (§10).

## 9b. Native-dependency / bundling RISK (new — surfaced by the probe)

`@cursor/sdk@1.0.18` deps: **`sqlite3` (native)**, `@connectrpc/connect`,
`@connectrpc/connect-node`, `@statsig/js-client`, `@bufbuild/protobuf`, `zod`.
Tarball 2.8 MB / 198 files. The **default `LocalAgentStore` is SQLite**.

- **Binary builds:** Archon compiles via `bun build --compile`. Native `sqlite3`
  (node-gyp/prebuilt `.node`) typically does **not** bundle into a bun single-file
  binary → could break compiled Archon when the cursor module's dep graph loads.
- **Mitigations:** (a) use `JsonlLocalAgentStore` (pure JS) via
  `Cursor.configure({ local: { store } })` / per-call `local.store` to avoid the
  SQLite *runtime* path; (b) **verify `bun build --compile` still succeeds** with
  `@cursor/sdk` present even when sqlite3 is unused — make this an explicit gate;
  (c) cursor is `builtIn:false` (opt-in), limiting blast radius. If bundling can't
  be made clean, keep cursor **source-only** (not in the compiled binary) and
  document that.

---

## 10b. Fresh-session bootstrap / handoff

This plan is self-contained. A clean session can implement from it:

1. `cd /Users/paolof/Developer/ai/archon-cursor-provider` (worktree, branch
   `feat/cursor-provider`).
2. Read this plan top-to-bottom.
3. **Archon templates to mirror** (same repo):
   `packages/providers/src/community/claude-terminal/` —
   `registration.ts`, `capabilities.ts`, `config.ts`, `index.ts` (structure);
   `packages/providers/src/codex/provider.ts` (`sendQuery` async-generator +
   `streamCodexEvents` MessageChunk emission, ~line 338/733);
   `packages/providers/src/types.ts` (`IAgentProvider`, `MessageChunk`,
   `ProviderRegistration`); `packages/providers/src/registry.ts`
   (`registerCommunityProviders`).
4. **gsd-pi logic to port** (different repo, `feat/cursor-cli` branch):
   `/Users/paolof/Developer/ai/gsd-pi/src/resources/extensions/cursor-cli/` —
   `sdk-adapter.ts` (pump), `stream-translation.ts`, `partial-builder.ts`
   (usage), `redact.ts`, `sdk-runtime.ts`, `sdk-console-guard.ts`,
   `quota-detect.ts`. Re-target their output from GSD `AssistantMessageEvent`
   → Archon `MessageChunk`.
5. **`@cursor/sdk@1.0.18` types** — re-pack to read the real `.d.ts`:
   `npm pack @cursor/sdk@1.0.18` → untar → `package/dist/esm/{options,agent,run,
   messages}.d.ts` + `vendor/cursor-sdk-shared/delta-types.d.ts`
   (`TurnEndedUpdateSchema`). Key shapes already captured in §2 / §8.
6. Follow §7 implementation order. Validate with `bun run validate`.

## 9. Out of scope (Phase 1)

- CLI `cursor-agent --output-format stream-json` NDJSON path (gsd-pi Phase 1) —
  we go straight to the SDK per the user's request.
- `/cursor` slash commands, doctor metrics, cross-vendor failover, cloud agents.
- The gsd-pi `UPSTREAM_REVIEW:A/B/C` fork-only features — those are GSD-specific.
