import { describe, expect, it } from 'bun:test';

import type { MessageChunk } from '../../types';

import type { RunResult, SDKMessage } from './sdk-types';
import {
  finalizeResult,
  flushText,
  makeTranslationState,
  translateSdkMessage,
} from './stream-translation';

// ─── Message builders (fill the required agent_id/run_id boilerplate) ────────
const AID = 'agent-123';
const RID = 'run-456';

function system(): SDKMessage {
  return { type: 'system', subtype: 'init', agent_id: AID, run_id: RID } as SDKMessage;
}
function assistant(text: string): SDKMessage {
  return {
    type: 'assistant',
    agent_id: AID,
    run_id: RID,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as SDKMessage;
}
function thinking(text: string): SDKMessage {
  return { type: 'thinking', agent_id: AID, run_id: RID, text } as SDKMessage;
}
function toolCall(
  callId: string,
  name: string,
  status: 'running' | 'completed' | 'error',
  extra: { args?: unknown; result?: unknown } = {}
): SDKMessage {
  return {
    type: 'tool_call',
    agent_id: AID,
    run_id: RID,
    call_id: callId,
    name,
    status,
    ...extra,
  } as SDKMessage;
}
function status(s: string, message?: string): SDKMessage {
  return { type: 'status', agent_id: AID, run_id: RID, status: s, message } as SDKMessage;
}

function drain(msgs: SDKMessage[]): {
  chunks: MessageChunk[];
  state: ReturnType<typeof makeTranslationState>;
} {
  const state = makeTranslationState();
  const chunks: MessageChunk[] = [];
  for (const m of msgs) chunks.push(...translateSdkMessage(m, state));
  return { chunks, state };
}

describe('translateSdkMessage', () => {
  it('captures agent_id from the system init message without emitting a chunk', () => {
    const { chunks, state } = drain([system()]);
    expect(chunks).toEqual([]);
    expect(state.sessionId).toBe(AID);
  });

  it('coalesces contiguous assistant deltas — no emit until a boundary', () => {
    const { chunks, state } = drain([assistant('Hel'), assistant('lo'), assistant(' world')]);
    // No flush yet — all buffered.
    expect(chunks).toEqual([]);
    expect(state.pendingText).toBe('Hello world');
    expect(state.fullText).toBe('Hello world');
    // A trailing flush emits ONE assistant chunk with the whole segment.
    expect(flushText(state)).toEqual([{ type: 'assistant', content: 'Hello world' }]);
  });

  it('flushes buffered text as one chunk at a thinking boundary', () => {
    const { chunks } = drain([assistant('before'), thinking('pondering')]);
    expect(chunks).toEqual([
      { type: 'assistant', content: 'before' },
      { type: 'thinking', content: 'pondering' },
    ]);
  });

  it('coalesces text across a tool-call boundary (the key spam-prevention case)', () => {
    const { chunks } = drain([
      assistant('Let me check. '),
      assistant('Running a tool.'),
      toolCall('c1', 'shell', 'running', { args: { command: 'ls' } }),
      toolCall('c1', 'shell', 'completed', { args: { command: 'ls' }, result: 'file.txt' }),
      assistant('Done — found 1 file.'),
    ]);
    expect(chunks).toEqual([
      { type: 'assistant', content: 'Let me check. Running a tool.' },
      { type: 'tool', toolName: 'shell', toolInput: { command: 'ls' }, toolCallId: 'c1' },
      { type: 'tool_result', toolName: 'shell', toolOutput: 'file.txt', toolCallId: 'c1' },
    ]);
    // The trailing assistant text is still buffered (flushed at terminal).
  });

  it('emits a `tool` chunk only once per call_id even across status updates', () => {
    const { chunks } = drain([
      toolCall('c1', 'read', 'running', { args: { path: 'a' } }),
      toolCall('c1', 'read', 'completed', { args: { path: 'a' }, result: { ok: true } }),
    ]);
    const toolChunks = chunks.filter(c => c.type === 'tool');
    expect(toolChunks).toHaveLength(1);
    expect(chunks).toContainEqual({
      type: 'tool_result',
      toolName: 'read',
      toolOutput: JSON.stringify({ ok: true }),
      toolCallId: 'c1',
    });
  });

  it('pairs a completed tool that never had a running message', () => {
    const { chunks } = drain([toolCall('c9', 'glob', 'completed', { result: 'x' })]);
    expect(chunks).toEqual([
      { type: 'tool', toolName: 'glob', toolCallId: 'c9' },
      { type: 'tool_result', toolName: 'glob', toolOutput: 'x', toolCallId: 'c9' },
    ]);
  });

  it('records a non-terminal error on CANCELLED/EXPIRED status', () => {
    const { state } = drain([status('CANCELLED', 'user cancelled')]);
    expect(state.nonTerminalError).toBe('user cancelled');
  });

  it('silently consumes user/task/request messages', () => {
    const { chunks } = drain([
      {
        type: 'user',
        agent_id: AID,
        run_id: RID,
        message: { role: 'user', content: [] },
      } as SDKMessage,
      { type: 'task', agent_id: AID, run_id: RID } as SDKMessage,
      { type: 'request', agent_id: AID, run_id: RID, request_id: 'r1' } as SDKMessage,
    ]);
    expect(chunks).toEqual([]);
  });
});

describe('finalizeResult', () => {
  const okResult: RunResult = { id: RID, status: 'finished' };

  it('flushes trailing text then emits a success result with usage + session id', () => {
    const state = makeTranslationState();
    translateSdkMessage(assistant('final answer'), state);
    const chunks = finalizeResult(state, {
      result: okResult,
      sessionId: AID,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(chunks).toEqual([
      { type: 'assistant', content: 'final answer' },
      {
        type: 'result',
        sessionId: AID,
        tokens: { input: 100, output: 20, total: 120 },
        stopReason: 'stop',
      },
    ]);
  });

  it('maps zero usage when no turn-ended block was captured', () => {
    const state = makeTranslationState();
    const chunks = finalizeResult(state, { result: okResult, sessionId: AID, usage: undefined });
    const result = chunks.find(c => c.type === 'result');
    expect(result).toMatchObject({ tokens: { input: 0, output: 0, total: 0 } });
  });

  it('attaches structured output when provided', () => {
    const state = makeTranslationState();
    const chunks = finalizeResult(state, {
      result: okResult,
      sessionId: AID,
      usage: undefined,
      structuredOutput: { answer: 42 },
    });
    expect(chunks.find(c => c.type === 'result')).toMatchObject({
      structuredOutput: { answer: 42 },
    });
  });

  it('marks isError + cursor_error subtype on a non-finished run', () => {
    const state = makeTranslationState();
    const chunks = finalizeResult(state, {
      result: { id: RID, status: 'error', result: 'boom' },
      sessionId: AID,
      usage: undefined,
    });
    expect(chunks.find(c => c.type === 'result')).toMatchObject({
      isError: true,
      errorSubtype: 'cursor_error',
      errors: ['boom'],
      stopReason: 'error',
    });
  });

  it('surfaces a recorded CANCELLED status as an error even if run.wait reports finished', () => {
    const state = makeTranslationState();
    translateSdkMessage(status('CANCELLED', 'aborted by user'), state);
    const chunks = finalizeResult(state, { result: okResult, sessionId: AID, usage: undefined });
    expect(chunks.find(c => c.type === 'result')).toMatchObject({
      isError: true,
      errors: ['aborted by user'],
    });
  });
});
