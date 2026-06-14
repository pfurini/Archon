/**
 * `@cursor/sdk` dynamic loader + background-rejection guard.
 *
 * ## Why dynamic import (not a static `import { Agent }`)
 * `@cursor/sdk` statically top-level-imports native `sqlite3`. That native
 * module cannot load inside a `bun build --compile` single-file binary
 * (sqlite3's `bindings` walks the filesystem for `node_modules`/`package.json`,
 * which don't exist in bun's `$bunfs` virtual root). A static import would
 * therefore CRASH the compiled Archon binary at module-load time — before any
 * cursor run is even requested.
 *
 * Loading the SDK lazily, only when a cursor run actually executes, keeps the
 * compiled binary bootable and turns the (unavoidable, in a compiled binary)
 * sqlite3 failure into a CATCHABLE error that yields a clean `result` chunk
 * instead of taking down the process. On a source / `bun run` install the
 * dynamic import resolves normally and cursor is fully functional.
 * (Verified empirically — see the plan §9b sqlite3 / bun-compile gate.)
 *
 * Mirrors the gsd-pi `sdk-runtime.ts` precedent, minus its `createRequire`
 * indirection: `@cursor/sdk` is a real dependency here, so `import type` gives
 * us the genuine SDK types and the runtime `import()` resolves from
 * node_modules in dev/source installs.
 */
import { createLogger } from '@archon/paths';

import { redactSecrets } from './redact';
import type { CursorSdkModule } from './sdk-types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.cursor');
  return cachedLog;
}

const SDK_MODULE_NAME = '@cursor/sdk';

type LoadState = CursorSdkModule | null | undefined;
let cachedSdk: LoadState = undefined;
let warnedThisProcess = false;

/**
 * Load `@cursor/sdk` lazily.
 *   - Returns the cached module on subsequent calls.
 *   - Returns `null` on any failure (package missing, native sqlite3 unable to
 *     load in a compiled binary, or an unexpected export shape) — logs once per
 *     process. Callers surface this as a graceful `result` error chunk.
 *   - Override via {@link __setSdkForTests}.
 */
export async function loadCursorSdk(): Promise<CursorSdkModule | null> {
  if (cachedSdk !== undefined) return cachedSdk;

  // Indirect specifier so the literal can't be statically pre-resolved/bundled
  // in a way that re-introduces the eager sqlite3 load this loader exists to
  // defer.
  const moduleName: string = SDK_MODULE_NAME;
  try {
    const mod = (await import(/* webpackIgnore: true */ moduleName)) as unknown;
    if (!isSdkModule(mod)) {
      warnOnce(new Error('@cursor/sdk import resolved but is missing Agent.create()'));
      cachedSdk = null;
      return null;
    }
    cachedSdk = mod;
    return mod;
  } catch (err) {
    warnOnce(err);
    cachedSdk = null;
    return null;
  }
}

/**
 * Duck-type the dynamic import: `Agent` is exported as a class
 * (`typeof === "function"`) and `JsonlLocalAgentStore` as a class too. Accept
 * function-or-object for `Agent` so a surprising SDK shape still produces a
 * single clear warning, not a crash inside the pump.
 */
function isSdkModule(value: unknown): value is CursorSdkModule {
  if (!value || typeof value !== 'object') return false;
  const v = value as { Agent?: unknown; JsonlLocalAgentStore?: unknown };
  if (!v.Agent || (typeof v.Agent !== 'object' && typeof v.Agent !== 'function')) return false;
  if (typeof (v.Agent as { create?: unknown }).create !== 'function') return false;
  return typeof v.JsonlLocalAgentStore === 'function';
}

function warnOnce(err: unknown): void {
  if (warnedThisProcess) return;
  warnedThisProcess = true;
  const detail = err instanceof Error ? err.message : String(err);
  getLog().warn({ detail: redactSecrets(detail) }, 'cursor.sdk_load_failed');
}

// ─── Background-rejection guard ───────────────────────────────────────────

// @cursor/sdk surfaces auth / transport failures from detached background
// Connect-RPC tasks as *unhandled* promise rejections that no try/catch inside
// the pump can intercept (a present-but-invalid CURSOR_API_KEY produces an
// `unauthenticated` ConnectError this way). The pump's own `run.wait()` drain
// still yields a clean error terminal, so the extra rejection is redundant —
// but in Archon's long-lived server process it would hit the host crash guard.
//
// We can't `.catch` a promise we never receive a handle to, and a time-scoped
// listener loses the race (the SDK can reject *after* `run.wait()` resolved).
// So the guard installs once, lazily, on the first cursor pump and lives for
// the process: it takes over `unhandledRejection`, swallows
// cursor-SDK-identifiable rejections (one redacted log line), and forwards
// every other rejection to the host listeners it replaced — so unrelated bugs
// still crash exactly as before. Assumes the host installs its crash guard at
// bootstrap, before any cursor run.

type RejectionListener = (reason: unknown, promise: Promise<unknown>) => void;

let rejectionGuardInstalled = false;
let inheritedRejectionListeners: RejectionListener[] = [];
let installedRejectionGuard: RejectionListener | undefined;
let absorbedRejectionWarned = false;

/** Lazy, idempotent. Called at the head of every cursor pump. */
export function installSdkRejectionGuard(): void {
  if (rejectionGuardInstalled) return;
  rejectionGuardInstalled = true;

  inheritedRejectionListeners = process.listeners('unhandledRejection') as RejectionListener[];
  for (const listener of inheritedRejectionListeners) {
    process.removeListener('unhandledRejection', listener);
  }

  installedRejectionGuard = (reason: unknown, promise: Promise<unknown>): void => {
    if (looksLikeCursorSdkError(reason)) {
      if (!absorbedRejectionWarned) {
        absorbedRejectionWarned = true;
        const detail = reason instanceof Error ? reason.message : String(reason);
        getLog().warn({ detail: redactSecrets(detail) }, 'cursor.sdk_rejection_absorbed');
      }
      return;
    }
    // Not a cursor-SDK rejection — preserve host behaviour exactly.
    if (inheritedRejectionListeners.length === 0) {
      // No host crash guard (bare / test runtime): restore Node's default
      // "throw on unhandled rejection" so genuine bugs still surface.
      queueMicrotask(() => {
        throw reason;
      });
      return;
    }
    for (const listener of inheritedRejectionListeners) {
      listener(reason, promise);
    }
  };
  process.on('unhandledRejection', installedRejectionGuard);
}

/**
 * Duck-type a rejection as originating from @cursor/sdk or its Connect-RPC
 * transport. Walks the `cause` chain since the SDK wraps the underlying
 * AuthenticationError inside a ConnectError.
 */
function looksLikeCursorSdkError(reason: unknown): boolean {
  let current: unknown = reason;
  for (let depth = 0; depth < 6 && current; depth++) {
    if (typeof current !== 'object') break;
    const err = current as {
      name?: unknown;
      code?: unknown;
      stack?: unknown;
      cause?: unknown;
      constructor?: { name?: unknown };
    };
    const nameRaw = err.name ?? err.constructor?.name;
    const name = typeof nameRaw === 'string' ? nameRaw : '';
    if (
      /ConnectError|CursorAgentError|CursorSdkError|AuthenticationError|RateLimitError|NetworkError|ConfigurationError/.test(
        name
      )
    ) {
      return true;
    }
    if (
      typeof err.code === 'string' &&
      /^(unauthenticated|unauthorized|permission_denied)$/.test(err.code)
    ) {
      return true;
    }
    if (typeof err.stack === 'string' && /[/@](cursor[/-]sdk|connectrpc)/.test(err.stack)) {
      return true;
    }
    current = err.cause;
  }
  return false;
}

/** @internal Test-only — undo the takeover, restoring inherited listeners. */
export function resetRejectionGuardForTests(): void {
  if (installedRejectionGuard) {
    process.removeListener('unhandledRejection', installedRejectionGuard);
  }
  for (const listener of inheritedRejectionListeners) {
    process.on('unhandledRejection', listener);
  }
  rejectionGuardInstalled = false;
  inheritedRejectionListeners = [];
  installedRejectionGuard = undefined;
  absorbedRejectionWarned = false;
}

/**
 * @internal Test-only. Pass a structural mock to short-circuit the dynamic
 * import; pass `null` to force the failure branch; pass `undefined` to reset the
 * cache and let the next call probe normally.
 */
export function setSdkForTests(mod: CursorSdkModule | null | undefined): void {
  cachedSdk = mod;
  if (mod !== null) warnedThisProcess = false;
}

/** @internal Test-only — reset the warn-once latch. */
export function resetWarnedForTests(): void {
  warnedThisProcess = false;
}
