import type { ProviderCapabilities } from '../types';

export const CODEX_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: true,
  hooks: false,
  skills: true, // filesystem autodiscovery from .agents/skills/ — not per-node injection; nodeConfig.skills is ignored
  agents: false,
  toolRestrictions: false,
  structuredOutput: 'enforced', // SDK outputSchema grammar-constrains decoding
  envInjection: true,
  costControl: false,
  // Node-level `effort:` routes to `modelReasoningEffort` (max → xhigh) via the
  // central effort mapper; see buildThreadOptions in provider.ts.
  effortControl: true,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
  nativeTools: false,
};
