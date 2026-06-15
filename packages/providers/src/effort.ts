/**
 * Canonical effort scale + the per-provider effort mapper.
 *
 * Archon exposes ONE provider-agnostic effort vocabulary — `low | medium | high
 * | max` (mirrors `effortLevelSchema` in @archon/workflows). Each provider renders
 * that canonical level into its native vocabulary here, in a single central table.
 * This mirrors the built-in model-tier defaults (`tier-defaults.json` →
 * `TIER_DEFAULTS`): one source of truth keyed by provider id, rather than the
 * effort vocabulary being re-derived independently in each provider.
 *
 * Providers that can't express a rung CLAMP it to their nearest native value —
 * Codex/Pi/Copilot have no `max`, so `max` → `xhigh`. Native granularity a
 * provider has but the canonical scale lacks (Codex `minimal`/`xhigh`) stays
 * reachable through the existing provider-native paths (e.g. Codex's
 * `modelReasoningEffort` config / tier presets); the canonical `effort:` field is
 * the PORTABLE surface, not a replacement for those.
 *
 * Lives in @archon/providers (not @archon/workflows) so the providers that CONSUME
 * it import it directly; @archon/workflows reaches it through the package barrel.
 * Pure data + pure functions — zero SDK deps, zero side effects.
 */

/** Archon's canonical, provider-agnostic effort levels. */
export const ARCHON_EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const;
export type ArchonEffort = (typeof ARCHON_EFFORT_LEVELS)[number];

/** Canonical-effort → provider-native value, for one provider. */
export type EffortMap = Record<ArchonEffort, string>;

/**
 * Provider id → effort map, or `null` for providers with no effort concept
 * (OpenCode). Keys are registry provider ids. The invariant
 * `effortControl === true  ⇔  EFFORT_MAPS[id] != null` is enforced by a test
 * (`effort.test.ts`) so a provider can't claim effort support without a mapping
 * (or vice-versa).
 *
 * Consumption status (Phase 1): `codex` and `claude-terminal` route node `effort:`
 * through `mapEffort()` directly. `claude` applies it as the identity SDK `effort`
 * option (equivalent to its identity map here). `pi` and `copilot` still apply
 * effort via their own translators (`resolvePiThinkingLevel` /
 * `resolveCopilotReasoning`) — their entries below are the canonical declaration
 * and AGREE with those translators (a test pins the Pi side); Phase 2 migrates
 * those providers to consume this table so it becomes their live mapping too.
 */
export const EFFORT_MAPS: Record<string, EffortMap | null> = {
  // SDK `effort` accepts low/medium/high/max natively — identity map.
  claude: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
  // Interactive `--effort` flag accepts low/medium/high/max natively — identity map.
  'claude-terminal': { low: 'low', medium: 'medium', high: 'high', max: 'max' },
  // `modelReasoningEffort` vocabulary is minimal/low/medium/high/xhigh — no `max`.
  codex: { low: 'low', medium: 'medium', high: 'high', max: 'xhigh' },
  // Copilot ReasoningEffort is low/medium/high/xhigh — no `max`.
  copilot: { low: 'low', medium: 'medium', high: 'high', max: 'xhigh' },
  // Pi ThinkingLevel is minimal/low/medium/high/xhigh — no `max`.
  pi: { low: 'low', medium: 'medium', high: 'high', max: 'xhigh' },
  // OpenCode has no effort/reasoning control.
  opencode: null,
};

/**
 * Providers whose effort mapping is DRIVEN BY A LIVE PER-MODEL CATALOG rather
 * than a static {@link EffortMap}. They legitimately advertise
 * `effortControl: true` WITHOUT an `EFFORT_MAPS` row — the per-model clamp lives
 * in the provider (e.g. cursor's `resolveCursorParams` validates against
 * `Cursor.models.list()`, where the effort vocabulary varies by model:
 * `effort` low/medium/high/xhigh/max on Claude vs `reasoning`
 * none/low/medium/high/extra-high on GPT). The `effortControl ⇔ EFFORT_MAPS`
 * invariant (`effort.test.ts`) EXEMPTS these — adding a misleading static row
 * would claim a fixed vocabulary that doesn't exist.
 */
export const DYNAMIC_CATALOG_EFFORT_PROVIDERS = new Set<string>(['cursor']);

/** True when `v` is one of the canonical Archon effort levels. */
export function isArchonEffort(v: unknown): v is ArchonEffort {
  return typeof v === 'string' && (ARCHON_EFFORT_LEVELS as readonly string[]).includes(v);
}

/**
 * Translate a canonical Archon effort into `provider`'s native value.
 *
 * Returns `undefined` when there is nothing to apply: no effort given, an unknown
 * provider, a provider with no effort concept (`EFFORT_MAPS[provider] == null`),
 * or a value outside the canonical scale. Callers treat `undefined` as "leave the
 * provider's own default in place".
 */
export function mapEffort(effort: string | undefined, provider: string): string | undefined {
  if (effort === undefined || !isArchonEffort(effort)) return undefined;
  const map = EFFORT_MAPS[provider];
  if (!map) return undefined;
  return map[effort];
}
