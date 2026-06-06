import type { ProviderCapabilities } from '../../types';

/**
 * claude-terminal capabilities — community provider that drives the interactive
 * Claude Code TUI via terminal automation (terminalcp) and reads structured
 * events from the on-disk session transcript (NOT by scraping the screen).
 *
 * Flags reflect WIRED behavior, not aspiration (the dag-executor warns when a
 * node uses a feature the provider ignores):
 * - The interactive CLI accepts most config at launch — `--mcp-config`,
 *   `--append-system-prompt`, `--allowed-tools`/`--disallowed-tools`,
 *   `--session-id`/`--resume`, skills auto-loaded from `.claude/skills` — so
 *   mcp/skills/toolRestrictions/sessionResume/envInjection are true.
 * - SDK-runtime-only options have NO interactive-TUI equivalent and are false:
 *   costControl (maxBudgetUsd), fallbackModel, sandbox, programmatic hooks,
 *   inline agent definitions, and in-process nativeTools. (With nativeTools
 *   false, the orchestrator auto-appends the bash run-management prompt for
 *   project-scoped chat — same path as Codex/OpenCode/Copilot.)
 * - effort/thinking are CAPTURED from the transcript but not CONTROLLABLE via a
 *   launch flag, so effortControl/thinkingControl are false.
 *
 * structuredOutput is best-effort (not SDK-enforced): the provider appends the
 * JSON schema to the prompt and extracts JSON from the final assistant
 * transcript message — mirrors the Pi approach. Parse failures degrade via the
 * dag-executor's existing structured_output_missing path.
 */
export const CLAUDE_TERMINAL_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: true,
  hooks: false,
  skills: true,
  agents: false,
  toolRestrictions: true,
  structuredOutput: 'best-effort', // prompt-augmented + JSON extraction (no SDK grammar enforcement)
  envInjection: true,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
  nativeTools: false,
};
