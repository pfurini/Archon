/**
 * `@cursor/sdk` type surface for the cursor provider.
 *
 * The SDK's RUNTIME is no longer loaded in the Bun parent at all — it executes
 * in a short-lived Node sidecar (`cursor-runner.mjs`), which sidesteps the
 * Bun ↔ `@cursor/sdk` tool-runtime deadlock in git repos (plan §2). The parent
 * only needs the SDK's TYPES (erased at build, never trigger a module load) so
 * `translateSdkMessage` / `finalizeResult` can type the raw `SDKMessage`s the
 * sidecar forwards as JSONL.
 */
import type {
  SDKMessage,
  RunResult,
  McpServerConfig,
  TurnEndedUpdate,
  ModelListItem,
  ModelParameterDefinition,
  ModelParameterValue,
} from '@cursor/sdk';

export type {
  SDKMessage,
  RunResult,
  McpServerConfig,
  ModelListItem,
  ModelParameterDefinition,
  ModelParameterValue,
};

/**
 * The turn-ended token-usage block. This is the SOLE usage channel the SDK
 * exposes — it arrives only via the `onDelta` `turn-ended` interaction update
 * (captured in the sidecar), never on `run.wait()`'s `RunResult` nor on any
 * `run.stream()` message.
 */
export type CursorUsage = NonNullable<TurnEndedUpdate['usage']>;
