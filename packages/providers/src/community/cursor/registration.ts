import { isRegisteredProvider, registerProvider } from '../../registry';

import { CURSOR_CAPABILITIES } from './capabilities';
import { CursorProvider } from './provider';

/**
 * Register the cursor community provider.
 *
 * Idempotent — safe for every process entrypoint (CLI, server, config-loader)
 * to call. `builtIn: false`: this is a community provider driving the beta
 * `@cursor/sdk` against Cursor-routed models.
 *
 * The `cursor` vendor is the first native-only credential vendor (not also a Pi
 * backend), so @archon/core's delivery map (`KNOWN_VENDORS` + `deliverCredential`
 * + `EXTRA_INSTALL_ENV_VARS`) lists it explicitly — without that, `getVendorCatalog`
 * throws at bootstrap ("delivery map has no rule for it"). See
 * packages/core/src/credentials/{delivery,catalog}.ts.
 */
export function registerCursorProvider(): void {
  if (isRegisteredProvider('cursor')) return;
  registerProvider({
    id: 'cursor',
    displayName: 'Cursor (community)',
    factory: () => new CursorProvider(),
    capabilities: CURSOR_CAPABILITIES,
    builtIn: false,
    credentials: {
      kind: 'static',
      specs: [{ vendor: 'cursor', displayName: 'Cursor', kinds: ['api_key'] }],
    },
  });
}
