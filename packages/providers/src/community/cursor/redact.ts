/**
 * Secret-masking helper used by every log / error-surface call site in the
 * cursor provider.
 *
 * Any string that may reach a log, a structured-log field, or a user-facing
 * error message (including the `result` chunk's `errors[]`) must first pass
 * through `redactSecrets()`. The transformation is deterministic, stateless,
 * and does not consult the environment, so it is safe to wrap freely.
 *
 * Ported verbatim from gsd-pi's cursor-cli `redact.ts` (the patterns are
 * provider-agnostic; only the consuming context differs).
 */

/** Mask used in place of any matched secret. */
const REDACTED = '[REDACTED]';

const SECRET_PATTERNS: RegExp[] = [
  // `Authorization: Bearer …` headers
  /\bBearer\s+[A-Za-z0-9._\-+/=]{6,}\b/gi,
  // OpenAI-style and generic "sk-…" keys
  /\bsk-[A-Za-z0-9._-]{6,}\b/g,
  // Cursor-issued bearer tokens
  /\bcursor-key-[A-Za-z0-9._-]{6,}\b/gi,
  // JWT three-segment tokens (eyJ… . … . …) — matches header.payload.sig
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];

/**
 * Replace any token that looks like a credential with `[REDACTED]`.
 *
 * Intentionally over-eager: it is cheaper to over-mask than to leak. Callers
 * should pass the full string they intend to emit without pre-filtering.
 */
export function redactSecrets(value: string): string {
  if (!value) return value;
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}
