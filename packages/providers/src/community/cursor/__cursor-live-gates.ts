/**
 * Cursor LIVE request-shape gate (manual; needs CURSOR_API_KEY, NOT run in CI).
 *
 *   CURSOR_API_KEY=... bun packages/providers/src/community/cursor/__cursor-live-gates.ts
 *
 * Drives the real provider end-to-end (live catalog via the node helper → param
 * translation → node sidecar → @cursor/sdk) for per-model-VALID effort/thinking/
 * fast combos and asserts the run does NOT fail (`result.isError !== true`).
 *
 * What this proves: the SDK ACCEPTS the `model: { id, params: [...] }` request
 * shape we emit. What it does NOT prove: the billed tier or server-resolved
 * params — those are UNOBSERVABLE via the SDK (`run.wait().model` echoes the
 * request; `system.model` is undefined for local agents — plan §0.3 / acceptance
 * D). The standard-vs-fast tier is confirmed ONCE on the Cursor dashboard
 * (acceptance E), out of this automated check.
 *
 * Only per-model-VALID combos are sent — the provider correctly FAILS LOUD on an
 * unsupported explicit knob (e.g. `thinking` on a GPT model), which would read as
 * a gate failure. That fail-loud path is covered hermetically in provider.test.ts.
 */
import { resolve } from 'node:path';

import type { MessageChunk, SendQueryOptions } from '../../types';

import { CursorProvider } from './provider';

interface Combo {
  label: string;
  model: string;
  nodeConfig?: SendQueryOptions['nodeConfig'];
  assistantConfig?: SendQueryOptions['assistantConfig'];
}

// Real catalog ids (verified live). gpt-5.4 does NOT exist live — use gpt-5.5.
const COMBOS: Combo[] = [
  { label: 'composer-2.5 fast=false', model: 'composer-2.5', assistantConfig: { fast: false } },
  { label: 'composer-2.5 fast=true', model: 'composer-2.5', assistantConfig: { fast: true } },
  {
    label: 'claude-opus-4-8 effort=high + thinking=enabled + fast=false',
    model: 'claude-opus-4-8',
    nodeConfig: { effort: 'high', thinking: { type: 'enabled' } },
    assistantConfig: { fast: false },
  },
  {
    label: 'claude-opus-4-8 effort=max',
    model: 'claude-opus-4-8',
    nodeConfig: { effort: 'max' },
  },
  {
    label: 'gpt-5.5 effort=high (→reasoning) + fast=false',
    model: 'gpt-5.5',
    nodeConfig: { effort: 'high' },
    assistantConfig: { fast: false },
  },
  { label: 'gpt-5.5 effort=max (→extra-high)', model: 'gpt-5.5', nodeConfig: { effort: 'max' } },
];

const PROMPT = 'Reply with exactly the word: ok. Do not use any tools.';
const TIMEOUT_MS = 180_000;

async function runCombo(provider: CursorProvider, cwd: string, combo: Combo): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
  }, TIMEOUT_MS);
  let resultChunk: Extract<MessageChunk, { type: 'result' }> | undefined;
  try {
    for await (const chunk of provider.sendQuery(PROMPT, cwd, undefined, {
      model: combo.model,
      abortSignal: ac.signal,
      ...(combo.nodeConfig ? { nodeConfig: combo.nodeConfig } : {}),
      ...(combo.assistantConfig ? { assistantConfig: combo.assistantConfig } : {}),
    })) {
      if (chunk.type === 'result') resultChunk = chunk;
    }
  } finally {
    clearTimeout(timer);
  }
  const ok = resultChunk !== undefined && resultChunk.isError !== true;
  const detail = ok
    ? ''
    : ` [${resultChunk?.errorSubtype ?? 'no-result'}] ${resultChunk?.errors?.join('; ') ?? ''}`;
  console.log(`${ok ? '✅' : '❌'} ${combo.label}${detail}`);
  return ok;
}

async function main(): Promise<void> {
  if (!process.env.CURSOR_API_KEY) {
    console.error('CURSOR_API_KEY is required for the live gate.');
    process.exit(2);
  }
  const cwd = resolve(import.meta.dir, '../../../../..'); // the archon repo root (a git repo)
  const provider = new CursorProvider();
  console.log(`Cursor live request-shape gate — cwd=${cwd}\n`);

  let passed = 0;
  for (const combo of COMBOS) {
    // Sequential: parallel sidecars would race the shared catalog/store and muddy output.
    if (await runCombo(provider, cwd, combo)) passed++;
  }

  console.log(
    `\n${passed}/${COMBOS.length} combos accepted (request-shape only; tier is dashboard-confirmed).`
  );
  process.exit(passed === COMBOS.length ? 0 : 1);
}

void main();
