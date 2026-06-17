import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, appendFileSync, existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

// A turn stalled BETWEEN requests: the tool round-trip completed (tool_result
// delivered, openToolUses back to 0) but the next assistant message never came —
// the exact transcript signature of a wedged API turn.
const STALLED_AFTER_TOOL_LINES =
  [
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 5 },
      },
    }),
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    }),
  ].join('\n') + '\n';

const COMPLETION_LINE =
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'Recovered' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
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
  async start(_name: string, command: string): Promise<string> {
    this.calls.push({ m: 'start', segments: [command] });
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

  it('default binary resolver honors configured claudeBinaryPath in dev mode (#3)', async () => {
    // No resolveBinary injected → exercises the real default binding. The bug:
    // in dev mode the resolver dropped the config path and the provider fell back
    // to PATH. The fix opts in (`honorConfigInDevMode`), so a missing configured
    // path now fails fast. This test guards the *wiring* — a revert of the
    // one-line binding to bare `resolveClaudeBinaryPath` would make it return
    // undefined → Bun.which → no throw, and this test would catch it.
    const prevEnv = process.env.CLAUDE_BIN_PATH; // env wins over config — keep it out of the way
    delete process.env.CLAUDE_BIN_PATH;
    try {
      const driver = new FakeDriver([IDLE_SCREEN]);
      const provider = new ClaudeTerminalProvider({
        createClient: () => driver,
        findTranscript: async () => null,
        sleep: async () => {},
      });

      await expect(
        drain(
          provider.sendQuery('do it', '/work', undefined, {
            assistantConfig: { claudeBinaryPath: '/nonexistent/claude-xyz' },
          })
        )
      ).rejects.toThrow(
        'assistants.claude-terminal.claudeBinaryPath is set to "/nonexistent/claude-xyz" but the file does not exist'
      );
    } finally {
      if (prevEnv !== undefined) process.env.CLAUDE_BIN_PATH = prevEnv;
    }
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

  it('passes node effort through to the launch command as --effort', async () => {
    dir = mkdtempSync(join(tmpdir(), 'archon-ct-'));
    const tpath = join(dir, 'sess.jsonl');
    const driver = new FakeDriver([IDLE_SCREEN], () => writeFileSync(tpath, TURN_LINES));
    const provider = new ClaudeTerminalProvider({
      createClient: () => driver,
      resolveBinary: async () => '/fake/claude',
      findTranscript: async () => (existsSync(tpath) ? tpath : null),
      sleep: async () => {},
    });

    await drain(provider.sendQuery('do it', '/work', undefined, { nodeConfig: { effort: 'max' } }));

    const startCmd = driver.calls.find(c => c.m === 'start')?.segments?.[0] ?? '';
    // claude-terminal's effort map is identity, so canonical 'max' stays 'max'.
    expect(startCmd).toContain('--effort');
    expect(startCmd).toContain('max');
  });

  it('omits --effort from the launch command when no node effort is set', async () => {
    dir = mkdtempSync(join(tmpdir(), 'archon-ct-'));
    const tpath = join(dir, 'sess.jsonl');
    const driver = new FakeDriver([IDLE_SCREEN], () => writeFileSync(tpath, TURN_LINES));
    const provider = new ClaudeTerminalProvider({
      createClient: () => driver,
      resolveBinary: async () => '/fake/claude',
      findTranscript: async () => (existsSync(tpath) ? tpath : null),
      sleep: async () => {},
    });

    await drain(provider.sendQuery('do it', '/work'));

    const startCmd = driver.calls.find(c => c.m === 'start')?.segments?.[0] ?? '';
    expect(startCmd).not.toContain('--effort');
  });

  describe('CLAUDE_CONFIG_DIR isolation', () => {
    // The resolver reads ambient process.env.CLAUDE_CONFIG_DIR as a fallback
    // source; pin it OFF so these assertions don't depend on the dev/CI env
    // (mirrors the CLAUDE_BIN_PATH delete/restore dance above).
    let prevAmbient: string | undefined;
    afterEach(() => {
      if (prevAmbient !== undefined) process.env.CLAUDE_CONFIG_DIR = prevAmbient;
      else delete process.env.CLAUDE_CONFIG_DIR;
      prevAmbient = undefined;
    });
    function clearAmbient(): void {
      prevAmbient = process.env.CLAUDE_CONFIG_DIR;
      delete process.env.CLAUDE_CONFIG_DIR;
    }

    it('injects the configured dir into the launch env AND scans it for the transcript', async () => {
      clearAmbient();
      dir = mkdtempSync(join(tmpdir(), 'archon-ct-'));
      const tpath = join(dir, 'sess.jsonl');
      const roots: (string | undefined)[] = [];
      const driver = new FakeDriver([IDLE_SCREEN], () => writeFileSync(tpath, TURN_LINES));
      const provider = new ClaudeTerminalProvider({
        createClient: () => driver,
        resolveBinary: async () => '/fake/claude',
        findTranscript: async (_id, root) => {
          roots.push(root);
          return existsSync(tpath) ? tpath : null;
        },
        sleep: async () => {},
      });

      await drain(
        provider.sendQuery('do it', '/work', undefined, {
          assistantConfig: { claudeConfigDir: '/srv/archon-claude' },
        })
      );

      const startCmd = driver.calls.find(c => c.m === 'start')?.segments?.[0] ?? '';
      // Write side: child env carries the (single-quoted) resolved absolute dir.
      expect(startCmd).toContain("CLAUDE_CONFIG_DIR='/srv/archon-claude'");
      // Read side: every transcript scan targets <configDir>/projects.
      expect(roots.length).toBeGreaterThan(0);
      expect(roots.every(r => r === join('/srv/archon-claude', 'projects'))).toBe(true);
    });

    it('a codebase CLAUDE_CONFIG_DIR env var overrides the config option', async () => {
      clearAmbient();
      dir = mkdtempSync(join(tmpdir(), 'archon-ct-'));
      const tpath = join(dir, 'sess.jsonl');
      const roots: (string | undefined)[] = [];
      const driver = new FakeDriver([IDLE_SCREEN], () => writeFileSync(tpath, TURN_LINES));
      const provider = new ClaudeTerminalProvider({
        createClient: () => driver,
        resolveBinary: async () => '/fake/claude',
        findTranscript: async (_id, root) => {
          roots.push(root);
          return existsSync(tpath) ? tpath : null;
        },
        sleep: async () => {},
      });

      await drain(
        provider.sendQuery('do it', '/work', undefined, {
          assistantConfig: { claudeConfigDir: '/from/config' },
          env: { CLAUDE_CONFIG_DIR: '/from/env' },
        })
      );

      const startCmd = driver.calls.find(c => c.m === 'start')?.segments?.[0] ?? '';
      expect(startCmd).toContain("CLAUDE_CONFIG_DIR='/from/env'");
      expect(startCmd).not.toContain('/from/config');
      expect(roots.every(r => r === join('/from/env', 'projects'))).toBe(true);
    });

    it('no explicit source → no injection, default ~/.claude/projects scanned (byte-identical)', async () => {
      clearAmbient();
      dir = mkdtempSync(join(tmpdir(), 'archon-ct-'));
      const tpath = join(dir, 'sess.jsonl');
      const roots: (string | undefined)[] = [];
      const driver = new FakeDriver([IDLE_SCREEN], () => writeFileSync(tpath, TURN_LINES));
      const provider = new ClaudeTerminalProvider({
        createClient: () => driver,
        resolveBinary: async () => '/fake/claude',
        findTranscript: async (_id, root) => {
          roots.push(root);
          return existsSync(tpath) ? tpath : null;
        },
        sleep: async () => {},
      });

      await drain(provider.sendQuery('do it', '/work'));

      const startCmd = driver.calls.find(c => c.m === 'start')?.segments?.[0] ?? '';
      expect(startCmd).not.toContain('CLAUDE_CONFIG_DIR');
      expect(roots.every(r => r === join(homedir(), '.claude', 'projects'))).toBe(true);
    });

    it('honors an ambient CLAUDE_CONFIG_DIR on the read side (fixes the latent desync)', async () => {
      clearAmbient();
      process.env.CLAUDE_CONFIG_DIR = '/ambient/claude';
      dir = mkdtempSync(join(tmpdir(), 'archon-ct-'));
      const tpath = join(dir, 'sess.jsonl');
      const roots: (string | undefined)[] = [];
      const driver = new FakeDriver([IDLE_SCREEN], () => writeFileSync(tpath, TURN_LINES));
      const provider = new ClaudeTerminalProvider({
        createClient: () => driver,
        resolveBinary: async () => '/fake/claude',
        findTranscript: async (_id, root) => {
          roots.push(root);
          return existsSync(tpath) ? tpath : null;
        },
        sleep: async () => {},
      });

      await drain(provider.sendQuery('do it', '/work'));

      expect(roots.every(r => r === join('/ambient/claude', 'projects'))).toBe(true);
    });
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

  it('stall watchdog: replaces a wedged session (--resume + "continue") and the turn completes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'archon-ct-'));
    const tpath = join(dir, 'sess.jsonl');
    let pastes = 0;
    const driver = new FakeDriver([IDLE_SCREEN], () => {
      pastes++;
      if (pastes === 1) writeFileSync(tpath, STALLED_AFTER_TOOL_LINES);
      else appendFileSync(tpath, COMPLETION_LINE); // the "continue" nudge gets answered
    });
    let t = 0;
    const provider = new ClaudeTerminalProvider({
      createClient: () => driver,
      resolveBinary: async () => '/c',
      findTranscript: async () => (existsSync(tpath) ? tpath : null),
      sleep: async () => {
        t += 100_000; // each poll advances 100s of fake time
      },
      now: () => t,
    });

    const chunks = await drain(provider.sendQuery('do it', '/w'));
    expect(chunks.at(-1)?.type).toBe('result');

    const starts = driver.calls.filter(c => c.m === 'start');
    expect(starts.length).toBe(2); // original spawn + watchdog respawn
    expect(starts[0].segments?.[0]).toContain('--session-id');
    expect(starts[1].segments?.[0]).toContain('--resume');
    const pasted = driver.stdins().filter(s => s?.[0]?.startsWith('\x1b[200~'));
    expect(pasted.length).toBe(2);
    expect(pasted[1]?.[0]).toContain('continue');
  });

  it('stall watchdog: never fires while a tool call is in flight', async () => {
    dir = mkdtempSync(join(tmpdir(), 'archon-ct-'));
    const tpath = join(dir, 'sess.jsonl');
    // Open tool_use with no tool_result: silence is expected (a long-running
    // tool writes nothing) — the watchdog must stay quiet up to the deadline.
    const driver = new FakeDriver([IDLE_SCREEN], () => writeFileSync(tpath, TOOL_ONLY_LINE));
    let t = 0;
    const provider = new ClaudeTerminalProvider({
      createClient: () => driver,
      resolveBinary: async () => '/c',
      findTranscript: async () => (existsSync(tpath) ? tpath : null),
      sleep: async () => {
        t += 100_000;
      },
      now: () => t,
    });

    const err = (await drain(provider.sendQuery('hi', '/w')).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/exceeded .* without completing/);
    expect(driver.calls.filter(c => c.m === 'start').length).toBe(1); // no respawn
  });

  it('stall watchdog: recoveries are capped — the turn deadline stays the backstop', async () => {
    dir = mkdtempSync(join(tmpdir(), 'archon-ct-'));
    const tpath = join(dir, 'sess.jsonl');
    let pastes = 0;
    const driver = new FakeDriver([IDLE_SCREEN], () => {
      pastes++;
      if (pastes === 1) writeFileSync(tpath, STALLED_AFTER_TOOL_LINES);
      // later pastes: the model stays silent — still wedged after recovery
    });
    let t = 0;
    const provider = new ClaudeTerminalProvider({
      createClient: () => driver,
      resolveBinary: async () => '/c',
      findTranscript: async () => (existsSync(tpath) ? tpath : null),
      sleep: async () => {
        t += 100_000;
      },
      now: () => t,
    });

    const err = (await drain(provider.sendQuery('hi', '/w')).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/exceeded .* without completing/);
    expect(driver.calls.filter(c => c.m === 'start').length).toBe(2); // exactly one recovery
  });
});
