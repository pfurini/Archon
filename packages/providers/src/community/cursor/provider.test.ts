import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import type { MessageChunk, SendQueryOptions } from '../../types';

import type { CursorCatalog } from './catalog';
import {
  CursorProvider,
  type CursorCatalogLoader,
  type CursorProviderDeps,
  type CursorRunnerConfig,
  type CursorRunnerHandle,
} from './provider';
import type { CursorUsage, ModelListItem, RunResult, SDKMessage } from './sdk-types';

// ─── Fake model catalog (loadCatalog seam) ───────────────────────────────────
//
// The provider resolves per-model params against the live catalog. These tests
// inject a fake `loadCatalog` so no `node` helper is spawned. The default
// catalog lists the models the suite uses, each with a `fast` param so the
// implicit `fast=false` cost default resolves cleanly.
const CATALOG_MODELS: ModelListItem[] = [
  {
    id: 'composer-1',
    displayName: 'Composer 1',
    parameters: [{ id: 'fast', values: [{ value: 'false' }, { value: 'true' }] }],
  },
  {
    id: 'composer-2.5',
    displayName: 'Composer 2.5',
    parameters: [{ id: 'fast', values: [{ value: 'false' }, { value: 'true' }] }],
  },
  {
    id: 'gpt-5.4',
    displayName: 'GPT-5.4',
    parameters: [
      {
        id: 'reasoning',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'extra-high' }],
      },
      { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
    ],
  },
  { id: 'gemini-3-flash', displayName: 'Gemini 3 Flash', parameters: [] },
];

interface FakeCatalogConfig {
  models?: ModelListItem[];
  /** Simulate a degraded (cold + failed refresh) catalog. */
  unavailable?: boolean;
  /** Served from a (stale) disk snapshot — enables the param-rejection retry. */
  servedFromDisk?: boolean;
  /** Models the catalog flips to after a successful forceRefresh. */
  refreshedModels?: ModelListItem[];
  /** Make forceRefresh reject (simulate persistent network failure). */
  refreshFails?: boolean;
}

function makeFakeCatalog(c: FakeCatalogConfig): {
  catalog: CursorCatalog;
  forceRefreshes: () => number;
} {
  let refreshes = 0;
  const catalog: CursorCatalog = {
    models: c.unavailable ? [] : (c.models ?? CATALOG_MODELS),
    fetchedAt: c.unavailable ? undefined : 1,
    ageMs: c.unavailable ? undefined : 0,
    servedFromDisk: c.servedFromDisk ?? false,
    available: c.unavailable ? false : true,
    forceRefresh: async (): Promise<void> => {
      refreshes++;
      if (c.refreshFails) throw new Error('catalog refresh failed');
      catalog.models = c.refreshedModels ?? catalog.models;
      catalog.servedFromDisk = false;
      catalog.available = catalog.models.length > 0;
    },
  };
  return { catalog, forceRefreshes: () => refreshes };
}

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
function makeProvider(
  cfgR: FakeRunnerConfig,
  catalogCfg: FakeCatalogConfig = {}
): {
  provider: CursorProvider;
  calls: FakeCalls;
  forceRefreshes: () => number;
  loadCount: () => number;
} {
  const { spawnRunner, calls } = makeFakeRunner(cfgR);
  const { catalog, forceRefreshes } = makeFakeCatalog(catalogCfg);
  let loads = 0;
  const loadCatalog: CursorCatalogLoader = async () => {
    loads++;
    return catalog;
  };
  const provider = new CursorProvider({
    resolveNodePath: () => '/fake/node',
    spawnRunner,
    loadCatalog,
  });
  return { provider, calls, forceRefreshes, loadCount: () => loads };
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

/** A loader returning an available catalog — for tests that construct the provider directly. */
const okCatalogLoader: CursorCatalogLoader = async () => makeFakeCatalog({}).catalog;

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
      loadCatalog: okCatalogLoader,
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
      loadCatalog: okCatalogLoader,
      spawnRunner: () => {
        throw new Error('spawn EACCES /fake/node');
      },
    });
    const chunks = await collect(provider.sendQuery('x', '/repo', undefined, BASE_OPTS));
    expect(chunks).toEqual([
      expect.objectContaining({ type: 'result', isError: true, errorSubtype: 'cursor_error' }),
    ]);
  });

  it('surfaces the stderr tail on an error-status final (instead of a bare "run error")', async () => {
    // The SDK can return a clean `final` with status:'error' and NO result detail
    // (observed in prod as errors:["run error"]). The captured stderr tail — where
    // @cursor/sdk logs the real reason — must be threaded into the error result.
    const { provider } = makeProvider({
      messages: [asst('partial work')],
      status: 'error',
      stderrTail: '[sdk] run failed: upstream model overloaded (503)',
    });
    const chunks = await collect(provider.sendQuery('x', '/repo', undefined, BASE_OPTS));
    const r = result(chunks);
    expect(r?.isError).toBe(true);
    expect(r?.errorSubtype).toBe('cursor_error');
    expect(r?.errors?.[0]).toContain('upstream model overloaded (503)');
    expect(r?.errors?.[0]).not.toBe('run error');
    expect(r?.stopReason).toBe('error');
  });

  it('degrades to "run error" on an error-status final when the stderr tail is empty', async () => {
    const { provider } = makeProvider({ messages: [asst('x')], status: 'error', stderrTail: '' });
    const chunks = await collect(provider.sendQuery('x', '/repo', undefined, BASE_OPTS));
    expect(result(chunks)?.errors?.[0]).toBe('run error');
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

// ─── Per-model parameters (Phase 1) ──────────────────────────────────────────

function result(chunks: MessageChunk[]): Extract<MessageChunk, { type: 'result' }> | undefined {
  return chunks.find(c => c.type === 'result') as
    | Extract<MessageChunk, { type: 'result' }>
    | undefined;
}

describe('CursorProvider.sendQuery — model parameters', () => {
  it('translates node effort to the model reasoning/effort param (cfg.modelParams)', async () => {
    const { provider, calls } = makeProvider({ messages: [asst('ok')] });
    await collect(
      provider.sendQuery('x', '/repo', undefined, {
        ...BASE_OPTS,
        model: 'gpt-5.4',
        nodeConfig: { effort: 'high' },
      })
    );
    expect(calls.cfg?.modelParams).toContainEqual({ id: 'reasoning', value: 'high' });
  });

  it('emits the implicit standard-tier default (fast=false) when no knobs are set', async () => {
    const { provider, calls } = makeProvider({ messages: [asst('ok')] });
    await collect(provider.sendQuery('x', '/repo', undefined, BASE_OPTS));
    expect(calls.cfg?.modelParams).toEqual([{ id: 'fast', value: 'false' }]);
  });

  it('honors an explicit config fast=false', async () => {
    const { provider, calls } = makeProvider({ messages: [asst('ok')] });
    await collect(
      provider.sendQuery('x', '/repo', undefined, {
        ...BASE_OPTS,
        assistantConfig: { fast: false },
      })
    );
    expect(calls.cfg?.modelParams).toEqual([{ id: 'fast', value: 'false' }]);
  });

  it('honors an explicit config fast=true (opt into premium)', async () => {
    const { provider, calls } = makeProvider({ messages: [asst('ok')] });
    await collect(
      provider.sendQuery('x', '/repo', undefined, { ...BASE_OPTS, assistantConfig: { fast: true } })
    );
    expect(calls.cfg?.modelParams).toEqual([{ id: 'fast', value: 'true' }]);
  });

  it('omits config fast on a no-fast model (gemini) — no failure, sidecar spawns', async () => {
    // Regression: a blanket `assistants.cursor.fast` policy aimed at a model with
    // no `fast` param (single tier) must omit the knob, NOT fail the node.
    const { provider, calls } = makeProvider({ messages: [asst('ok')] });
    const chunks = await collect(
      provider.sendQuery('x', '/repo', undefined, {
        ...BASE_OPTS,
        model: 'gemini-3-flash',
        assistantConfig: { fast: true },
      })
    );
    expect(result(chunks)?.errorSubtype).toBeUndefined();
    expect(calls.cfg).toBeDefined(); // sidecar spawned
    // fast omitted (nothing else emitted) → provider drops the empty param list.
    expect(calls.cfg?.modelParams).toBeUndefined();
  });

  it('fails closed (cursor_model_params_unavailable, no spawn) on an explicit knob the catalog can not honor', async () => {
    // Catalog is available but does NOT list composer-1; an explicit effort knob
    // therefore can't be validated → fail-loud.
    const { provider, calls } = makeProvider(
      { messages: [asst('ok')] },
      { models: [{ id: 'other-model', displayName: 'Other', parameters: [] }] }
    );
    const chunks = await collect(
      provider.sendQuery('x', '/repo', undefined, { ...BASE_OPTS, nodeConfig: { effort: 'high' } })
    );
    expect(result(chunks)?.errorSubtype).toBe('cursor_model_params_unavailable');
    expect(calls.cfg).toBeUndefined(); // sidecar NOT spawned
  });

  it('fails closed when the catalog is DOWN and only the implicit cost default is in play', async () => {
    const { provider, calls } = makeProvider({ messages: [asst('ok')] }, { unavailable: true });
    const chunks = await collect(provider.sendQuery('x', '/repo', undefined, BASE_OPTS));
    expect(result(chunks)?.errorSubtype).toBe('cursor_model_params_unavailable');
    expect(calls.cfg).toBeUndefined();
  });

  it('with allowPremiumOnDegraded proceeds param-less + a visible system warning when the catalog is DOWN', async () => {
    const { provider, calls } = makeProvider({ messages: [asst('ok')] }, { unavailable: true });
    const chunks = await collect(
      provider.sendQuery('x', '/repo', undefined, {
        ...BASE_OPTS,
        assistantConfig: { allowPremiumOnDegraded: true },
      })
    );
    expect(result(chunks)?.isError).toBeFalsy();
    // Visible (system) premium warning + sidecar spawned param-less.
    const sys = chunks.find(c => c.type === 'system') as Extract<MessageChunk, { type: 'system' }>;
    expect(sys?.content).toMatch(/premium/i);
    expect(calls.cfg).toBeDefined();
    expect(calls.cfg?.modelParams).toBeUndefined();
  });

  it('explicit fast=false ALSO fails closed when the catalog is DOWN (provenance split vs implicit)', async () => {
    const { provider, calls } = makeProvider({ messages: [asst('ok')] }, { unavailable: true });
    const chunks = await collect(
      provider.sendQuery('x', '/repo', undefined, {
        ...BASE_OPTS,
        assistantConfig: { fast: false },
      })
    );
    expect(result(chunks)?.errorSubtype).toBe('cursor_model_params_unavailable');
    expect(calls.cfg).toBeUndefined();
  });

  it('mixed explicit effort + implicit fast with a DOWN catalog fails on the EXPLICIT effort', async () => {
    const { provider, calls } = makeProvider({ messages: [asst('ok')] }, { unavailable: true });
    const chunks = await collect(
      provider.sendQuery('x', '/repo', undefined, { ...BASE_OPTS, nodeConfig: { effort: 'high' } })
    );
    // Fails (no spawn). The explicit effort is the trigger — an unknown model with
    // an explicit knob throws CursorModelParamsError before the cost-default gate.
    expect(result(chunks)?.errorSubtype).toBe('cursor_model_params_unavailable');
    expect(calls.cfg).toBeUndefined();
  });

  it('rejects a present-but-invalid config value with cursor_config_invalid', async () => {
    const { provider, calls } = makeProvider({ messages: [asst('ok')] });
    const chunks = await collect(
      provider.sendQuery('x', '/repo', undefined, {
        ...BASE_OPTS,
        assistantConfig: { fast: 'yes' },
      })
    );
    expect(result(chunks)?.errorSubtype).toBe('cursor_config_invalid');
    expect(calls.cfg).toBeUndefined();
  });

  it('fails before spawn on an explicit thinking knob the model can not express', async () => {
    // gpt-5.4 has reasoning + fast but NO thinking param.
    const { provider, calls } = makeProvider({ messages: [asst('ok')] });
    const chunks = await collect(
      provider.sendQuery('x', '/repo', undefined, {
        ...BASE_OPTS,
        model: 'gpt-5.4',
        nodeConfig: { thinking: { type: 'enabled' } },
      })
    );
    expect(result(chunks)?.errorSubtype).toBe('cursor_model_params_unavailable');
    expect(calls.cfg).toBeUndefined(); // sidecar NOT spawned (compensates the removed DAG warning)
  });

  it('carries model params on the resume path', async () => {
    const { provider, calls } = makeProvider({ messages: [asst('resumed')] });
    await collect(
      provider.sendQuery('again', '/repo', 'agent-prev', {
        ...BASE_OPTS,
        model: 'gpt-5.4',
        nodeConfig: { effort: 'high' },
      })
    );
    expect(calls.cfg?.resumeSessionId).toBe('agent-prev');
    expect(calls.cfg?.modelParams).toContainEqual({ id: 'reasoning', value: 'high' });
  });

  it('forwards CHANGED knobs on a persist_session re-run (resume) request-shape', async () => {
    // A persist_session re-run resumes the prior agent with possibly different
    // knobs. The new REQUEST shape is forwarded; whether a resumed agent actually
    // re-applies changed params server-side is UNOBSERVABLE via the SDK (§0.3).
    const { provider, calls } = makeProvider({ messages: [asst('ok')] });
    await collect(
      provider.sendQuery('again', '/repo', 'agent-prev', {
        ...BASE_OPTS,
        model: 'gpt-5.4',
        nodeConfig: { effort: 'low' },
      })
    );
    expect(calls.cfg?.modelParams).toContainEqual({ id: 'reasoning', value: 'low' });
  });

  describe('param-rejection retry (stale catalog drift)', () => {
    /** A spawnRunner that emits a param-rejection error on the FIRST spawn, then
     *  scripted lines on subsequent spawns. Tracks spawn count + last cfg. */
    function makeRetryRunner(secondAttempt: { errorLine?: string }): {
      spawnRunner: NonNullable<CursorProviderDeps['spawnRunner']>;
      spawns: () => number;
      lastModelParams: () => unknown;
    } {
      let spawns = 0;
      let lastModelParams: unknown;
      const spawnRunner: NonNullable<CursorProviderDeps['spawnRunner']> = (
        _node,
        cfg
      ): CursorRunnerHandle => {
        spawns++;
        lastModelParams = cfg.modelParams;
        const isFirst = spawns === 1;
        async function* lines(): AsyncGenerator<string> {
          await Promise.resolve();
          if (isFirst) {
            // Create-time param rejection — no agent/content emitted first.
            yield JSON.stringify({ kind: 'error', message: 'invalid parameter value for model' });
            return;
          }
          if (secondAttempt.errorLine !== undefined) {
            yield JSON.stringify({ kind: 'error', message: secondAttempt.errorLine });
            return;
          }
          yield JSON.stringify({ kind: 'agent', agentId: 'agent-retry' });
          yield JSON.stringify({ kind: 'msg', message: asst('recovered') });
          yield JSON.stringify({ kind: 'final', status: 'finished' });
        }
        return {
          lines: lines(),
          kill: () => {},
          exited: Promise.resolve({ exitCode: isFirst ? 1 : 0, stderrTail: '' }),
        };
      };
      return { spawnRunner, spawns: () => spawns, lastModelParams: () => lastModelParams };
    }

    it('invalidates + refreshes + retries ONCE on a create-time param rejection, then succeeds', async () => {
      const { spawnRunner, spawns } = makeRetryRunner({});
      const { catalog, forceRefreshes } = makeFakeCatalog({ servedFromDisk: true });
      const provider = new CursorProvider({
        resolveNodePath: () => '/fake/node',
        spawnRunner,
        loadCatalog: async () => catalog,
      });
      const chunks = await collect(provider.sendQuery('x', '/repo', undefined, BASE_OPTS));
      expect(forceRefreshes()).toBe(1); // exactly one refresh
      expect(spawns()).toBe(2); // original + one retry
      expect(chunks.find(c => c.type === 'assistant')).toMatchObject({ content: 'recovered' });
    });

    it('fails after the retry also errors (no infinite loop)', async () => {
      const { spawnRunner, spawns } = makeRetryRunner({ errorLine: 'still invalid parameter' });
      const { catalog, forceRefreshes } = makeFakeCatalog({ servedFromDisk: true });
      const provider = new CursorProvider({
        resolveNodePath: () => '/fake/node',
        spawnRunner,
        loadCatalog: async () => catalog,
      });
      const chunks = await collect(provider.sendQuery('x', '/repo', undefined, BASE_OPTS));
      expect(forceRefreshes()).toBe(1);
      expect(spawns()).toBe(2); // exactly one retry, then give up
      expect(result(chunks)?.isError).toBe(true);
    });

    it('does NOT retry when the catalog was network-fresh (not served from disk)', async () => {
      const { spawnRunner, spawns } = makeRetryRunner({});
      const { catalog, forceRefreshes } = makeFakeCatalog({ servedFromDisk: false });
      const provider = new CursorProvider({
        resolveNodePath: () => '/fake/node',
        spawnRunner,
        loadCatalog: async () => catalog,
      });
      const chunks = await collect(provider.sendQuery('x', '/repo', undefined, BASE_OPTS));
      expect(forceRefreshes()).toBe(0);
      expect(spawns()).toBe(1); // the create-time error surfaces, no retry
      expect(result(chunks)?.isError).toBe(true);
    });

    it('reapplies the cost gate after a refresh DROPS the model — fails closed, no premium retry', async () => {
      // Regression (Cursor Bugbot): the disk snapshot lists composer-1 (gate
      // passes → first spawn), but the refresh drops it, so the retry can no
      // longer verify the fast=false default. The retry MUST re-run the gate and
      // block — not silently spawn param-less and bill at the premium tier.
      const { spawnRunner, spawns } = makeRetryRunner({});
      const { catalog, forceRefreshes } = makeFakeCatalog({
        servedFromDisk: true,
        refreshedModels: [{ id: 'gemini-3-flash', displayName: 'Gemini 3 Flash', parameters: [] }],
      });
      const provider = new CursorProvider({
        resolveNodePath: () => '/fake/node',
        spawnRunner,
        loadCatalog: async () => catalog,
      });
      const chunks = await collect(provider.sendQuery('x', '/repo', undefined, BASE_OPTS));
      expect(forceRefreshes()).toBe(1);
      expect(spawns()).toBe(1); // only the first (rejected) spawn — premium retry blocked
      expect(result(chunks)?.errorSubtype).toBe('cursor_model_params_unavailable');
    });

    it('with allowPremiumOnDegraded, a model dropped on refresh proceeds at premium with a visible warning', async () => {
      const { spawnRunner, spawns } = makeRetryRunner({});
      const { catalog } = makeFakeCatalog({
        servedFromDisk: true,
        refreshedModels: [{ id: 'gemini-3-flash', displayName: 'Gemini 3 Flash', parameters: [] }],
      });
      const provider = new CursorProvider({
        resolveNodePath: () => '/fake/node',
        spawnRunner,
        loadCatalog: async () => catalog,
      });
      const chunks = await collect(
        provider.sendQuery('x', '/repo', undefined, {
          ...BASE_OPTS,
          assistantConfig: { allowPremiumOnDegraded: true },
        })
      );
      expect(spawns()).toBe(2); // opted in → the retry proceeds
      const sys = chunks.find(c => c.type === 'system') as Extract<
        MessageChunk,
        { type: 'system' }
      >;
      expect(sys?.content).toMatch(/premium/i);
    });
  });
});
