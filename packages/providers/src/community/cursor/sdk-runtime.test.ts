import { afterEach, describe, expect, it } from 'bun:test';

import type { CursorSdkModule } from './sdk-types';
import {
  installSdkRejectionGuard,
  loadCursorSdk,
  resetRejectionGuardForTests,
  setSdkForTests,
} from './sdk-runtime';

const fakeModule = {
  Agent: { create: () => {} },
  JsonlLocalAgentStore: class {},
} as unknown as CursorSdkModule;

afterEach(() => {
  setSdkForTests(undefined); // reset loader cache
  resetRejectionGuardForTests();
});

describe('loadCursorSdk', () => {
  it('returns the injected module from the cache', async () => {
    setSdkForTests(fakeModule);
    expect(await loadCursorSdk()).toBe(fakeModule);
  });

  it('returns null when the cache is forced to a load failure', async () => {
    setSdkForTests(null);
    expect(await loadCursorSdk()).toBeNull();
  });
});

describe('installSdkRejectionGuard', () => {
  it('absorbs cursor-SDK rejections and forwards unrelated ones to host listeners', () => {
    const forwarded: unknown[] = [];
    const hostListener = (reason: unknown): void => {
      forwarded.push(reason);
    };
    process.on('unhandledRejection', hostListener);
    try {
      installSdkRejectionGuard();

      // A cursor/Connect-RPC-shaped rejection → absorbed (host not notified).
      const cursorErr = Object.assign(new Error('unauthenticated'), { code: 'unauthenticated' });
      process.emit('unhandledRejection', cursorErr, Promise.resolve());
      expect(forwarded).toHaveLength(0);

      // An unrelated rejection → forwarded to the inherited host listener.
      // Neutralize the stack: this test file lives under a `cursor/` path, and
      // the guard's stack heuristic (`cursor[/-]sdk`) would otherwise match the
      // test file path itself and misclassify the error as cursor-origin.
      const plainErr = new Error('some unrelated bug');
      plainErr.stack = 'Error: some unrelated bug\n    at /tmp/unrelated.ts:1:1';
      process.emit('unhandledRejection', plainErr, Promise.resolve());
      expect(forwarded).toEqual([plainErr]);
    } finally {
      process.removeListener('unhandledRejection', hostListener);
    }
  });

  it('absorbs a transient transport rejection (NGHTTP2 stream error) without forwarding', () => {
    const forwarded: unknown[] = [];
    const hostListener = (reason: unknown): void => {
      forwarded.push(reason);
    };
    process.on('unhandledRejection', hostListener);
    try {
      installSdkRejectionGuard();
      // Connect-RPC-shaped (matches looksLikeCursorSdkError via stack) AND
      // transient (message → isTransientTransportRejection) ⟹ absorbed at debug,
      // never forwarded. The SDK retries and the run completes.
      const transientErr = new Error(
        '[internal] Stream closed with error code NGHTTP2_FRAME_SIZE_ERROR'
      );
      transientErr.stack = `${transientErr.message}\n    at /x/node_modules/@connectrpc/connect-node/dist/index.js:1:1`;
      process.emit('unhandledRejection', transientErr, Promise.resolve());
      expect(forwarded).toHaveLength(0);
    } finally {
      process.removeListener('unhandledRejection', hostListener);
    }
  });

  it('is idempotent — a second install is a no-op', () => {
    installSdkRejectionGuard();
    expect(() => installSdkRejectionGuard()).not.toThrow();
  });
});
