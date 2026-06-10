import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildClaudeArgs,
  buildLaunchCommand,
  shellQuote,
  expectedTranscriptDir,
  findTranscriptByUuid,
  isTrustPrompt,
} from './launch';

describe('buildClaudeArgs', () => {
  it('turn 1: pins session-id and skips permissions by default', () => {
    expect(buildClaudeArgs({ sessionId: 'u1' })).toEqual([
      '--session-id',
      'u1',
      '--dangerously-skip-permissions',
    ]);
  });

  it('resumed turn: uses --resume <id>, not --session-id, and NEVER --fork-session', () => {
    const args = buildClaudeArgs({ sessionId: 'u0', resume: true });
    expect(args.slice(0, 2)).toEqual(['--resume', 'u0']);
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--fork-session');
  });

  it('maps model, mcp, system prompt, tool restrictions, add-dir', () => {
    const args = buildClaudeArgs({
      sessionId: 'u1',
      model: 'sonnet',
      mcpConfigPaths: ['/cfg/a.json', '/cfg/b.json'],
      appendSystemPrompt: 'be terse',
      allowedTools: ['Bash', 'Read'],
      disallowedTools: ['WebFetch'],
      addDirs: ['/extra'],
    });
    expect(args).toEqual([
      '--session-id',
      'u1',
      '--model',
      'sonnet',
      '--dangerously-skip-permissions',
      '--mcp-config',
      '/cfg/a.json',
      '--mcp-config',
      '/cfg/b.json',
      '--append-system-prompt',
      'be terse',
      '--allowed-tools',
      'Bash',
      'Read',
      '--disallowed-tools',
      'WebFetch',
      '--add-dir',
      '/extra',
    ]);
  });

  it('uses permission-mode when not skipping permissions', () => {
    const args = buildClaudeArgs({
      sessionId: 'u1',
      dangerouslySkipPermissions: false,
      permissionMode: 'acceptEdits',
    });
    expect(args).toEqual(['--session-id', 'u1', '--permission-mode', 'acceptEdits']);
  });
});

describe('shellQuote / buildLaunchCommand', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });

  it('builds cd + env-strip + binary + args, injecting env overrides', () => {
    const cmd = buildLaunchCommand('/bin/claude', ['--session-id', 'u1'], '/work dir', {
      API_KEY: 's3cret',
    });
    expect(cmd).toBe(
      "cd '/work dir' && env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_EFFORT API_KEY='s3cret' '/bin/claude' '--session-id' 'u1'"
    );
  });
});

describe('expectedTranscriptDir', () => {
  it('dashes the path (slashes and dots → dashes)', async () => {
    const dir = await expectedTranscriptDir('/nonexistent/My.Proj/sub');
    expect(dir).toBe('-nonexistent-My-Proj-sub');
  });
});

describe('isTrustPrompt', () => {
  it('detects the folder-trust dialog', () => {
    expect(isTrustPrompt('Is this a project you created or one you trust?')).toBe(true);
    expect(isTrustPrompt('Yes, I trust this folder')).toBe(true);
  });
  it('is false for a normal idle screen', () => {
    expect(isTrustPrompt('❯ \nModel: Sonnet 4.6')).toBe(false);
  });
});

describe('findTranscriptByUuid', () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('finds <uuid>.jsonl under a project dir regardless of dir name', async () => {
    // Build a fake ~/.claude/projects structure and point HOME at it.
    home = mkdtempSync(join(tmpdir(), 'archon-home-'));
    const projDir = join(home, '.claude', 'projects', '-some-weird-dir');
    mkdirSync(projDir, { recursive: true });
    const uuid = 'a1b2c3d4-0000-4000-8000-00000000ffff';
    writeFileSync(join(projDir, `${uuid}.jsonl`), '{}\n');

    const root = join(home, '.claude', 'projects');
    const found = await findTranscriptByUuid(uuid, root);
    expect(found).toBe(join(projDir, `${uuid}.jsonl`));
    expect(await findTranscriptByUuid('no-such-uuid', root)).toBeNull();
  });
});
