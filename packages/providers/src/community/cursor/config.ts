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
 * Thrown when `assistants.cursor.*` contains a present-but-invalid value for a
 * parameter key (`fast`, `context`, `allowPremiumOnDegraded`). The provider maps
 * this to a visible `cursor_config_invalid` result rather than silently dropping
 * the value — a silent drop would invert the cost default (e.g. a mistyped
 * `fast: "false"` string would fall back to premium). Fail-loud (plan §3).
 */
export class CursorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CursorConfigError';
  }
}

/**
 * Parse raw YAML-derived config into typed cursor defaults.
 *
 * `model` stays defensive (a non-string is dropped silently — it only changes
 * which model runs, never billing). The parameter keys `fast` / `context` /
 * `allowPremiumOnDegraded` are STRICT: a present-but-invalid value throws
 * {@link CursorConfigError} (these gate the cost default, so a silent drop is
 * unsafe). Key PRESENCE is preserved for the provider's explicit-vs-implicit
 * provenance check (`Object.hasOwn`).
 */
export function parseCursorConfig(raw: Record<string, unknown>): CursorProviderDefaults {
  const result: CursorProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (Object.hasOwn(raw, 'fast')) {
    if (typeof raw.fast !== 'boolean') {
      throw new CursorConfigError(
        `assistants.cursor.fast must be a boolean (got ${JSON.stringify(raw.fast)}).`
      );
    }
    result.fast = raw.fast;
  }

  if (Object.hasOwn(raw, 'context')) {
    if (typeof raw.context !== 'string' || raw.context.trim() === '') {
      throw new CursorConfigError(
        `assistants.cursor.context must be a non-empty string (got ${JSON.stringify(raw.context)}).`
      );
    }
    result.context = raw.context;
  }

  if (Object.hasOwn(raw, 'allowPremiumOnDegraded')) {
    if (typeof raw.allowPremiumOnDegraded !== 'boolean') {
      throw new CursorConfigError(
        `assistants.cursor.allowPremiumOnDegraded must be a boolean (got ${JSON.stringify(raw.allowPremiumOnDegraded)}).`
      );
    }
    result.allowPremiumOnDegraded = raw.allowPremiumOnDegraded;
  }

  return result;
}
