import { describe, it, expect } from 'bun:test';

import { ServerGate, TerminalcpClient, bracketedPaste, type ExecFn } from './terminalcp';

interface Call {
  file: string;
  args: string[];
}

function recorder(stdout = ''): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFn = async (file, args) => {
    calls.push({ file, args });
    return { stdout, stderr: '' };
  };
  return { exec, calls };
}

describe('TerminalcpClient', () => {
  it('parses the command into file + base args', async () => {
    const { exec, calls } = recorder('sess-id\n');
    const c = new TerminalcpClient({ command: 'npx -y @mariozechner/terminalcp', exec });
    const id = await c.start('s1', 'cd /tmp && claude');
    expect(id).toBe('sess-id');
    expect(calls[0].file).toBe('npx');
    expect(calls[0].args).toEqual([
      '-y',
      '@mariozechner/terminalcp',
      'start',
      's1',
      'cd /tmp && claude',
    ]);
  });

  it('passes stdin segments through as args (text + ::keys)', async () => {
    const { exec, calls } = recorder();
    const c = new TerminalcpClient({ command: 'tcp', exec });
    await c.stdin('s1', [bracketedPaste('hello\nworld'), '::Enter']);
    expect(calls[0].args).toEqual(['stdin', 's1', '\x1b[200~hello\nworld\x1b[201~', '::Enter']);
  });

  it('reads screen with an optional line limit', async () => {
    const { exec, calls } = recorder('SCREEN');
    const c = new TerminalcpClient({ command: 'tcp', exec });
    expect(await c.stdout('s1', 18)).toBe('SCREEN');
    expect(calls[0].args).toEqual(['stdout', 's1', '18']);
    await c.stdout('s1');
    expect(calls[1].args).toEqual(['stdout', 's1']);
  });

  it('isSessionAlive reflects per-session status from `list` (running/stopped/absent)', async () => {
    // Real terminalcp CLI `list` output: an indented block per session
    // ("  <id>\n    Status: …"), NOT a single "id status …" line.
    const listOut = [
      '  archon-ct-1',
      '    Status: running',
      '    CWD: /work',
      '    Command: claude',
      '',
      '  other',
      '    Status: stopped',
      '    CWD: /x',
      '    Command: claude',
      '',
    ].join('\n');
    const c = new TerminalcpClient({ command: 'tcp', exec: recorder(listOut).exec });
    expect(await c.isSessionAlive('archon-ct-1')).toBe(true);
    expect(await c.isSessionAlive('other')).toBe(false); // child exited
    expect(await c.isSessionAlive('missing')).toBe(false); // not listed
  });

  it('isSessionAlive: "No active sessions" is gone (false); a failed list is inconclusive (undefined)', async () => {
    const empty = new TerminalcpClient({
      command: 'tcp',
      exec: recorder('No active sessions\n').exec,
    });
    expect(await empty.isSessionAlive('s1')).toBe(false); // successful list, absent → confirmed gone
    const down = new TerminalcpClient({
      command: 'tcp',
      exec: async () => {
        throw new Error('No server running');
      },
    });
    expect(await down.isSessionAlive('s1')).toBeUndefined(); // list itself failed → inconclusive
  });

  it('maps posix_spawnp failures to an actionable spawn-helper hint', async () => {
    const exec: ExecFn = async () => {
      throw new Error('Command failed: Failed to start session: posix_spawnp failed.');
    };
    const c = new TerminalcpClient({ command: 'tcp', exec });
    await expect(c.start('s1', 'claude')).rejects.toThrow(/spawn-helper/);
  });

  it('stop() is tolerant of a missing session', async () => {
    const exec: ExecFn = async () => {
      throw new Error('Process not found: s1');
    };
    const c = new TerminalcpClient({ command: 'tcp', exec });
    await expect(c.stop('s1')).resolves.toBeUndefined();
  });

  it('bracketedPaste wraps with paste markers', () => {
    expect(bracketedPaste('x')).toBe('\x1b[200~x\x1b[201~');
  });
});

describe('ServerGate', () => {
  const ok = async (): Promise<{ stdout: string; stderr: string }> => ({
    stdout: 'sess\n',
    stderr: '',
  });

  it('serializes concurrent first starts (only one runs until it settles)', async () => {
    const calls: Call[] = [];
    let release!: () => void;
    const firstDone = new Promise<void>(resolve => {
      release = resolve;
    });
    const exec: ExecFn = async (file, args) => {
      calls.push({ file, args });
      if (calls.length === 1) await firstDone;
      return ok();
    };
    const gate = new ServerGate();
    const a = new TerminalcpClient({ command: 'tcp', exec, serverGate: gate });
    const b = new TerminalcpClient({ command: 'tcp', exec, serverGate: gate });

    const p1 = a.start('s1', 'claude');
    const p2 = b.start('s2', 'claude');
    await new Promise(resolve => setTimeout(resolve, 20));
    // The daemon-spawning first start is still in flight — the second must wait.
    expect(calls.length).toBe(1);
    release();
    await Promise.all([p1, p2]);
    expect(calls.length).toBe(2);
    expect(calls.every(c => c.args[0] === 'start')).toBe(true);
  });

  it('does not serialize once a first start has succeeded', async () => {
    const calls: Call[] = [];
    const exec: ExecFn = async (file, args) => {
      calls.push({ file, args });
      return ok();
    };
    const gate = new ServerGate();
    const c = new TerminalcpClient({ command: 'tcp', exec, serverGate: gate });
    await c.start('s1', 'claude');
    // Both later starts run concurrently through the open gate.
    await Promise.all([c.start('s2', 'claude'), c.start('s3', 'claude')]);
    expect(calls.length).toBe(3);
  });

  it('recovers from a version mismatch: kill-server, then retry the start', async () => {
    const calls: Call[] = [];
    const exec: ExecFn = async (file, args) => {
      calls.push({ file, args });
      if (calls.length === 1) {
        throw new Error(
          'Server version mismatch: server is v1.2.0, client is v1.3.3. ' +
            "Please run 'terminalcp kill-server' to stop the old server."
        );
      }
      return ok();
    };
    const c = new TerminalcpClient({ command: 'tcp', exec, serverGate: new ServerGate() });
    const id = await c.start('s1', 'claude');
    expect(id).toBe('sess');
    expect(calls.map(call => call.args[0])).toEqual(['start', 'kill-server', 'start']);
  });

  it('retries the start even when kill-server itself fails (already-dead server)', async () => {
    const calls: Call[] = [];
    const exec: ExecFn = async (file, args) => {
      calls.push({ file, args });
      if (calls.length === 1) throw new Error('Server version mismatch: server is pre-v1.2.2');
      if (args[0] === 'kill-server') throw new Error('No server running');
      return ok();
    };
    const c = new TerminalcpClient({ command: 'tcp', exec, serverGate: new ServerGate() });
    expect(await c.start('s1', 'claude')).toBe('sess');
    expect(calls.map(call => call.args[0])).toEqual(['start', 'kill-server', 'start']);
  });

  it('propagates a non-mismatch failure and lets the next start try again', async () => {
    const calls: Call[] = [];
    const exec: ExecFn = async (file, args) => {
      calls.push({ file, args });
      if (calls.length === 1) throw new Error('boom');
      return ok();
    };
    const gate = new ServerGate();
    const c = new TerminalcpClient({ command: 'tcp', exec, serverGate: gate });
    await expect(c.start('s1', 'claude')).rejects.toThrow(/boom/);
    // The gate did not open; the next start runs (re-serialized) and succeeds.
    expect(await c.start('s2', 'claude')).toBe('sess');
    expect(calls.map(call => call.args[0])).toEqual(['start', 'start']);
  });
});
