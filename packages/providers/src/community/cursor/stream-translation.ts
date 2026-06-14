/**
 * Direct `SDKMessage` → Archon `MessageChunk` translation for the cursor pump.
 *
 * Skips gsd-pi's intermediate `CursorStreamEvent` layer (which existed only to
 * share a CLI NDJSON pump we don't have) and maps the SDK's run-stream messages
 * straight to Archon chunks.
 *
 * ## Coalescing (load-bearing)
 * The SDK emits `assistant` messages as INCREMENTAL TEXT DELTAS (e.g. `"P"`
 * then `"ONG"`) — verified against the SDK's own behavior in gsd-pi's
 * `accumulateSdkAssistantText`. Archon's batch-mode `handleStreamMode`
 * concatenates emitted `assistant` chunks with `join('')` AND calls
 * `platform.sendMessage` once per chunk, so emitting raw per-token deltas would
 * spam one message per token. We therefore BUFFER contiguous assistant deltas
 * in `pendingText` and flush them as a SINGLE `assistant` chunk at each boundary
 * (a thinking block, a tool call, a terminal). `fullText` keeps the cumulative
 * total for best-effort structured-output extraction.
 *
 * Every error/cancel string emitted here is passed through `redactSecrets`.
 */
import type { MessageChunk } from '../../types';

import { redactSecrets } from './redact';
import type { CursorUsage, RunResult, SDKMessage } from './sdk-types';
import { mapCursorUsage } from './usage';

export interface TranslationState {
  /** Buffered contiguous assistant deltas since the last flush. */
  pendingText: string;
  /** Cumulative assistant text across the whole turn (structured-output source). */
  fullText: string;
  /** Resolved session id — the SDK `agentId` (set by the provider; system
   *  message `agent_id` is a fallback). */
  sessionId?: string;
  /** call_ids already emitted as a `tool` chunk, so each pairs exactly once. */
  emittedToolCalls: Set<string>;
  /** Non-terminal error recorded from a CANCELLED/EXPIRED status message;
   *  surfaced by the terminal result. */
  nonTerminalError?: string;
}

export function makeTranslationState(): TranslationState {
  return { pendingText: '', fullText: '', emittedToolCalls: new Set<string>() };
}

/** Flush buffered assistant text as one `assistant` chunk (empty → no chunk). */
export function flushText(state: TranslationState): MessageChunk[] {
  if (state.pendingText.length === 0) return [];
  const content = state.pendingText;
  state.pendingText = '';
  return [{ type: 'assistant', content }];
}

/** Narrow an SDK tool-call `args`/`input` blob to a plain object, else undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/** Render a tool result (string passthrough, everything else JSON-stringified). */
function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Translate one SDK run-stream message into zero or more `MessageChunk`s,
 * mutating `state` (buffer, sessionId, tool-call set, recorded errors).
 */
export function translateSdkMessage(msg: SDKMessage, state: TranslationState): MessageChunk[] {
  switch (msg.type) {
    case 'system': {
      // init message — capture the agent id as a session-id fallback. No
      // user-facing chunk.
      state.sessionId ??= msg.agent_id;
      return [];
    }

    case 'assistant': {
      // Incremental text deltas — accumulate, never emit yet (see file header).
      // Tool use arrives as separate `tool_call` messages, not in this content
      // array, so only text blocks are consumed here.
      let delta = '';
      for (const block of msg.message.content) {
        if (block.type === 'text') delta += block.text;
      }
      if (delta.length > 0) {
        state.pendingText += delta;
        state.fullText += delta;
      }
      return [];
    }

    case 'thinking': {
      const chunks = flushText(state);
      chunks.push({ type: 'thinking', content: msg.text });
      return chunks;
    }

    case 'tool_call': {
      const chunks = flushText(state);
      const callId = msg.call_id;
      if (!state.emittedToolCalls.has(callId)) {
        state.emittedToolCalls.add(callId);
        const toolInput = asRecord(msg.args);
        chunks.push({
          type: 'tool',
          toolName: msg.name,
          ...(toolInput ? { toolInput } : {}),
          toolCallId: callId,
        });
      }
      if ((msg.status === 'completed' || msg.status === 'error') && msg.result !== undefined) {
        chunks.push({
          type: 'tool_result',
          toolName: msg.name,
          toolOutput: stringifyToolResult(msg.result),
          toolCallId: callId,
        });
      }
      return chunks;
    }

    case 'status': {
      if (msg.status === 'CANCELLED' || msg.status === 'EXPIRED') {
        const chunks = flushText(state);
        state.nonTerminalError = msg.message ?? `run ${msg.status.toLowerCase()}`;
        return chunks;
      }
      return [];
    }

    // Consumed silently — no Archon-visible analogue.
    case 'user':
    case 'task':
    case 'request':
      return [];

    default:
      return [];
  }
}

/**
 * Build the terminal `result` chunk: flush trailing text, then emit usage,
 * session id, optional structured output, and error/stop classification from
 * the drained `run.wait()` result + the captured `turn-ended` usage.
 */
export function finalizeResult(
  state: TranslationState,
  params: {
    result: RunResult;
    sessionId: string;
    usage: CursorUsage | undefined;
    structuredOutput?: unknown;
  }
): MessageChunk[] {
  const chunks = flushText(state);
  const status = params.result.status;
  const isError = status !== 'finished' || state.nonTerminalError !== undefined;
  const stopReason = status === 'finished' ? 'stop' : status;

  const result: MessageChunk = {
    type: 'result',
    sessionId: params.sessionId,
    tokens: mapCursorUsage(params.usage),
    stopReason,
    ...(params.structuredOutput !== undefined ? { structuredOutput: params.structuredOutput } : {}),
    ...(isError
      ? {
          isError: true,
          errorSubtype: 'cursor_error',
          errors: [
            redactSecrets(state.nonTerminalError ?? params.result.result ?? `run ${status}`),
          ],
        }
      : {}),
  };
  chunks.push(result);
  return chunks;
}
