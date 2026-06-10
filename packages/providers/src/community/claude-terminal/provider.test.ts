import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeTerminalProvider } from './provider';
import type { TerminalDriver } from './terminalcp';
import type { MessageChunk } from '../../types';

// ── Fixtures ──────────────────────────────────────────────────────────────
const TURN_LINES =
  [
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hi' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    }),
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hi' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Done' }],
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 8 },
      },
    }),
  ].join('\n') + '\n';

const TOOL_ONLY_LINE =
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }) + '\n';

const IDLE_SCREEN = '────────\n❯ \n────────\n  Model: Sonnet 4.6 │ Time: 5s';
// A mid-generation screen with ANSI chrome — what a stalled TUI typically shows.
const WORKING_SCREEN = '\x1b[2mold log line\x1b[0m\n✻ Cultivating… (123s · thinking)';
const TRUST_SCREEN =
  'Is this a project you created or one you trust?\n❯ 1. Yes, I trust this folder';

// Scripted terminal driver. `onPaste` simulates Claude writing the transcript
// once our prompt is pasted in.
class FakeDriver implements TerminalDriver {
  readonly calls: { m: string; segments?: string[] }[] = [];
  private i = 0;
  constructor(
    private readonly screens: string[],
    private readonly onPaste?: () => void,
    private readonly alive: () => boolean | undefined = () => true
  ) {}
  async start(): Promise<string> {
    this.calls.push({ m: 'start' });
    return 'session';
  }
  async stdin(_name: string, segments: string[]): Promise<void> {
    this.calls.push({ m: 'stdin', segments });
    if (this.onPaste && segments.some(s => s.startsWith('\x1b[200~'))) this.onPaste();
  }
  async stdout(): Promise<string> {
    const s = this.screens[Math.min(this.i, this.screens.length - 1)];
    this.i++;
    return s;
  }
  async isSessionAlive(): Promise<boolean | undefined> {
    return this.alive();
  }
  async stop(): Promise<void> {
    this.calls.push({ m: 'stop' });
  }
  stdins(): (string[] | undefined)[] {
    return this.calls.filter(c => c.m === 'stdin').map(c => c.segments);
  }
}

async function drain(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

describe('ClaudeTerminalProvider', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('identity + capabilities', () => {
    const p = new ClaudeTerminalProvider();
    expect(p.getType()).toBe('claude-terminal');
    expect(p.getCapabilities().sessionResume).toBe(true);
    expect(p.getCapabilities().nativeTools).toBe(false);
  });

  it('happy path: boot → trust → inject → tail → result, then stops session', async () => {
    dir = mkdtempSync(join(tmpdir(), 'archon-ct-'));
    const tpath = join(dir, 'sess.jsonl');
    const driver = new FakeDriver([TRUST_SCREEN, IDLE_SCREEN], () =>
      writeFileSync(tpath, TURN_LINES)
    );
    const provider = new ClaudeTerminalProvider({
      createClient: () => driver,
      resolveBinary: async () => '/fake/claude',
      findTranscript: async () => (existsSync(tpath) ? tpath : null),
      sleep: async () => {},
    });

    const chunks = await drain(provider.sendQuery('do it', '/work'));

    expect(chunks.map(c => c.type)).toEqual([
      'thinking',
      'tool',
      'tool_result',
      'assistant',
      'result',
    ]);
    const result = chunks.at(-1) as Extract<MessageChunk, { type: 'result' }>;
    expect(typeof result.sessionId).toBe('string');
    expect(result.tokens?.output).toBe(18); // 10 + 8 summed across the turn
    expect(result.stopReason).toBe('end_turn');

    const stdins = driver.stdins();
    expect(stdins).toContainEqual(['::Enter']); // trust accepted
    expect(stdins).toContainEqual(['::C-u']); // input box cleared before paste
    expect(
      stdins.some(
        s => s?.[0]?.startsWith('\x1b[200~') && s[0].includes('do it') && s[1] === '::Enter'
      )
    ).toBe(true); // bracketed-paste prompt + Enter
    expect(driver.calls.some(c => c.m === 'stop')).toBe(true);
  });

  it('augments the prompt with the schema when output_format is requested', async () => {
    dir = mkdtempSync(join(tmpdir(), 'archon-ct-'));
    const tpath = join(dir, 'sess.jsonl');
    const structured =
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: '{"ok": true}' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }) + '\n';
    const driver = new FakeDriver([IDLE_SCREEN], () => writeFileSync(tpath, structured));
    const provider = new ClaudeTerminalProvider({
      createClient: () => driver,
      resolveBinary: async () => '/c',
      findTranscript: async () => (existsSync(tpath) ? tpath : null),
      sleep: async () => {},
    });

    const chunks = await drain(
      provider.sendQuery('give json', '/work', undefined, {
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      })
    );
    const result = chunks.at(-1) as Extract<MessageChunk, { type: 'result' }>;
    expect(result.structuredOutput).toEqual({ ok: true });
    // The pasted prompt carries the JSON-only instruction.
    const paste = driver.stdins().find(s => s?.[0]?.startsWith('\x1b[200~'));
    expect(paste?.[0]).toContain('JSON');
  });

  it('aborts cleanly and still stops the session', async () => {
    const controller = new AbortController();
    controller.abort();
    const driver = new FakeDriver([IDLE_SCREEN]);
    const provider = new ClaudeTerminalProvider({
      createClient: () => driver,
      resolveBinary: async () => '/c',
      findTranscript: async () => null,
      sleep: async () => {},
    });
    await expect(
      drain(provider.sendQuery('hi', '/w', undefined, { abortSignal: controller.signal }))
    ).rejects.toThrow('Query aborted');
    expect(driver.calls.some(c => c.m === 'stop')).toBe(true);
  });

  it('fails fast when the TUI process dies mid-turn (no hang to timeout)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'archon-ct-'));
    const tpath = join(dir, 'sess.jsonl');
    // Tool-only line never reaches a terminal stop_reason → without the
    // liveness guard this would hang to turnTimeoutMs. Session reports dead.
    const driver = new FakeDriver(
      [IDLE_SCREEN],
      () => writeFileSync(tpath, TOOL_ONLY_LINE),
      () => false
    );
    const provider = new ClaudeTerminalProvider({
      createClient: () => driver,
      resolveBinary: async () => '/c',
      findTranscript: async () => (existsSync(tpath) ? tpath : null),
      sleep: async () => {},
    });
    await expect(drain(provider.sendQuery('hi', '/w'))).rejects.toThrow(
      /exited before completing the turn/
    );
    expect(driver.calls.some(c => c.m === 'stop')).toBe(true);
  });

  it('throws when the turn exceeds the timeout (transcript never completes)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'archon-ct-'));
    const tpath = join(dir, 'sess.jsonl');
    const driver = new FakeDriver([IDLE_SCREEN], () => writeFileSync(tpath, TOOL_ONLY_LINE));
    // Clock returns 0 for boot + deadline calc, then jumps far past the deadline
    // so the poll loop trips the timeout. Zeros keep ensureInputReady happy.
    const times = new Array(10).fill(0);
    let n = 0;
    const provider = new ClaudeTerminalProvider({
      createClient: () => driver,
      resolveBinary: async () => '/c',
      findTranscript: async () => (existsSync(tpath) ? tpath : null),
      sleep: async () => {},
      now: () => (n < times.length ? times[n++] : 10_000_000),
    });
    await expect(drain(provider.sendQuery('hi', '/w'))).rejects.toThrow(
      /exceeded .* without completing/
    );
    expect(driver.calls.some(c => c.m === 'stop')).toBe(true);
  });

  it('does not fail-fast on an inconclusive liveness check (transient list failure)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'archon-ct-'));
    const tpath = join(dir, 'sess.jsonl');
    // alive=undefined every poll (e.g. flaky `list`). Must NOT trip the
    // dead-session throw; the turn instead runs out the timeout backstop.
    const driver = new FakeDriver(
      [IDLE_SCREEN],
      () => writeFileSync(tpath, TOOL_ONLY_LINE),
      () => undefined
    );
    const times = new Array(10).fill(0);
    let n = 0;
    const provider = new ClaudeTerminalProvider({
      createClient: () => driver,
      resolveBinary: async () => '/c',
      findTranscript: async () => (existsSync(tpath) ? tpath : null),
      sleep: async () => {},
      now: () => (n < times.length ? times[n++] : 10_000_000),
    });
    // Timeout error, NOT "exited before completing" — inconclusive ≠ dead.
    await expect(drain(provider.sendQuery('hi', '/w'))).rejects.toThrow(
      /exceeded .* without completing/
    );
  });

  it('timeout error carries the last screen tail, ANSI-stripped', async () => {
    dir = mkdtempSync(join(tmpdir(), 'archon-ct-'));
    const tpath = join(dir, 'sess.jsonl');
    // Boot sees the idle screen; every poll after that sees the working screen.
    const driver = new FakeDriver([IDLE_SCREEN, WORKING_SCREEN], () =>
      writeFileSync(tpath, TOOL_ONLY_LINE)
    );
    const times = new Array(10).fill(0);
    let n = 0;
    const provider = new ClaudeTerminalProvider({
      createClient: () => driver,
      resolveBinary: async () => '/c',
      findTranscript: async () => (existsSync(tpath) ? tpath : null),
      sleep: async () => {},
      now: () => (n < times.length ? times[n++] : 10_000_000),
    });
    const err = (await drain(provider.sendQuery('hi', '/w')).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/exceeded .* without completing/);
    expect(err.message).toContain('Last screen:');
    expect(err.message).toContain('Cultivating… (123s');
    expect(err.message).not.toContain('\x1b[');
  });

  it('dead-session error carries the last screen tail', async () => {
    dir = mkdtempSync(join(tmpdir(), 'archon-ct-'));
    const tpath = join(dir, 'sess.jsonl');
    const driver = new FakeDriver(
      [IDLE_SCREEN, WORKING_SCREEN],
      () => writeFileSync(tpath, TOOL_ONLY_LINE),
      () => false
    );
    const provider = new ClaudeTerminalProvider({
      createClient: () => driver,
      resolveBinary: async () => '/c',
      findTranscript: async () => (existsSync(tpath) ? tpath : null),
      sleep: async () => {},
    });
    const err = (await drain(provider.sendQuery('hi', '/w')).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/exited before completing the turn/);
    expect(err.message).toContain('Last screen:');
    expect(err.message).toContain('Cultivating… (123s');
  });

  it('boot-timeout error carries the last screen tail', async () => {
    const driver = new FakeDriver([WORKING_SCREEN]); // never becomes input-ready
    const times = [0, 1]; // deadline calc, one loop iteration; then far past
    let n = 0;
    const provider = new ClaudeTerminalProvider({
      createClient: () => driver,
      resolveBinary: async () => '/c',
      findTranscript: async () => null,
      sleep: async () => {},
      now: () => (n < times.length ? times[n++] : 10_000_000),
    });
    const err = (await drain(provider.sendQuery('hi', '/w')).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/did not become input-ready/);
    expect(err.message).toContain('Last screen:');
    expect(err.message).toContain('Cultivating… (123s');
    expect(driver.calls.some(c => c.m === 'stop')).toBe(true);
  });
});
