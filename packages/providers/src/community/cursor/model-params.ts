/**
 * Pure translation of Archon's canonical model knobs (effort / thinking /
 * context / fast) into Cursor `ModelSelection.params`, validated against the
 * LIVE model catalog (`Cursor.models.list()` → {@link ModelListItem}[]).
 *
 * ## Design (plan §3 — minimal, fail-loud)
 * - **Emit ONLY the knobs actually in play.** Never fill an un-requested param
 *   from the catalog's default variant — that would pin a stale snapshot over
 *   the server's own (possibly newer) default. An un-set param keeps the model's
 *   current default under both merge and replace semantics.
 * - **Never read or emit anything outside the model's PUBLIC `parameters[]`.**
 *   Default variants carry hidden params (e.g. opus `cyber=false`); because we
 *   only look up the specific param a knob targets, hidden params are never
 *   touched.
 * - **Provenance = explicitness.** An EXPLICIT knob (user-requested) the model
 *   can't express → throw {@link CursorModelParamsError} (fail-loud). An IMPLICIT
 *   knob (the cost default `fast=false`) the model lacks → silently omit (there
 *   is simply nothing to apply, e.g. gemini has no `fast` tier).
 *
 * ## Observability caveat
 * The SDK does NOT report the server-resolved/merged params or the billed tier:
 * `run.wait().model` echoes the request verbatim and `system.model` is undefined
 * for local agents (plan §0.3). This module controls only the REQUEST shape.
 *
 * Zero SDK runtime deps — only erased `@cursor/sdk` types via `./sdk-types`.
 */
import type { ModelListItem, ModelParameterDefinition, ModelParameterValue } from './sdk-types';

/**
 * Thrown when an EXPLICIT knob cannot be honored by the resolved model (the
 * model lacks the param, or no clamp value is expressible). The provider maps
 * this to a `cursor_model_params_unavailable` result and does NOT spawn the
 * sidecar (fail-loud, never silently drop — plan §3 / finding 1).
 */
export class CursorModelParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CursorModelParamsError';
  }
}

/** One knob value plus its provenance (explicit = user-requested). */
export interface CursorKnob<T> {
  value: T;
  /** `true` if the user asked for this; `false` for the implicit cost default. */
  explicit: boolean;
}

/** A `ThinkingConfig`-shaped value (string shorthand or `{ type }` object). */
export type CursorThinkingInput = string | { type?: unknown };

/** The canonical knobs the provider may apply, each tagged with provenance. */
export interface CursorKnobs {
  /** Canonical Archon effort: low | medium | high | max. */
  effort?: CursorKnob<string>;
  /** Archon `ThinkingConfig` (or string shorthand). */
  thinking?: CursorKnob<CursorThinkingInput>;
  /** Context-window request: '1m' | 'max' | a literal catalog value. */
  context?: CursorKnob<string>;
  /** Fast/standard tier toggle (the implicit cost default is `false`). */
  fast?: CursorKnob<boolean>;
}

export interface ResolvedCursorParams {
  /** The minimal, validated param list to put on `ModelSelection.params`. */
  params: ModelParameterValue[];
  /** Whether `modelId` was present in the catalog (drives degraded handling). */
  modelFound: boolean;
}

/**
 * Canonical effort → ordered native-value preferences. The first preference
 * present in the model's param `values` wins; `max` degrades through the
 * provider-specific high rungs (Claude `xhigh`, GPT `extra-high`) before `high`.
 * Centralized so value-vocab drift (`xhigh` ↔ `extra-high`) is fixed in one spot.
 */
const EFFORT_PREFERENCES: Record<string, readonly string[]> = {
  low: ['low'],
  medium: ['medium'],
  high: ['high'],
  max: ['max', 'xhigh', 'extra-high', 'high'],
};

/** Param ids that carry effort/reasoning, in lookup order (id varies per family). */
const EFFORT_PARAM_IDS = ['effort', 'reasoning'] as const;

/** Find a public param definition by exact id. */
function findParam(model: ModelListItem, id: string): ModelParameterDefinition | undefined {
  return (model.parameters ?? []).find(p => p.id === id);
}

/** Find the model's effort-family param (`effort` on Claude, `reasoning` on GPT). */
function findEffortParam(model: ModelListItem): ModelParameterDefinition | undefined {
  for (const id of EFFORT_PARAM_IDS) {
    const p = findParam(model, id);
    if (p) return p;
  }
  return undefined;
}

function allowedValues(param: ModelParameterDefinition): Set<string> {
  return new Set(param.values.map(v => v.value));
}

/**
 * Parse a context-window catalog value ('200k', '1m', ...) into a comparable
 * size. Returns -Infinity for an unparseable value so it never wins "largest".
 */
function contextSize(value: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(value.trim());
  if (!m) return Number.NEGATIVE_INFINITY;
  const n = Number(m[1]);
  const unit = m[2]?.toLowerCase();
  if (unit === 'm') return n * 1_000_000;
  if (unit === 'k') return n * 1_000;
  return n;
}

/**
 * Best-effort heuristic: does an SDK error look like a per-model PARAMETER
 * rejection (vs auth / network / unknown-model)? Used ONLY to gate the
 * stale-catalog retry (provider): a false positive costs one wasted refresh +
 * respawn; a false negative just surfaces the error without a retry. Both
 * outcomes are bounded and safe, so the matcher is deliberately broad.
 */
export function isCursorParamRejection(message: string): boolean {
  return /param|parameter|invalid (model|value|selection)|model selection|unsupported|not a valid|unknown value/i.test(
    message
  );
}

/** Normalize a `ThinkingConfig`-ish input to Cursor's binary `true`/`false`. */
function thinkingToValue(input: CursorThinkingInput): 'true' | 'false' {
  const type =
    typeof input === 'string' ? input : typeof input?.type === 'string' ? input.type : '';
  // enabled / adaptive → on; disabled → off. `adaptive` is a documented lossy
  // mapping (Cursor thinking is binary; plan §3 / R3).
  return type === 'disabled' ? 'false' : 'true';
}

/**
 * Resolve canonical knobs into a minimal, catalog-validated Cursor param list.
 * @throws {CursorModelParamsError} when an EXPLICIT knob can't be expressed.
 */
export function resolveCursorParams(
  models: ModelListItem[],
  modelId: string,
  knobs: CursorKnobs
): ResolvedCursorParams {
  const model = models.find(m => m.id === modelId);
  if (!model) {
    // Unknown model: an explicit knob can't be validated → fail-loud. An implicit
    // knob (cost default) simply can't be applied here → caller decides (the
    // provider treats `modelFound:false` as a degraded/cost-default condition).
    const explicitKnob = Object.values(knobs).find(k => k?.explicit);
    if (explicitKnob) {
      throw new CursorModelParamsError(
        `Model '${modelId}' is not in the Cursor catalog; cannot honor the requested model parameters.`
      );
    }
    return { params: [], modelFound: false };
  }

  const params: ModelParameterValue[] = [];

  if (knobs.effort) emitEffort(model, modelId, knobs.effort, params);
  if (knobs.thinking)
    emitSimple(model, modelId, 'thinking', knobs.thinking, params, k => [thinkingToValue(k.value)]);
  if (knobs.context) emitContext(model, modelId, knobs.context, params);
  if (knobs.fast)
    emitSimple(model, modelId, 'fast', knobs.fast, params, k => [k.value ? 'true' : 'false']);

  return { params, modelFound: true };
}

/** Emit the effort/reasoning param with id-swap + value clamp. */
function emitEffort(
  model: ModelListItem,
  modelId: string,
  knob: CursorKnob<string>,
  out: ModelParameterValue[]
): void {
  const param = findEffortParam(model);
  if (!param) {
    if (knob.explicit)
      throw new CursorModelParamsError(
        `Model '${modelId}' does not support an effort/reasoning parameter.`
      );
    return;
  }
  const allowed = allowedValues(param);
  const prefs = EFFORT_PREFERENCES[knob.value];
  const value = prefs?.find(v => allowed.has(v));
  if (value === undefined) {
    if (knob.explicit)
      throw new CursorModelParamsError(
        `Model '${modelId}' cannot express effort '${knob.value}' on param '${param.id}' (allowed: ${[...allowed].join(', ')}).`
      );
    return;
  }
  out.push({ id: param.id, value });
}

/** Emit a context value: '1m'/'max' → largest available; literal → exact. */
function emitContext(
  model: ModelListItem,
  modelId: string,
  knob: CursorKnob<string>,
  out: ModelParameterValue[]
): void {
  const param = findParam(model, 'context');
  if (!param) {
    if (knob.explicit)
      throw new CursorModelParamsError(`Model '${modelId}' does not support a context parameter.`);
    return;
  }
  const allowed = allowedValues(param);
  let value: string | undefined;
  if (knob.value === 'max' || knob.value === '1m') {
    // Largest available context window (e.g. '1m' on a 300k-max model → '300k').
    value =
      knob.value === '1m' && allowed.has('1m')
        ? '1m'
        : [...allowed].sort((a, b) => contextSize(b) - contextSize(a))[0];
  } else {
    value = allowed.has(knob.value) ? knob.value : undefined;
  }
  if (value === undefined) {
    if (knob.explicit)
      throw new CursorModelParamsError(
        `Model '${modelId}' cannot express context '${knob.value}' (allowed: ${[...allowed].join(', ')}).`
      );
    return;
  }
  out.push({ id: 'context', value });
}

/** Emit a fixed-id param (thinking/fast) whose value is a direct catalog member. */
function emitSimple<T>(
  model: ModelListItem,
  modelId: string,
  paramId: string,
  knob: CursorKnob<T>,
  out: ModelParameterValue[],
  toValues: (knob: CursorKnob<T>) => string[]
): void {
  const param = findParam(model, paramId);
  if (!param) {
    if (knob.explicit)
      throw new CursorModelParamsError(
        `Model '${modelId}' does not support a ${paramId} parameter.`
      );
    return;
  }
  const allowed = allowedValues(param);
  const value = toValues(knob).find(v => allowed.has(v));
  if (value === undefined) {
    if (knob.explicit)
      throw new CursorModelParamsError(
        `Model '${modelId}' cannot express ${paramId}='${toValues(knob).join('|')}' (allowed: ${[...allowed].join(', ')}).`
      );
    return;
  }
  out.push({ id: paramId, value });
}
