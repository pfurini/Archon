import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { loadCursorCatalog, CURSOR_CATALOG_FILE } from './catalog';
import type { ModelListItem } from './sdk-types';

const MODELS: ModelListItem[] = [
  { id: 'composer-2.5', displayName: 'Composer 2.5', parameters: [] },
];
const MODELS_V2: ModelListItem[] = [
  { id: 'composer-2.5', displayName: 'Composer 2.5', parameters: [] },
  { id: 'claude-opus-4-8', displayName: 'Opus', parameters: [] },
];

const TTL = 60_000;
const dirs: string[] = [];
function tmpStateRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'cursor-catalog-'));
  dirs.push(d);
  return d;
}
function writeSnapshot(stateRoot: string, fetchedAt: number, models: ModelListItem[]): void {
  writeFileSync(
    join(stateRoot, CURSOR_CATALOG_FILE),
    JSON.stringify({ version: 1, fetchedAt, models })
  );
}
function readSnapshot(stateRoot: string): { fetchedAt: number; models: ModelListItem[] } {
  return JSON.parse(readFileSync(join(stateRoot, CURSOR_CATALOG_FILE), 'utf8'));
}

afterEach(() => {
  // best-effort; tmp dirs are small and OS-reaped
});

describe('loadCursorCatalog', () => {
  it('serves a fresh snapshot within TTL without calling refresh', async () => {
    const stateRoot = tmpStateRoot();
    const now = 1_000_000;
    writeSnapshot(stateRoot, now - 1_000, MODELS); // 1s old, within TTL
    let refreshes = 0;
    const cat = await loadCursorCatalog({
      stateRoot,
      ttlMs: TTL,
      now: () => now,
      refresh: async () => {
        refreshes++;
        return MODELS_V2;
      },
    });
    await cat.refreshing; // settle any (there should be none)
    expect(refreshes).toBe(0);
    expect(cat.models).toEqual(MODELS);
    expect(cat.available).toBe(true);
    expect(cat.servedFromDisk).toBe(true);
  });

  it('exposes fetchedAt + age for a disk snapshot', async () => {
    const stateRoot = tmpStateRoot();
    const now = 5_000_000;
    writeSnapshot(stateRoot, now - 2_000, MODELS);
    const cat = await loadCursorCatalog({
      stateRoot,
      ttlMs: TTL,
      now: () => now,
      refresh: async () => MODELS,
    });
    expect(cat.fetchedAt).toBe(now - 2_000);
    expect(cat.ageMs).toBe(2_000);
  });

  it('on an expired TTL serves the stale snapshot and schedules a background refresh', async () => {
    const stateRoot = tmpStateRoot();
    const now = 9_000_000;
    writeSnapshot(stateRoot, now - TTL - 1, MODELS); // expired
    let refreshes = 0;
    const cat = await loadCursorCatalog({
      stateRoot,
      ttlMs: TTL,
      now: () => now,
      refresh: async () => {
        refreshes++;
        return MODELS_V2;
      },
    });
    // Served the STALE snapshot synchronously (zero blocking network).
    expect(cat.models).toEqual(MODELS);
    expect(cat.servedFromDisk).toBe(true);
    // A background refresh was scheduled; await it and confirm it persisted V2.
    await cat.refreshing;
    expect(refreshes).toBe(1);
    expect(readSnapshot(stateRoot).models).toEqual(MODELS_V2);
  });

  it('keeps serving the durable stale snapshot when the background refresh FAILS', async () => {
    const stateRoot = tmpStateRoot();
    const now = 11_000_000;
    writeSnapshot(stateRoot, now - TTL - 1, MODELS);
    const cat = await loadCursorCatalog({
      stateRoot,
      ttlMs: TTL,
      now: () => now,
      refresh: async () => {
        throw new Error('network down');
      },
    });
    // refreshing must settle (never reject — a rejected fire-and-forget would crash).
    await cat.refreshing;
    expect(cat.models).toEqual(MODELS); // stale snapshot retained
    expect(cat.available).toBe(true);
    expect(readSnapshot(stateRoot).models).toEqual(MODELS); // file untouched
  });

  it('fetches on a cold cache (no snapshot) and persists it', async () => {
    const stateRoot = tmpStateRoot();
    const now = 13_000_000;
    const cat = await loadCursorCatalog({
      stateRoot,
      ttlMs: TTL,
      now: () => now,
      refresh: async () => MODELS_V2,
    });
    expect(cat.models).toEqual(MODELS_V2);
    expect(cat.available).toBe(true);
    expect(cat.servedFromDisk).toBe(false); // network-fresh, not disk-served
    expect(cat.fetchedAt).toBe(now);
    expect(readSnapshot(stateRoot).models).toEqual(MODELS_V2);
  });

  it('reports unavailable on a cold cache when refresh rejects (no snapshot to fall back to)', async () => {
    const stateRoot = tmpStateRoot();
    const cat = await loadCursorCatalog({
      stateRoot,
      ttlMs: TTL,
      now: () => 1,
      refresh: async () => {
        throw new Error('network down');
      },
    });
    expect(cat.available).toBe(false);
    expect(cat.models).toEqual([]);
    expect(cat.fetchedAt).toBeUndefined();
  });

  it('forceRefresh replaces the catalog and persists (invalidate + refresh once)', async () => {
    const stateRoot = tmpStateRoot();
    const now = 17_000_000;
    writeSnapshot(stateRoot, now - 1_000, MODELS);
    let refreshes = 0;
    const cat = await loadCursorCatalog({
      stateRoot,
      ttlMs: TTL,
      now: () => now,
      refresh: async () => {
        refreshes++;
        return MODELS_V2;
      },
    });
    expect(refreshes).toBe(0); // fresh: no refresh on load
    await cat.forceRefresh();
    expect(refreshes).toBe(1); // exactly one refresh
    expect(cat.models).toEqual(MODELS_V2);
    expect(cat.servedFromDisk).toBe(false);
    expect(readSnapshot(stateRoot).models).toEqual(MODELS_V2);
  });

  it('forceRefresh throws on failure and keeps the prior snapshot', async () => {
    const stateRoot = tmpStateRoot();
    const now = 19_000_000;
    writeSnapshot(stateRoot, now - 1_000, MODELS);
    const cat = await loadCursorCatalog({
      stateRoot,
      ttlMs: TTL,
      now: () => now,
      refresh: async () => {
        throw new Error('still down');
      },
    });
    await expect(cat.forceRefresh()).rejects.toThrow('still down');
    expect(cat.models).toEqual(MODELS); // unchanged
  });

  it('serializes concurrent cold-cache writers into one un-torn snapshot file', async () => {
    const stateRoot = tmpStateRoot();
    const now = 23_000_000;
    const refresh = async (): Promise<ModelListItem[]> => {
      await Promise.resolve();
      return MODELS_V2;
    };
    const [a, b] = await Promise.all([
      loadCursorCatalog({ stateRoot, ttlMs: TTL, now: () => now, refresh }),
      loadCursorCatalog({ stateRoot, ttlMs: TTL, now: () => now, refresh }),
    ]);
    expect(a.models).toEqual(MODELS_V2);
    expect(b.models).toEqual(MODELS_V2);
    // Exactly one catalog file, and it parses cleanly (no torn/duplicated write).
    const files = readdirSync(stateRoot).filter(f => f === CURSOR_CATALOG_FILE);
    expect(files).toHaveLength(1);
    expect(readSnapshot(stateRoot).models).toEqual(MODELS_V2);
    // No leftover temp files.
    expect(readdirSync(stateRoot).filter(f => f.includes('.tmp'))).toHaveLength(0);
  });
});
