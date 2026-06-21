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

  if (Array.isArray(raw.settingSources)) {
    const valid = raw.settingSources.filter(
      (s): s is 'user' | 'project' | 'local' => s === 'user' || s === 'project' || s === 'local'
    );
    if (valid.length > 0) {
      result.settingSources = valid;
    }
  }

  if (typeof raw.claudeBinaryPath === 'string') {
    result.claudeBinaryPath = raw.claudeBinaryPath;
  }

  if (typeof raw.claudeConfigDir === 'string' && raw.claudeConfigDir.trim() !== '') {
    result.claudeConfigDir = raw.claudeConfigDir;
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

  if (
    typeof raw.stallTimeoutMs === 'number' &&
    Number.isFinite(raw.stallTimeoutMs) &&
    raw.stallTimeoutMs > 0
  ) {
    result.stallTimeoutMs = raw.stallTimeoutMs;
  }

  // 0 is meaningful (disables the stall watchdog), so >= 0 — unlike the
  // duration fields above, which are nonsensical at 0.
  if (
    typeof raw.maxStallRecoveries === 'number' &&
    Number.isInteger(raw.maxStallRecoveries) &&
    raw.maxStallRecoveries >= 0
  ) {
    result.maxStallRecoveries = raw.maxStallRecoveries;
  }

  return result;
}
