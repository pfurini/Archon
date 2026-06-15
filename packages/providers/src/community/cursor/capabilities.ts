import type { ProviderCapabilities } from '../../types';

/**
 * Cursor capabilities — community provider driving the beta `@cursor/sdk`
 * (`Agent.create → agent.send → run.stream()`) against Cursor-routed models.
 *
 * Flags reflect WIRED behavior, not aspiration (the dag-executor warns when a
 * node uses a feature the provider ignores). Phase 1 scope (APPROVED):
 * core text/tools/best-effort structured output + session resume + MCP +
 * sandbox.
 * - `sessionResume`: the SDK `agentId` is persisted as `result.sessionId`;
 *   resume reconstructs the agent against a stable SqliteLocalAgentStore root
 *   (the Node sidecar's `index.db` routes resume by agentId, not by cwd).
 * - `mcp`: node `mcp:` config file → `AgentOptions.mcpServers`.
 * - `sandbox`: node `sandbox` → `LocalAgentOptions.sandboxOptions.enabled`.
 * - `structuredOutput: 'best-effort'`: prompt-augment with the JSON schema +
 *   extract JSON from the accumulated assistant text (no SDK grammar
 *   enforcement). Validation + re-ask handled by the dag-executor.
 * - `nativeTools: false` ⟹ the orchestrator appends the bash run-management
 *   prompt for project-scoped chat (same path as Codex/OpenCode/Copilot).
 *
 * Deferred (feasible via the SDK, not in Phase 1): inline `agents`
 * (`AgentOptions.agents`), `effortControl` (per-model `ModelSelection.params`),
 * `nativeTools` (an `SDKCustomTool` host for `manage_run`). `envInjection` is
 * `false` because local Cursor agents take no env map (only cloud agents do).
 */
export const CURSOR_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: true,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: false,
  structuredOutput: 'best-effort', // prompt-augmented + JSON extraction (no SDK grammar enforcement)
  envInjection: false,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: true,
  nativeTools: false,
};
