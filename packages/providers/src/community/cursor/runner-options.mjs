/**
 * Pure builder for `@cursor/sdk` `AgentOptions` from the sidecar's stdin config.
 *
 * Extracted from `cursor-runner.mjs` so it is unit-testable WITHOUT loading the
 * SDK, overriding console, or reading stdin (this module has zero side effects).
 * The SAME options object drives BOTH `Agent.create` and `Agent.resume`, so per-
 * model `ModelSelection.params` reach both paths identically.
 *
 * `model` carries `params` ONLY when the parent resolved at least one knob — an
 * empty/absent list yields `model: { id }`, byte-for-byte the pre-feature shape
 * (so a no-params turn is unchanged).
 *
 * NOTE (observability, plan §0.3): the SDK does NOT report the server-resolved or
 * billed tier — `run.wait().model` echoes the request and `system.model` is
 * undefined for local agents. This shapes only the REQUEST.
 *
 * @param {{ model: string, cwd: string, settingSources?: string[], sandbox?: boolean,
 *           mcpServers?: Record<string, unknown>, modelParams?: Array<{id:string,value:string}> }} cfg
 * @param {{ store: unknown, apiKey: string | undefined }} runtime
 */
export function buildAgentOptions(cfg, { store, apiKey }) {
  const params = cfg.modelParams;
  const model =
    Array.isArray(params) && params.length > 0 ? { id: cfg.model, params } : { id: cfg.model };

  return {
    apiKey,
    model,
    local: {
      cwd: cfg.cwd,
      settingSources: cfg.settingSources ?? ['project'],
      store,
      ...(cfg.sandbox ? { sandboxOptions: { enabled: true } } : {}),
    },
    ...(cfg.mcpServers ? { mcpServers: cfg.mcpServers } : {}),
  };
}
