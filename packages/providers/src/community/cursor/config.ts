import type { CursorProviderDefaults } from '../../types';

export type { CursorProviderDefaults };

/**
 * Built-in default model for bare `provider: cursor` (no node/workflow/tier/config
 * model). Cursor-native Composer 2.5 — a balanced coding model that needs no
 * upstream-vendor routing. Verified present in `Cursor.models.list()`. Tier
 * keywords (small/medium/large) resolve via tier-defaults and take precedence.
 */
export const DEFAULT_CURSOR_MODEL = 'composer-2.5';

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
