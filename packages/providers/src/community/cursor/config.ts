import type { CursorProviderDefaults } from '../../types';

export type { CursorProviderDefaults };

/**
 * Parse raw YAML-derived config into typed cursor defaults.
 * Defensive: invalid fields are dropped silently (matches parseClaudeConfig,
 * parseCodexConfig, parsePiConfig, parseClaudeTerminalConfig — never throws, so
 * broken user config can't prevent provider registration or workflow
 * discovery).
 */
export function parseCursorConfig(raw: Record<string, unknown>): CursorProviderDefaults {
  const result: CursorProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  return result;
}
