import { describe, expect, it } from 'bun:test';

import type { ModelListItem, ModelParameterValue } from './sdk-types';
import { CursorModelParamsError, type CursorKnobs, resolveCursorParams } from './model-params';

// ─── Fixture catalog ─────────────────────────────────────────────────────────
//
// Mirrors the SHAPE of `Cursor.models.list()` (live-verified facts, plan §1):
// - param ids vary per family: `effort` (Claude) vs `reasoning` (GPT);
// - value vocab diverges: Claude `effort` has `xhigh`/`max`; GPT `reasoning` has
//   `extra-high` and NO `max`;
// - `thinking` is false/true (Claude only); `fast` is false/true (not on gemini);
// - `context` values are per-model (200k/272k/300k/1m);
// - the DEFAULT VARIANT can carry HIDDEN params NOT in public `parameters[]`
//   (opus `cyber=false`) — these must never be read or emitted.
const FIXTURES: ModelListItem[] = [
  {
    id: 'composer-2.5',
    displayName: 'Composer 2.5',
    parameters: [
      { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
      { id: 'context', values: [{ value: '200k' }, { value: '272k' }] },
    ],
    variants: [{ params: [{ id: 'fast', value: 'true' }], displayName: 'Fast', isDefault: true }],
  },
  {
    id: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8',
    parameters: [
      {
        id: 'effort',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
      { id: 'thinking', values: [{ value: 'false' }, { value: 'true' }] },
      { id: 'context', values: [{ value: '200k' }, { value: '1m' }] },
      { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
    ],
    // The default variant carries a HIDDEN `cyber` NOT present in parameters[].
    variants: [
      {
        params: [
          { id: 'fast', value: 'true' },
          { id: 'cyber', value: 'false' },
        ],
        displayName: 'Default',
        isDefault: true,
      },
    ],
  },
  {
    id: 'gpt-5.4',
    displayName: 'GPT-5.4',
    parameters: [
      {
        id: 'reasoning',
        values: [
          { value: 'none' },
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'extra-high' },
        ],
      },
      { id: 'context', values: [{ value: '200k' }, { value: '300k' }] },
      { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
    ],
  },
  {
    id: 'gemini-3-flash',
    displayName: 'Gemini 3 Flash',
    parameters: [{ id: 'context', values: [{ value: '1m' }] }],
  },
];

function get(modelId: string): ModelListItem {
  const m = FIXTURES.find(x => x.id === modelId);
  if (!m) throw new Error(`fixture missing: ${modelId}`);
  return m;
}

/** All public param ids for a model — used to assert nothing outside it leaks. */
function publicParamIds(modelId: string): Set<string> {
  return new Set((get(modelId).parameters ?? []).map(p => p.id));
}

const explicit = <T>(value: T): { value: T; explicit: boolean } => ({ value, explicit: true });
const implicit = <T>(value: T): { value: T; explicit: boolean } => ({ value, explicit: false });
/** A blanket cost-tier POLICY knob (how the provider builds `fast`): explicit + policy. */
const policyFast = (value: boolean): { value: boolean; explicit: boolean; policy: boolean } => ({
  value,
  explicit: true,
  policy: true,
});

describe('resolveCursorParams', () => {
  describe('effort (id swap + value clamp)', () => {
    it('maps canonical effort to the Claude `effort` param', () => {
      const { params } = resolveCursorParams(FIXTURES, 'claude-opus-4-8', {
        effort: explicit('high'),
      });
      expect(params).toEqual([{ id: 'effort', value: 'high' }]);
    });

    it('maps canonical effort to the GPT `reasoning` param (id swap)', () => {
      const { params } = resolveCursorParams(FIXTURES, 'gpt-5.4', { effort: explicit('high') });
      expect(params).toEqual([{ id: 'reasoning', value: 'high' }]);
    });

    it('clamps `max` to `extra-high` on gpt-5.4 (no `max`/`xhigh` rung)', () => {
      const { params } = resolveCursorParams(FIXTURES, 'gpt-5.4', { effort: explicit('max') });
      expect(params).toEqual([{ id: 'reasoning', value: 'extra-high' }]);
    });

    it('keeps `max` on opus (the param has a `max` rung)', () => {
      const { params } = resolveCursorParams(FIXTURES, 'claude-opus-4-8', {
        effort: explicit('max'),
      });
      expect(params).toEqual([{ id: 'effort', value: 'max' }]);
    });
  });

  describe('thinking (all three states)', () => {
    it('enabled → true', () => {
      const { params } = resolveCursorParams(FIXTURES, 'claude-opus-4-8', {
        thinking: explicit({ type: 'enabled' }),
      });
      expect(params).toEqual([{ id: 'thinking', value: 'true' }]);
    });
    it('disabled → false', () => {
      const { params } = resolveCursorParams(FIXTURES, 'claude-opus-4-8', {
        thinking: explicit({ type: 'disabled' }),
      });
      expect(params).toEqual([{ id: 'thinking', value: 'false' }]);
    });
    it('adaptive → true (documented lossy mapping)', () => {
      const { params } = resolveCursorParams(FIXTURES, 'claude-opus-4-8', {
        thinking: explicit({ type: 'adaptive' }),
      });
      expect(params).toEqual([{ id: 'thinking', value: 'true' }]);
    });
    it('throws on a model without a `thinking` param (explicit)', () => {
      expect(() =>
        resolveCursorParams(FIXTURES, 'gpt-5.4', { thinking: explicit({ type: 'enabled' }) })
      ).toThrow(CursorModelParamsError);
    });
  });

  describe('fast (explicit vs implicit provenance)', () => {
    it('explicit fast=false → {fast,false}', () => {
      const { params } = resolveCursorParams(FIXTURES, 'composer-2.5', {
        fast: explicit(false),
      });
      expect(params).toEqual([{ id: 'fast', value: 'false' }]);
    });
    it('non-policy explicit fast on gemini (no `fast` param) → throws', () => {
      // A bare explicit knob (no policy flag) the model lacks still fails loud.
      expect(() =>
        resolveCursorParams(FIXTURES, 'gemini-3-flash', { fast: explicit(false) })
      ).toThrow(CursorModelParamsError);
    });
    it('POLICY explicit fast on gemini (no `fast` param) → omitted (no throw)', () => {
      // The fix: a blanket cost-tier policy knob on a single-tier model is omitted,
      // not thrown — there is no premium-vs-standard choice to protect.
      const { params } = resolveCursorParams(FIXTURES, 'gemini-3-flash', {
        fast: policyFast(false),
      });
      expect(params).toEqual([]);
    });
    it('POLICY explicit fast=true on gemini (no `fast` param) → omitted (no throw)', () => {
      const { params } = resolveCursorParams(FIXTURES, 'gemini-3-flash', {
        fast: policyFast(true),
      });
      expect(params).toEqual([]);
    });
    it('policy does NOT exempt the value-unavailable case (param present, value missing → throws)', () => {
      // A model that HAS `fast` but can't express the requested value is a genuine
      // cost conflict — the policy exemption is scoped to the param-ABSENT branch only.
      const premiumOnly: ModelListItem[] = [
        {
          id: 'premium-only',
          displayName: 'Premium Only',
          parameters: [{ id: 'fast', values: [{ value: 'true' }] }],
        },
      ];
      expect(() =>
        resolveCursorParams(premiumOnly, 'premium-only', { fast: policyFast(false) })
      ).toThrow(CursorModelParamsError);
    });
    it('implicit fast on gemini (no `fast` param) → omitted (no throw)', () => {
      const { params } = resolveCursorParams(FIXTURES, 'gemini-3-flash', {
        fast: implicit(false),
      });
      expect(params).toEqual([]);
    });
  });

  describe('context (largest / literal)', () => {
    it('`1m` clamps to the largest available (`300k`) on a 300k-max model', () => {
      const { params } = resolveCursorParams(FIXTURES, 'gpt-5.4', { context: explicit('1m') });
      expect(params).toEqual([{ id: 'context', value: '300k' }]);
    });
    it('`max` resolves to the largest available value', () => {
      const { params } = resolveCursorParams(FIXTURES, 'claude-opus-4-8', {
        context: explicit('max'),
      });
      expect(params).toEqual([{ id: 'context', value: '1m' }]);
    });
    it('an exact literal that the model supports is used verbatim', () => {
      const { params } = resolveCursorParams(FIXTURES, 'composer-2.5', {
        context: explicit('272k'),
      });
      expect(params).toEqual([{ id: 'context', value: '272k' }]);
    });
    it('`1m`/`max` are clamp keywords (→ largest), never a hard literal — clamps, no throw', () => {
      const { params } = resolveCursorParams(FIXTURES, 'composer-2.5', { context: explicit('1m') });
      expect(params).toEqual([{ id: 'context', value: '272k' }]);
    });
    it('throws on an unrecognized literal the model does not support (explicit)', () => {
      expect(() =>
        resolveCursorParams(FIXTURES, 'composer-2.5', { context: explicit('999k') })
      ).toThrow(CursorModelParamsError);
    });
  });

  describe('minimal emission', () => {
    it('emits EXACTLY the in-play knob, filling nothing else (opus fast=false)', () => {
      const { params } = resolveCursorParams(FIXTURES, 'claude-opus-4-8', {
        fast: explicit(false),
      });
      expect(params).toEqual([{ id: 'fast', value: 'false' }]);
    });

    it('never emits hidden params (cyber) from the default variant', () => {
      const { params } = resolveCursorParams(FIXTURES, 'claude-opus-4-8', {
        effort: explicit('high'),
        thinking: explicit({ type: 'enabled' }),
        fast: explicit(false),
      });
      expect(params.find(p => p.id === 'cyber')).toBeUndefined();
    });

    it('never emits anything outside the model public parameters[] (all fixtures, all knobs)', () => {
      // All implicit so a knob a model lacks is omitted (not thrown) — this
      // exercises emission across every fixture without tripping fail-loud.
      const allKnobs: CursorKnobs = {
        effort: implicit('high'),
        thinking: implicit({ type: 'enabled' }),
        context: implicit('max'),
        fast: implicit(false),
      };
      for (const model of FIXTURES) {
        const { params } = resolveCursorParams(FIXTURES, model.id, allKnobs);
        const allowed = publicParamIds(model.id);
        for (const p of params) {
          expect(allowed.has(p.id), `${model.id} leaked param '${p.id}'`).toBe(true);
        }
      }
    });
  });

  describe('unknown model', () => {
    it('throws on an unknown model with an explicit knob', () => {
      expect(() =>
        resolveCursorParams(FIXTURES, 'no-such-model', { effort: explicit('high') })
      ).toThrow(CursorModelParamsError);
    });
    it('returns empty params + modelFound=false for an unknown model with no knobs', () => {
      const res = resolveCursorParams(FIXTURES, 'no-such-model', {});
      expect(res.params).toEqual([]);
      expect(res.modelFound).toBe(false);
    });
    it('does NOT throw for an unknown model with only an implicit knob', () => {
      const res = resolveCursorParams(FIXTURES, 'no-such-model', { fast: implicit(false) });
      expect(res.params).toEqual([]);
      expect(res.modelFound).toBe(false);
    });
    it('reports modelFound=true for a known model', () => {
      const res = resolveCursorParams(FIXTURES, 'composer-2.5', {});
      expect(res.modelFound).toBe(true);
    });
  });

  it('returns the params under a typed ModelParameterValue[] shape', () => {
    const { params } = resolveCursorParams(FIXTURES, 'composer-2.5', { fast: explicit(true) });
    const typed: ModelParameterValue[] = params;
    expect(typed[0]).toEqual({ id: 'fast', value: 'true' });
  });
});
