/**
 * Cursor model-catalog helper (one-shot Node sidecar).
 *
 * `@cursor/sdk` deadlocks in-process under Bun in git repos, so EVERY SDK call —
 * including the read-only `Cursor.models.list()` — runs under `node`. This tiny
 * child fetches the live catalog and prints it as JSON on stdout; the Bun parent
 * (`catalog.ts`) persists it as the durable last-good snapshot.
 *
 * Protocol:
 *   env    : CURSOR_API_KEY (+ inherited)
 *   stdout : a single JSON array — `ModelListItem[]` (PURE JSON, no log noise)
 *   stderr : SDK console noise (fenced here so stdout stays parseable)
 *   exit   : 0 on success, 1 on any failure (parent rejects + keeps the snapshot)
 *
 * Plain `.mjs` (no TS build step); `node` resolves `@cursor/sdk` from
 * `packages/providers/node_modules`.
 */

// Keep stdout PURE JSON: the SDK writes settings-loader INFO lines to console.* —
// redirect every console method to stderr before importing it.
for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
  console[m] = (...a) => process.stderr.write('[sdk] ' + a.map(String).join(' ') + '\n');
}

import { Cursor } from '@cursor/sdk';

try {
  const models = await Cursor.models.list({ apiKey: process.env.CURSOR_API_KEY });
  process.stdout.write(JSON.stringify(models));
  process.exit(0);
} catch (err) {
  process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
  process.exit(1);
}
