import { describe, it, expect } from 'bun:test';

import { parseClaudeTerminalConfig } from './config';

describe('parseClaudeTerminalConfig', () => {
  it('keeps valid fields', () => {
    expect(
      parseClaudeTerminalConfig({
        model: 'sonnet',
        claudeBinaryPath: '/usr/bin/claude',
        terminalcpCommand: 'npx terminalcp',
        turnTimeoutMs: 5000,
        pollIntervalMs: 200,
      })
    ).toEqual({
      model: 'sonnet',
      claudeBinaryPath: '/usr/bin/claude',
      terminalcpCommand: 'npx terminalcp',
      turnTimeoutMs: 5000,
      pollIntervalMs: 200,
    });
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
