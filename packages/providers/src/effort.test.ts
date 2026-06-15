import { describe, it, expect, beforeAll } from 'bun:test';

import {
  ARCHON_EFFORT_LEVELS,
  DYNAMIC_CATALOG_EFFORT_PROVIDERS,
  EFFORT_MAPS,
  isArchonEffort,
  mapEffort,
} from './effort';
import {
  clearRegistry,
  getRegisteredProviders,
  registerBuiltinProviders,
  registerCommunityProviders,
} from './registry';
import { resolvePiThinkingLevel } from './community/pi/options-translator';

describe('mapEffort', () => {
  it('is identity for providers whose native vocabulary covers the canonical scale', () => {
    for (const level of ARCHON_EFFORT_LEVELS) {
      expect(mapEffort(level, 'claude')).toBe(level);
      expect(mapEffort(level, 'claude-terminal')).toBe(level);
    }
  });

  it('clamps `max` → `xhigh` for providers without a `max` rung', () => {
    for (const provider of ['codex', 'pi', 'copilot']) {
      expect(mapEffort('max', provider)).toBe('xhigh');
      // The lower rungs still pass through unchanged.
      expect(mapEffort('low', provider)).toBe('low');
      expect(mapEffort('medium', provider)).toBe('medium');
      expect(mapEffort('high', provider)).toBe('high');
    }
  });

  it('returns undefined for providers with no effort concept', () => {
    for (const level of ARCHON_EFFORT_LEVELS) {
      expect(mapEffort(level, 'opencode')).toBeUndefined();
    }
  });

  it('returns undefined for no effort, unknown provider, or non-canonical value', () => {
    expect(mapEffort(undefined, 'claude')).toBeUndefined();
    expect(mapEffort('high', 'nope')).toBeUndefined();
    expect(mapEffort('xhigh', 'claude')).toBeUndefined(); // xhigh is NOT canonical
    expect(mapEffort('ultra', 'codex')).toBeUndefined();
    expect(mapEffort('', 'claude')).toBeUndefined();
  });
});

describe('isArchonEffort', () => {
  it('accepts exactly the canonical levels', () => {
    expect(ARCHON_EFFORT_LEVELS.every(isArchonEffort)).toBe(true);
  });
  it('rejects non-canonical / non-string values', () => {
    expect(isArchonEffort('xhigh')).toBe(false);
    expect(isArchonEffort('minimal')).toBe(false);
    expect(isArchonEffort(undefined)).toBe(false);
    expect(isArchonEffort(3)).toBe(false);
  });
});

describe('EFFORT_MAPS invariant vs ProviderCapabilities.effortControl', () => {
  beforeAll(() => {
    clearRegistry();
    registerBuiltinProviders();
    registerCommunityProviders();
  });

  it('every registered provider has effortControl === true ⇔ a non-null effort map', () => {
    for (const reg of getRegisteredProviders()) {
      // Dynamic-catalog providers (e.g. cursor) advertise effortControl without a
      // static EFFORT_MAPS row — their clamp is per-model + live-catalog driven.
      if (DYNAMIC_CATALOG_EFFORT_PROVIDERS.has(reg.id)) {
        expect(
          reg.capabilities.effortControl,
          `dynamic-catalog provider '${reg.id}' must advertise effortControl: true`
        ).toBe(true);
        expect(
          EFFORT_MAPS[reg.id] ?? null,
          `dynamic-catalog provider '${reg.id}' must NOT have a static EFFORT_MAPS row`
        ).toBeNull();
        continue;
      }
      const hasMap = EFFORT_MAPS[reg.id] != null;
      expect(
        reg.capabilities.effortControl,
        `provider '${reg.id}': effortControl (${reg.capabilities.effortControl}) must match EFFORT_MAPS presence (${hasMap})`
      ).toBe(hasMap);
    }
  });

  it('every effort map covers the full canonical scale', () => {
    for (const [provider, map] of Object.entries(EFFORT_MAPS)) {
      if (map === null) continue;
      for (const level of ARCHON_EFFORT_LEVELS) {
        expect(
          map[level],
          `provider '${provider}' missing canonical level '${level}'`
        ).toBeTruthy();
      }
    }
  });
});

describe('EFFORT_MAPS agrees with the live provider translators (Phase 2 drift guard)', () => {
  // Pi/Copilot still resolve effort via their own normalizers; their EFFORT_MAPS
  // entries are the canonical declaration and MUST agree until Phase 2 folds the
  // table in. Pin the Pi side (its translator is exported + pure). If a future
  // edit moves one side without the other, this fails — a green/red migration signal.
  it('mapEffort(level, "pi") matches resolvePiThinkingLevel for every canonical level', () => {
    for (const level of ARCHON_EFFORT_LEVELS) {
      // mapEffort is the `actual` (string | undefined) so the Pi ThinkingLevel
      // (a string subtype) is assignable as the `expected`.
      expect(mapEffort(level, 'pi')).toBe(resolvePiThinkingLevel({ effort: level }).level);
    }
  });
});
