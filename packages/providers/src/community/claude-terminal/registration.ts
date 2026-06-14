import { isRegisteredProvider, registerProvider } from '../../registry';

import { CLAUDE_TERMINAL_CAPABILITIES } from './capabilities';
import { ClaudeTerminalProvider } from './provider';

/**
 * Register the claude-terminal community provider.
 *
 * Idempotent — safe for every process entrypoint (CLI, server, config-loader)
 * to call. `builtIn: false`: this is a community provider (drives the
 * interactive Claude Code TUI via terminalcp), distinct from the SDK-based
 * built-in `claude` provider, which remains the default.
 */
export function registerClaudeTerminalProvider(): void {
  if (isRegisteredProvider('claude-terminal')) return;
  registerProvider({
    id: 'claude-terminal',
    displayName: 'Claude Code (terminal · community)',
    factory: () => new ClaudeTerminalProvider(),
    capabilities: CLAUDE_TERMINAL_CAPABILITIES,
    builtIn: false,
    // claude-terminal wraps the `claude` CLI, so it consumes the same Anthropic
    // credential surface as the built-in `claude` provider (api key, or a
    // `claude /login` subscription).
    credentials: {
      kind: 'static',
      specs: [
        { vendor: 'anthropic', displayName: 'Anthropic', kinds: ['api_key', 'subscription'] },
      ],
    },
  });
}
