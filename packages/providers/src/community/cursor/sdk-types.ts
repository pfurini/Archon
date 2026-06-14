/**
 * `@cursor/sdk` type surface for the cursor provider.
 *
 * `@cursor/sdk` is a real dependency, so we use `import type` for the SDK's
 * shapes (erased at build — they never trigger a runtime module load). The
 * RUNTIME values (`Agent`, `JsonlLocalAgentStore`) are NOT imported here: the
 * SDK statically top-level-imports native `sqlite3`, which cannot load inside a
 * `bun build --compile` single-file binary (sqlite3's `bindings` walks the
 * filesystem for `node_modules`, absent in bun's `$bunfs`). A static
 * `import { Agent }` would therefore crash the compiled Archon binary at module
 * load. So the runtime surface is reached through a DYNAMIC `import()` behind
 * {@link CursorSdkModule}, loaded lazily in `sdk-runtime.ts` only when a cursor
 * run actually executes — keeping the binary bootable and the failure catchable
 * (verified empirically; see the plan §9b + the sqlite3 gate).
 */
import type {
  Agent as CursorAgentClass,
  JsonlLocalAgentStore as JsonlLocalAgentStoreClass,
  SDKMessage,
  SDKAgent,
  Run,
  RunResult,
  ModelSelection,
  McpServerConfig,
  InteractionUpdate,
  TurnEndedUpdate,
} from '@cursor/sdk';

export type {
  SDKMessage,
  SDKAgent,
  Run,
  RunResult,
  ModelSelection,
  McpServerConfig,
  InteractionUpdate,
};

/**
 * The turn-ended token-usage block. This is the SOLE usage channel the SDK
 * exposes — it arrives only via the `onDelta` `turn-ended` interaction update,
 * never on `run.wait()`'s `RunResult` nor on any `run.stream()` message.
 */
export type CursorUsage = NonNullable<TurnEndedUpdate['usage']>;

/**
 * The runtime surface the provider reaches via dynamic `import('@cursor/sdk')`.
 * Only the values we actually call are listed — `Agent.create`/`Agent.resume`
 * and the pure-JS `JsonlLocalAgentStore` (chosen over the default SQLite store
 * to keep the SQLite runtime path entirely untouched).
 */
export interface CursorSdkModule {
  Agent: typeof CursorAgentClass;
  JsonlLocalAgentStore: typeof JsonlLocalAgentStoreClass;
}
