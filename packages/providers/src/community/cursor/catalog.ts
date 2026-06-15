/**
 * Durable, last-good Cursor model catalog (`Cursor.models.list()`).
 *
 * ## Why durable-stale (plan §4 / findings 1 & 5)
 * The catalog feeds the cost-control default (`fast=false`) and per-model param
 * validation, so it must NOT vanish on a transient network blip. The on-disk
 * snapshot is the source of truth:
 * - **fresh** (age < TTL): served directly, zero network.
 * - **stale** (age ≥ TTL): served immediately (still zero BLOCKING network) and a
 *   background refresh is scheduled; if that refresh FAILS the stale snapshot is
 *   retained (never discarded).
 * - **cold** (no snapshot at all): a blocking refresh is required; if it fails the
 *   catalog reports `available: false` and the provider applies its degraded
 *   (fail-closed-unless-opt-in) policy.
 *
 * `forceRefresh()` is the param-rejection recovery path: when the SDK rejects a
 * param a (possibly stale) disk snapshot blessed, the provider invalidates +
 * refreshes once and retries the run once before failing.
 *
 * The SDK never runs here — `refresh` defaults to spawning `cursor-catalog.mjs`
 * under `node` (the SDK deadlocks under Bun in git repos) and is injectable for
 * tests. Writes are atomic (temp + rename) so parallel sidecars can't tear the
 * file.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ModelListItem } from './sdk-types';

/** Catalog snapshot filename under the cursor state root. */
export const CURSOR_CATALOG_FILE = 'catalog.json';

/** Default freshness window before a background refresh is scheduled (6h). */
export const CURSOR_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

const SNAPSHOT_VERSION = 1;

interface PersistedSnapshot {
  version: number;
  fetchedAt: number;
  models: ModelListItem[];
}

/** A fetcher for the live catalog. Returns the full model list or throws. */
export type CatalogRefresh = () => Promise<ModelListItem[]>;

export interface LoadCursorCatalogOptions {
  /** Stable directory for the snapshot file (survives ephemeral worktrees). */
  stateRoot: string;
  /** Live fetcher; defaults to spawning `cursor-catalog.mjs` under `node`. */
  refresh?: CatalogRefresh;
  /** Cursor API key (used only by the default `refresh`). */
  apiKey?: string;
  /** `node` binary path for the default `refresh` (default: `node` on PATH). */
  nodePath?: string;
  /** Freshness window in ms (default {@link CURSOR_CATALOG_TTL_MS}). */
  ttlMs?: number;
  /** Injectable clock for tests (default `Date.now`). */
  now?: () => number;
}

export interface CursorCatalog {
  /** The model list (empty only when cold + refresh failed). */
  models: ModelListItem[];
  /** Epoch ms of the served snapshot, or `undefined` when unavailable. */
  fetchedAt: number | undefined;
  /** Age of the served snapshot in ms, or `undefined` when unavailable. */
  ageMs: number | undefined;
  /** True when the served data came from a persisted snapshot (stale-eligible). */
  servedFromDisk: boolean;
  /** True when the catalog has any models to resolve against. */
  available: boolean;
  /** In-flight background refresh (settled, never rejects) — a test/await hook. */
  refreshing?: Promise<void>;
  /**
   * Blocking invalidate + single refresh. On success replaces the catalog and
   * persists it; on failure THROWS and keeps the prior snapshot. Used by the
   * provider's param-rejection retry.
   */
  forceRefresh(): Promise<void>;
}

async function readSnapshot(file: string): Promise<PersistedSnapshot | undefined> {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as PersistedSnapshot;
    if (!Array.isArray(parsed.models) || typeof parsed.fetchedAt !== 'number') return undefined;
    return parsed;
  } catch {
    return undefined; // missing / unreadable / malformed → treat as cold
  }
}

let tmpCounter = 0;
async function writeSnapshotAtomic(
  stateRoot: string,
  file: string,
  snapshot: PersistedSnapshot
): Promise<void> {
  await mkdir(stateRoot, { recursive: true });
  // Unique temp name per writer so concurrent sidecars never share a temp path;
  // rename is atomic on POSIX, so a reader sees either the old or the new file,
  // never a torn one.
  const tmp = join(stateRoot, `${CURSOR_CATALOG_FILE}.${process.pid}.${tmpCounter++}.tmp`);
  await writeFile(tmp, JSON.stringify(snapshot), 'utf8');
  await rename(tmp, file);
}

/**
 * Load the durable Cursor model catalog. See the module header for the
 * fresh / stale / cold policy.
 */
export async function loadCursorCatalog(opts: LoadCursorCatalogOptions): Promise<CursorCatalog> {
  const ttlMs = opts.ttlMs ?? CURSOR_CATALOG_TTL_MS;
  const now = opts.now ?? Date.now;
  const file = join(opts.stateRoot, CURSOR_CATALOG_FILE);
  const refresh: CatalogRefresh =
    opts.refresh ??
    ((): Promise<ModelListItem[]> =>
      defaultCatalogRefresh({ apiKey: opts.apiKey, nodePath: opts.nodePath }));

  const persist = async (models: ModelListItem[], fetchedAt: number): Promise<void> => {
    await writeSnapshotAtomic(opts.stateRoot, file, {
      version: SNAPSHOT_VERSION,
      fetchedAt,
      models,
    });
  };

  const snapshot = await readSnapshot(file);

  // Build the mutable catalog object up front so forceRefresh can mutate it.
  const catalog: CursorCatalog = {
    models: snapshot?.models ?? [],
    fetchedAt: snapshot?.fetchedAt,
    ageMs: snapshot ? now() - snapshot.fetchedAt : undefined,
    servedFromDisk: snapshot !== undefined,
    available: (snapshot?.models.length ?? 0) > 0,
    forceRefresh: async (): Promise<void> => {
      const models = await refresh(); // throws on failure → caller fails
      const fetchedAt = now();
      await persist(models, fetchedAt);
      catalog.models = models;
      catalog.fetchedAt = fetchedAt;
      catalog.ageMs = 0;
      catalog.servedFromDisk = false;
      catalog.available = models.length > 0;
    },
  };

  if (!snapshot) {
    // Cold: a blocking fetch is required. On failure report unavailable.
    try {
      const models = await refresh();
      const fetchedAt = now();
      await persist(models, fetchedAt);
      catalog.models = models;
      catalog.fetchedAt = fetchedAt;
      catalog.ageMs = 0;
      catalog.servedFromDisk = false;
      catalog.available = models.length > 0;
    } catch {
      // available stays false; provider applies the degraded policy.
    }
    return catalog;
  }

  const age = now() - snapshot.fetchedAt;
  if (age >= ttlMs) {
    // Stale: serve immediately, freshen in the background. A failed refresh keeps
    // the stale snapshot. The promise is stored (and never rejects) so a caller
    // can await it and so an unhandled rejection can't crash the process.
    catalog.refreshing = (async (): Promise<void> => {
      try {
        const models = await refresh();
        await persist(models, now());
        // NOTE: we intentionally do NOT mutate the served `catalog.models` here —
        // the current run already resolved against the stale snapshot; the fresh
        // data is for the next process. Mutating mid-run would be a race.
      } catch {
        // keep the durable stale snapshot
      }
    })();
  }
  return catalog;
}

/**
 * Default catalog fetcher: spawn `cursor-catalog.mjs` under `node`, read its
 * JSON stdout. Kept here (not in tests) so the SDK never loads under Bun.
 */
export async function defaultCatalogRefresh(opts: {
  apiKey?: string;
  nodePath?: string;
}): Promise<ModelListItem[]> {
  const nodePath = opts.nodePath ?? 'node';
  const helper = join(import.meta.dir, 'cursor-catalog.mjs');
  return await new Promise<ModelListItem[]>((resolve, reject) => {
    const proc = spawn(nodePath, [helper], {
      env: { ...process.env, ...(opts.apiKey ? { CURSOR_API_KEY: opts.apiKey } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`cursor-catalog helper exited with code ${code}: ${stderr.slice(-500)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as ModelListItem[];
        if (!Array.isArray(parsed)) throw new Error('catalog helper did not return an array');
        resolve(parsed);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}
