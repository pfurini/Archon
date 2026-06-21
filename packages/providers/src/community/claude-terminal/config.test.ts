import { describe, it, expect } from 'bun:test';

import { parseClaudeTerminalConfig } from './config';

describe('parseClaudeTerminalConfig', () => {
  it('keeps valid fields', () => {
    expect(
      parseClaudeTerminalConfig({
        model: 'sonnet',
        claudeBinaryPath: '/usr/bin/claude',
        claudeConfigDir: '~/.archon/claude-home',
        settingSources: ['user'],
        terminalcpCommand: 'npx terminalcp',
        turnTimeoutMs: 5000,
        pollIntervalMs: 200,
        stallTimeoutMs: 240_000,
        maxStallRecoveries: 2,
      })
    ).toEqual({
      model: 'sonnet',
      claudeBinaryPath: '/usr/bin/claude',
      claudeConfigDir: '~/.archon/claude-home',
      settingSources: ['user'],
      terminalcpCommand: 'npx terminalcp',
      turnTimeoutMs: 5000,
      pollIntervalMs: 200,
      stallTimeoutMs: 240_000,
      maxStallRecoveries: 2,
    });
  });

  it('drops a blank or non-string claudeConfigDir', () => {
    expect(parseClaudeTerminalConfig({ claudeConfigDir: '   ' })).toEqual({});
    expect(parseClaudeTerminalConfig({ claudeConfigDir: 123 })).toEqual({});
  });

  it('keeps valid settingSources and filters out unknown entries', () => {
    expect(parseClaudeTerminalConfig({ settingSources: ['user', 'project', 'local'] })).toEqual({
      settingSources: ['user', 'project', 'local'],
    });
    expect(parseClaudeTerminalConfig({ settingSources: ['user', 'bogus', 5] })).toEqual({
      settingSources: ['user'],
    });
  });

  it('drops an empty or non-array settingSources', () => {
    expect(parseClaudeTerminalConfig({ settingSources: [] })).toEqual({});
    expect(parseClaudeTerminalConfig({ settingSources: ['nope'] })).toEqual({});
    expect(parseClaudeTerminalConfig({ settingSources: 'user' })).toEqual({});
  });

  it('keeps maxStallRecoveries: 0 (explicit watchdog disable)', () => {
    expect(parseClaudeTerminalConfig({ maxStallRecoveries: 0 })).toEqual({
      maxStallRecoveries: 0,
    });
  });

  it('drops invalid stall-watchdog fields', () => {
    expect(parseClaudeTerminalConfig({ stallTimeoutMs: 0 })).toEqual({});
    expect(parseClaudeTerminalConfig({ maxStallRecoveries: -1 })).toEqual({});
    expect(parseClaudeTerminalConfig({ maxStallRecoveries: 1.5 })).toEqual({});
  });

  it('drops wrong-typed and unknown fields without throwing', () => {
    expect(parseClaudeTerminalConfig({ model: 123, claudeBinaryPath: false, extra: true })).toEqual(
      {}
    );
  });

  it('drops non-positive / NaN numeric fields', () => {
    expect(parseClaudeTerminalConfig({ turnTimeoutMs: 0 })).toEqual({});
    expect(parseClaudeTerminalConfig({ turnTimeoutMs: -10 })).toEqual({});
    expect(parseClaudeTerminalConfig({ pollIntervalMs: Number.NaN })).toEqual({});
  });

  it('returns empty for empty input', () => {
    expect(parseClaudeTerminalConfig({})).toEqual({});
  });
});
