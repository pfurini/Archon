import type { ClaudeTerminalProviderDefaults } from '../../types';

export type { ClaudeTerminalProviderDefaults };

/**
 * Parse raw YAML-derived config into typed claude-terminal defaults.
 * Defensive: invalid fields are dropped silently (matches parseClaudeConfig,
 * parseCodexConfig, and parsePiConfig — never throws, so broken user config
 * can't prevent provider registration or workflow discovery).
 */
export function parseClaudeTerminalConfig(
  raw: Record<string, unknown>
): ClaudeTerminalProviderDefaults {
  const result: ClaudeTerminalProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (typeof raw.claudeBinaryPath === 'string') {
    result.claudeBinaryPath = raw.claudeBinaryPath;
  }

  if (typeof raw.terminalcpCommand === 'string') {
    result.terminalcpCommand = raw.terminalcpCommand;
  }

  if (
    typeof raw.turnTimeoutMs === 'number' &&
    Number.isFinite(raw.turnTimeoutMs) &&
    raw.turnTimeoutMs > 0
  ) {
    result.turnTimeoutMs = raw.turnTimeoutMs;
  }

  if (
    typeof raw.pollIntervalMs === 'number' &&
    Number.isFinite(raw.pollIntervalMs) &&
    raw.pollIntervalMs > 0
  ) {
    result.pollIntervalMs = raw.pollIntervalMs;
  }

  return result;
}
