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
 * - `effortControl` / `thinkingControl`: node `effort:` / `thinking:` translate to
 *   the resolved model's `ModelSelection.params` (`effort`/`reasoning` and
 *   `thinking`), VALIDATED against the live `Cursor.models.list()` catalog. An
 *   EXPLICIT knob the model can't express fails LOUD (`cursor_model_params_unavailable`,
 *   sidecar not spawned) — never silently dropped, so advertising `true` is honest
 *   (see `model-params.ts` / `provider.ts`). cursor's effort vocabulary is
 *   per-model (catalog-driven), so it is NOT in the static `EFFORT_MAPS` table but
 *   in `DYNAMIC_CATALOG_EFFORT_PROVIDERS` (the invariant's exemption — `effort.ts`).
 *
 * Deferred (feasible via the SDK, not in Phase 1): inline `agents`
 * (`AgentOptions.agents`), `nativeTools` (an `SDKCustomTool` host for `manage_run`).
 * `envInjection` is `false` because local Cursor agents take no env map (only cloud
 * agents do). `costControl` (`maxBudgetUsd`) is unsupported; the cost lever is the
 * `fast`/standard tier via `assistants.cursor.fast`.
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
  effortControl: true, // node effort: → ModelSelection.params (catalog-validated, fail-loud)
  thinkingControl: true, // node thinking: → ModelSelection.params.thinking (catalog-validated)
  fallbackModel: false,
  sandbox: true,
  nativeTools: false,
};
