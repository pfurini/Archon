/**
 * Cursor token-usage mapping.
 *
 * The SDK delivers usage ONLY via the `onDelta` `turn-ended` interaction update
 * (camelCase `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`).
 * `mapCursorUsage` converts that block into Archon's `TokenUsage`. Cost is left
 * unset — Cursor bills against the user's subscription and exposes no per-run
 * dollar figure.
 */
import type { TokenUsage } from '../../types';

import type { CursorUsage } from './sdk-types';

/** Zero-token usage — used when no `turn-ended` block was ever delivered. */
export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, total: 0 };

/**
 * Convert a Cursor `turn-ended` usage block into Archon's `TokenUsage`.
 * `total` is input + output (cache tokens are a subset of input, not additive).
 */
export function mapCursorUsage(usage: CursorUsage | undefined): TokenUsage {
  if (!usage) return { ...ZERO_USAGE };
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return { input, output, total: input + output };
}
