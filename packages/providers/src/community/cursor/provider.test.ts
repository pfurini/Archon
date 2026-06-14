import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import type { MessageChunk, SendQueryOptions } from '../../types';

import { CursorProvider } from './provider';
import type { CursorSdkModule, CursorUsage, RunResult, SDKMessage } from './sdk-types';

// ─── Fake @cursor/sdk ────────────────────────────────────────────────────────

interface FakeCalls {
  created: boolean;
  resumedWith?: string;
  options?: Record<string, unknown>;
  sentPrompt?: string;
  cancelled: boolean;
  closed: boolean;
}

interface FakeSdkConfig {
  messages: SDKMessage[];
  status?: RunResult['status'];
  usage?: CursorUsage;
  agentId?: string;
  /** Throw from Agent.create/resume (bad-key / config failure path). */
  throwOnCreate?: Error;
  /** Hook fired as each stream message is about to be yielded (for abort tests). */
  onYield?: (index: number, calls: FakeCalls) => void;
}

function makeFakeSdk(cfg: FakeSdkConfig): { sdk: CursorSdkModule; calls: FakeCalls } {
  const calls: FakeCalls = { created: false, cancelled: false, closed: false };
  const agentId = cfg.agentId ?? 'agent-xyz';

  const makeRun = (onDelta?: (a: { update: { type: string; usage?: CursorUsage } }) => void) => {
    if (cfg.usage && onDelta) onDelta({ update: { type: 'turn-ended', usage: cfg.usage } });
    return {
      id: 'run-1',
      agentId,
      async *stream(): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve(); // satisfy require-await; mirrors the real async stream
        for (let i = 0; i < cfg.messages.length; i++) {
          cfg.onYield?.(i, calls);
          yield cfg.messages[i];
        }
      },
      async wait(): Promise<RunResult> {
        return { id: 'run-1', status: cfg.status ?? 'finished' };
      },
      async cancel(): Promise<void> {
        calls.cancelled = true;
      },
    };
  };

  const agent = {
    agentId,
    async send(
      prompt: string,
      opts: { onDelta?: (a: { update: { type: string; usage?: CursorUsage } }) => void }
    ) {
      calls.sentPrompt = prompt;
      return makeRun(opts.onDelta);
    },
    close(): void {
      calls.closed = true;
    },
  };

  const Agent = {
    async create(options: Record<string, unknown>) {
      if (cfg.throwOnCreate) throw cfg.throwOnCreate;
      calls.created = true;
      calls.options = options;
      return agent;
    },
    async resume(id: string, options: Record<string, unknown>) {
      if (cfg.throwOnCreate) throw cfg.throwOnCreate;
      calls.resumedWith = id;
      calls.options = options;
      return agent;
    },
  };

  class JsonlLocalAgentStore {
    constructor(public readonly root: string) {}
  }

  return { sdk: { Agent, JsonlLocalAgentStore } as unknown as CursorSdkModule, calls };
}

// ─── Message builders ────────────────────────────────────────────────────────
function asst(text: string): SDKMessage {
  return {
    type: 'assistant',
    agent_id: 'a',
    run_id: 'r',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as SDKMessage;
}
function tool(
  callId: string,
  name: string,
  status: 'running' | 'completed',
  extra: Record<string, unknown> = {}
): SDKMessage {
  return {
    type: 'tool_call',
    agent_id: 'a',
    run_id: 'r',
    call_id: callId,
    name,
    status,
    ...extra,
  } as SDKMessage;
}

async function collect(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

const BASE_OPTS: SendQueryOptions = { model: 'composer-1', env: { CURSOR_API_KEY: 'test-key' } };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CursorProvider.sendQuery', () => {
  it('streams a coalesced text turn and a result with usage + sessionId=agentId', async () => {
    const { sdk, calls } = makeFakeSdk({
      messages: [asst('Hel'), asst('lo'), asst(' there')],
      usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      agentId: 'agent-abc',
    });
    const provider = new CursorProvider({ loadSdk: async () => sdk });
    const chunks = await collect(provider.sendQuery('hi', '/repo', undefined, BASE_OPTS));

    expect(chunks).toEqual([
      { type: 'assistant', content: 'Hello there' },
      {
        type: 'result',
        sessionId: 'agent-abc',
        tokens: { input: 50, output: 10, total: 60 },
        stopReason: 'stop',
      },
    ]);
    expect(calls.created).toBe(true);
    expect(calls.closed).toBe(true);
    // model + settingSources wired correctly.
    const opts = calls.options as { model: { id: string }; local: { settingSources: string[] } };
    expect(opts.model.id).toBe('composer-1');
    expect(opts.local.settingSources).toEqual(['project']);
  });

  it('coalesces text across a tool boundary (text, tool, tool_result, text)', async () => {
    const { sdk } = makeFakeSdk({
      messages: [
        asst('Checking. '),
        asst('Now running.'),
        tool('c1', 'shell', 'running', { args: { command: 'ls' } }),
        tool('c1', 'shell', 'completed', { args: { command: 'ls' }, result: 'a.txt' }),
        asst('Found it.'),
      ],
    });
    const provider = new CursorProvider({ loadSdk: async () => sdk });
    const chunks = await collect(provider.sendQuery('go', '/repo', undefined, BASE_OPTS));

    expect(chunks).toEqual([
      { type: 'assistant', content: 'Checking. Now running.' },
      { type: 'tool', toolName: 'shell', toolInput: { command: 'ls' }, toolCallId: 'c1' },
      { type: 'tool_result', toolName: 'shell', toolOutput: 'a.txt', toolCallId: 'c1' },
      { type: 'assistant', content: 'Found it.' },
      {
        type: 'result',
        sessionId: 'agent-xyz',
        tokens: { input: 0, output: 0, total: 0 },
        stopReason: 'stop',
      },
    ]);
  });

  it('passes MCP servers (env-expanded) and sandbox into the agent options', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-mcp-'));
    const mcpPath = join(dir, 'mcp.json');
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { foo: { command: 'echo', env: { FLAG: '$FOO_FLAG' } } } })
    );
    const { sdk, calls } = makeFakeSdk({ messages: [asst('ok')] });
    const provider = new CursorProvider({ loadSdk: async () => sdk });
    await collect(
      provider.sendQuery('x', dir, undefined, {
        ...BASE_OPTS,
        env: { CURSOR_API_KEY: 'k', FOO_FLAG: '--enabled' },
        nodeConfig: { mcp: mcpPath, sandbox: true },
      })
    );
    const opts = calls.options as {
      mcpServers?: Record<string, { command?: string; env?: Record<string, string> }>;
      local: { sandboxOptions?: { enabled: boolean } };
    };
    // The shared loader env-expands the `env` field from requestOptions.env.
    expect(opts.mcpServers?.foo).toMatchObject({ command: 'echo', env: { FLAG: '--enabled' } });
    expect(opts.local.sandboxOptions).toEqual({ enabled: true });
  });

  it('does not set sandboxOptions when sandbox is not requested', async () => {
    const { sdk, calls } = makeFakeSdk({ messages: [asst('ok')] });
    const provider = new CursorProvider({ loadSdk: async () => sdk });
    await collect(provider.sendQuery('x', '/repo', undefined, BASE_OPTS));
    const opts = calls.options as { mcpServers?: unknown; local: { sandboxOptions?: unknown } };
    expect(opts.local.sandboxOptions).toBeUndefined();
    expect(opts.mcpServers).toBeUndefined();
  });

  it('resumes by agentId when a resumeSessionId is given', async () => {
    const { sdk, calls } = makeFakeSdk({ messages: [asst('resumed')] });
    const provider = new CursorProvider({ loadSdk: async () => sdk });
    await collect(provider.sendQuery('again', '/repo', 'agent-prev', BASE_OPTS));
    expect(calls.resumedWith).toBe('agent-prev');
    expect(calls.created).toBe(false);
  });

  it('extracts best-effort structured output from accumulated text', async () => {
    const { sdk } = makeFakeSdk({ messages: [asst('{"answer": '), asst('42}')] });
    const provider = new CursorProvider({ loadSdk: async () => sdk });
    const opts: SendQueryOptions = {
      ...BASE_OPTS,
      outputFormat: {
        type: 'json_schema',
        schema: { type: 'object', properties: { answer: { type: 'number' } } },
      },
    };
    const chunks = await collect(provider.sendQuery('q', '/repo', undefined, opts));
    expect(chunks.find(c => c.type === 'result')).toMatchObject({
      structuredOutput: { answer: 42 },
    });
  });

  it('yields a graceful result when the SDK cannot be loaded', async () => {
    const provider = new CursorProvider({ loadSdk: async () => null });
    const chunks = await collect(provider.sendQuery('x', '/repo', undefined, BASE_OPTS));
    expect(chunks).toEqual([
      expect.objectContaining({
        type: 'result',
        isError: true,
        errorSubtype: 'cursor_sdk_unavailable',
      }),
    ]);
  });

  it('falls back to the default model when none is specified', async () => {
    const { sdk, calls } = makeFakeSdk({ messages: [asst('ok')] });
    const provider = new CursorProvider({ loadSdk: async () => sdk });
    await collect(provider.sendQuery('x', '/repo', undefined, { env: { CURSOR_API_KEY: 'k' } }));
    const opts = calls.options as { model: { id: string } };
    expect(opts.model.id).toBe('composer-2.5');
  });

  it('fails fast with cursor_auth_missing when no API key is available', async () => {
    const { sdk } = makeFakeSdk({ messages: [] });
    const provider = new CursorProvider({ loadSdk: async () => sdk });
    const saved = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    try {
      const chunks = await collect(
        provider.sendQuery('x', '/repo', undefined, { model: 'composer-1' })
      );
      expect(chunks).toEqual([
        expect.objectContaining({
          type: 'result',
          isError: true,
          errorSubtype: 'cursor_auth_missing',
        }),
      ]);
    } finally {
      if (saved !== undefined) process.env.CURSOR_API_KEY = saved;
    }
  });

  it('emits an aborted result when the abort signal fires mid-stream', async () => {
    const controller = new AbortController();
    const { sdk, calls } = makeFakeSdk({
      messages: [asst('partial'), asst(' more'), asst(' tail')],
      onYield: index => {
        if (index === 1) controller.abort();
      },
    });
    const provider = new CursorProvider({ loadSdk: async () => sdk });
    const chunks = await collect(
      provider.sendQuery('x', '/repo', undefined, { ...BASE_OPTS, abortSignal: controller.signal })
    );
    const result = chunks.find(c => c.type === 'result');
    expect(result).toMatchObject({ isError: true, errorSubtype: 'aborted', stopReason: 'aborted' });
    expect(calls.cancelled).toBe(true);
  });

  it('yields a redacted cursor_error result when the SDK throws (bad key path)', async () => {
    const { sdk } = makeFakeSdk({
      messages: [],
      throwOnCreate: new Error('unauthenticated: Bearer sk-secret1234567'),
    });
    const provider = new CursorProvider({ loadSdk: async () => sdk });
    const chunks = await collect(provider.sendQuery('x', '/repo', undefined, BASE_OPTS));
    const result = chunks.find(c => c.type === 'result') as Extract<
      MessageChunk,
      { type: 'result' }
    >;
    expect(result.isError).toBe(true);
    expect(result.errorSubtype).toBe('cursor_error');
    expect(result.errors?.[0]).toContain('[REDACTED]');
    expect(result.errors?.[0]).not.toContain('sk-secret');
  });
});
