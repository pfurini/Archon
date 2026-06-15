import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import type { MessageChunk, SendQueryOptions } from '../../types';

import {
  CursorProvider,
  type CursorProviderDeps,
  type CursorRunnerConfig,
  type CursorRunnerHandle,
} from './provider';
import type { CursorUsage, RunResult, SDKMessage } from './sdk-types';

// ─── Fake Node sidecar (runner-spawn seam) ───────────────────────────────────
//
// The provider no longer loads `@cursor/sdk` in-process — it spawns a Node
// sidecar that forwards raw SDKMessages as JSONL. These tests inject a fake
// `spawnRunner` that yields scripted JSONL lines (the same shape `cursor-runner.mjs`
// emits) so the pump is exercised with no real `node` / SDK.

interface FakeCalls {
  nodePath?: string;
  cfg?: CursorRunnerConfig;
  env?: Record<string, string | undefined>;
  killed: boolean;
}

interface FakeRunnerConfig {
  messages: SDKMessage[];
  /** Status carried on the terminal `final` line. */
  status?: RunResult['status'];
  /** Usage carried on the terminal `final` line. */
  usage?: CursorUsage;
  agentId?: string;
  /** Emit a single `{kind:'error'}` line instead of agent/msgs/final (child threw). */
  errorLine?: string;
  /** Omit the terminal `final` line (child died mid-stream). */
  noFinal?: boolean;
  exitCode?: number;
  stderrTail?: string;
  /** Fired before each `msg` line is yielded (index into `messages`). */
  onYield?: (index: number, calls: FakeCalls) => void;
}

function makeFakeRunner(cfgR: FakeRunnerConfig): {
  spawnRunner: NonNullable<CursorProviderDeps['spawnRunner']>;
  calls: FakeCalls;
} {
  const calls: FakeCalls = { killed: false };
  const agentId = cfgR.agentId ?? 'agent-xyz';

  const spawnRunner = (
    nodePath: string,
    cfg: CursorRunnerConfig,
    env: Record<string, string | undefined>
  ): CursorRunnerHandle => {
    calls.nodePath = nodePath;
    calls.cfg = cfg;
    calls.env = env;

    async function* lines(): AsyncGenerator<string> {
      await Promise.resolve(); // mirror the real async stdout stream
      if (cfgR.errorLine !== undefined) {
        yield JSON.stringify({ kind: 'error', message: cfgR.errorLine });
        return;
      }
      yield JSON.stringify({ kind: 'agent', agentId });
      for (let i = 0; i < cfgR.messages.length; i++) {
        cfgR.onYield?.(i, calls);
        if (calls.killed) return; // child killed (abort) → stop emitting
        yield JSON.stringify({ kind: 'msg', message: cfgR.messages[i] });
      }
      if (!cfgR.noFinal) {
        yield JSON.stringify({
          kind: 'final',
          status: cfgR.status ?? 'finished',
          ...(cfgR.usage ? { usage: cfgR.usage } : {}),
        });
      }
    }

    return {
      lines: lines(),
      kill: () => {
        calls.killed = true;
      },
      exited: Promise.resolve({ exitCode: cfgR.exitCode ?? 0, stderrTail: cfgR.stderrTail ?? '' }),
    };
  };

  return { spawnRunner, calls };
}

/** Build a provider whose `node` resolves and whose sidecar is the fake runner. */
function makeProvider(cfgR: FakeRunnerConfig): { provider: CursorProvider; calls: FakeCalls } {
  const { spawnRunner, calls } = makeFakeRunner(cfgR);
  const provider = new CursorProvider({ resolveNodePath: () => '/fake/node', spawnRunner });
  return { provider, calls };
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
    const { provider, calls } = makeProvider({
      messages: [asst('Hel'), asst('lo'), asst(' there')],
      usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      agentId: 'agent-abc',
    });
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
    expect(calls.nodePath).toBe('/fake/node');
    expect(calls.killed).toBe(true); // best-effort cleanup in finally
    // model + settingSources + stateRoot + cwd forwarded in cfg.
    expect(calls.cfg?.model).toBe('composer-1');
    expect(calls.cfg?.settingSources).toEqual(['project']);
    expect(calls.cfg?.cwd).toBe('/repo');
    expect(calls.cfg?.stateRoot).toContain('cursor');
    // CURSOR_API_KEY forwarded into the child env.
    expect(calls.env?.CURSOR_API_KEY).toBe('test-key');
  });

  it('coalesces text across a tool boundary (text, tool, tool_result, text)', async () => {
    const { provider } = makeProvider({
      messages: [
        asst('Checking. '),
        asst('Now running.'),
        tool('c1', 'shell', 'running', { args: { command: 'ls' } }),
        tool('c1', 'shell', 'completed', { args: { command: 'ls' }, result: 'a.txt' }),
        asst('Found it.'),
      ],
    });
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

  it('passes MCP servers (env-expanded) and sandbox into the runner cfg', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-mcp-'));
    const mcpPath = join(dir, 'mcp.json');
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { foo: { command: 'echo', env: { FLAG: '$FOO_FLAG' } } } })
    );
    const { provider, calls } = makeProvider({ messages: [asst('ok')] });
    await collect(
      provider.sendQuery('x', dir, undefined, {
        ...BASE_OPTS,
        env: { CURSOR_API_KEY: 'k', FOO_FLAG: '--enabled' },
        nodeConfig: { mcp: mcpPath, sandbox: true },
      })
    );
    // The shared loader env-expands the `env` field from requestOptions.env.
    expect(calls.cfg?.mcpServers?.foo).toMatchObject({
      command: 'echo',
      env: { FLAG: '--enabled' },
    });
    expect(calls.cfg?.sandbox).toBe(true);
  });

  it('does not set mcpServers/sandbox in cfg when not requested', async () => {
    const { provider, calls } = makeProvider({ messages: [asst('ok')] });
    await collect(provider.sendQuery('x', '/repo', undefined, BASE_OPTS));
    expect(calls.cfg?.sandbox).toBeUndefined();
    expect(calls.cfg?.mcpServers).toBeUndefined();
  });

  it('forwards resumeSessionId into the runner cfg when resuming', async () => {
    const { provider, calls } = makeProvider({ messages: [asst('resumed')] });
    await collect(provider.sendQuery('again', '/repo', 'agent-prev', BASE_OPTS));
    expect(calls.cfg?.resumeSessionId).toBe('agent-prev');
  });

  it('omits resumeSessionId from cfg on a fresh turn', async () => {
    const { provider, calls } = makeProvider({ messages: [asst('fresh')] });
    await collect(provider.sendQuery('start', '/repo', undefined, BASE_OPTS));
    expect(calls.cfg?.resumeSessionId).toBeUndefined();
  });

  it('prepends a Shell workingDirectory directive (upstream SDK workaround) referencing the cwd', async () => {
    const { provider, calls } = makeProvider({ messages: [asst('ok')] });
    await collect(provider.sendQuery('do the thing', '/work/dir', undefined, BASE_OPTS));
    expect(calls.cfg?.prompt).toContain('workingDirectory');
    expect(calls.cfg?.prompt).toContain('/work/dir');
    expect(calls.cfg?.prompt).toContain('do the thing'); // original prompt preserved
  });

  it('extracts best-effort structured output from accumulated text', async () => {
    const { provider } = makeProvider({ messages: [asst('{"answer": '), asst('42}')] });
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

  it('yields cursor_node_unavailable when node is not on PATH', async () => {
    const provider = new CursorProvider({
      resolveNodePath: () => null,
      spawnRunner: () => {
        throw new Error('spawnRunner must not be called when node is missing');
      },
    });
    const chunks = await collect(provider.sendQuery('x', '/repo', undefined, BASE_OPTS));
    expect(chunks).toEqual([
      expect.objectContaining({
        type: 'result',
        isError: true,
        errorSubtype: 'cursor_node_unavailable',
      }),
    ]);
  });

  it('falls back to the default model when none is specified', async () => {
    const { provider, calls } = makeProvider({ messages: [asst('ok')] });
    await collect(provider.sendQuery('x', '/repo', undefined, { env: { CURSOR_API_KEY: 'k' } }));
    expect(calls.cfg?.model).toBe('composer-2.5');
  });

  it('fails fast with cursor_auth_missing when no API key is available', async () => {
    const { provider } = makeProvider({ messages: [] });
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

  it('emits a single aborted result when the abort signal fires mid-stream', async () => {
    const controller = new AbortController();
    const { provider, calls } = makeProvider({
      messages: [asst('partial'), asst(' more'), asst(' tail')],
      onYield: index => {
        if (index === 1) controller.abort();
      },
    });
    const chunks = await collect(
      provider.sendQuery('x', '/repo', undefined, { ...BASE_OPTS, abortSignal: controller.signal })
    );
    const results = chunks.filter(c => c.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      isError: true,
      errorSubtype: 'aborted',
      stopReason: 'aborted',
    });
    expect(calls.killed).toBe(true); // parent killed the child
  });

  it('yields a redacted cursor_error result when the sidecar emits an error line (bad key path)', async () => {
    const { provider } = makeProvider({
      messages: [],
      errorLine: 'unauthenticated: Bearer sk-secret1234567',
    });
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

  it('does not emit a second result when abort races a final line (single terminal)', async () => {
    const controller = new AbortController();
    // A final line is processed; abort then fires as the child exits. The final
    // is authoritative — only one terminal `result` must be emitted (not also an
    // aborted one).
    const provider = new CursorProvider({
      resolveNodePath: () => '/fake/node',
      spawnRunner: () => ({
        lines: (async function* (): AsyncGenerator<string> {
          await Promise.resolve();
          yield JSON.stringify({ kind: 'agent', agentId: 'agent-final' });
          yield JSON.stringify({ kind: 'final', status: 'finished' });
          controller.abort(); // abort only AFTER the final line was consumed
        })(),
        kill: () => {},
        exited: Promise.resolve({ exitCode: 0, stderrTail: '' }),
      }),
    });
    const chunks = await collect(
      provider.sendQuery('x', '/repo', undefined, { ...BASE_OPTS, abortSignal: controller.signal })
    );
    const results = chunks.filter(c => c.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ stopReason: 'stop', sessionId: 'agent-final' });
  });

  it('yields cursor_error when spawnRunner throws synchronously', async () => {
    const provider = new CursorProvider({
      resolveNodePath: () => '/fake/node',
      spawnRunner: () => {
        throw new Error('spawn EACCES /fake/node');
      },
    });
    const chunks = await collect(provider.sendQuery('x', '/repo', undefined, BASE_OPTS));
    expect(chunks).toEqual([
      expect.objectContaining({ type: 'result', isError: true, errorSubtype: 'cursor_error' }),
    ]);
  });

  it('yields cursor_error with the stderr tail when the sidecar dies without a final line', async () => {
    const { provider } = makeProvider({
      messages: [asst('partial work')],
      noFinal: true,
      exitCode: 1,
      stderrTail: 'Cannot find module @cursor/sdk',
    });
    const chunks = await collect(provider.sendQuery('x', '/repo', undefined, BASE_OPTS));
    // Buffered text is flushed before the error so partial output isn't lost.
    expect(chunks.find(c => c.type === 'assistant')).toMatchObject({ content: 'partial work' });
    const result = chunks.find(c => c.type === 'result') as Extract<
      MessageChunk,
      { type: 'result' }
    >;
    expect(result.isError).toBe(true);
    expect(result.errorSubtype).toBe('cursor_error');
    expect(result.errors?.[0]).toContain('Cannot find module');
  });
});
