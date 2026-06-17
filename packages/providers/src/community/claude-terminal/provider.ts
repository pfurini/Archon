/**
 * claude-terminal provider — drives the interactive Claude Code TUI via
 * terminalcp and streams structured chunks read from the on-disk session
 * transcript. Spawn-per-turn with `--resume` for continuity (lifecycle-safe:
 * no long-lived orphaned PTY process).
 *
 * Per-turn flow:
 *   1. resolve config + claude binary; pick session id (new uuid or resume id)
 *   2. start the TUI under terminalcp (cd + env-strip + claude <flags>)
 *   3. input-readiness: dismiss the folder-trust dialog, wait for the empty
 *      input box, clear any pre-filled text
 *   4. inject the prompt (bracketed paste + Enter)
 *   5. tail the transcript → yield assistant/thinking/tool/tool_result chunks
 *   6. turn-end when the transcript shows a terminal stop_reason with no open
 *      tool and the screen is no longer working (transcript-authoritative)
 *   7. emit `result` (sessionId, aggregated tokens, best-effort structuredOutput)
 *   8. stop the session (always, via finally)
 *
 * No SDK, no `-p`/stream-json. Data is read ONLY from the transcript; the
 * screen is used only for boot/idle signals (operator chrome never reaches the
 * transcript). I/O seams (terminalcp client, binary/transcript resolution,
 * timers) are injectable via the constructor for testing.
 */
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { createLogger } from '@archon/paths';

import type {
  IAgentProvider,
  MessageChunk,
  NodeConfig,
  ProviderCapabilities,
  SendQueryOptions,
  SystemPromptInput,
} from '../../types';
import { resolveClaudeBinaryPath } from '../../claude/binary-resolver';
import { mapEffort } from '../../effort';
import {
  augmentPromptForJsonSchema,
  tryParseStructuredOutput,
} from '../../shared/structured-output';

import { CLAUDE_TERMINAL_CAPABILITIES } from './capabilities';
import { parseClaudeTerminalConfig } from './config';
import {
  buildClaudeArgs,
  buildLaunchCommand,
  claudeProjectsRoot,
  findTranscriptByUuid,
  isTrustPrompt,
  resolveClaudeConfigDir,
  type ClaudeLaunchSpec,
} from './launch';
import { TerminalcpClient, bracketedPaste, type TerminalDriver } from './terminalcp';
import { TranscriptReader } from './transcript';
import {
  detectScreenActivity,
  isTranscriptTurnComplete,
  isTurnComplete,
  stripAnsi,
} from './turn-detector';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.claude-terminal');
  return cachedLog;
}

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 800;
const DEFAULT_STALL_TIMEOUT_MS = 4 * 60_000;
const DEFAULT_MAX_STALL_RECOVERIES = 1;
/** Injected after a stall-recovery respawn — a plain user nudge; the resumed
 *  conversation already holds the original prompt and all prior work. */
const STALL_CONTINUE_PROMPT = 'continue';
const BOOT_TIMEOUT_MS = 30_000;
const INPUT_READY_POLL_MS = 500;
const TRANSCRIPT_WAIT_POLL_MS = 400;
const SCREEN_TAIL_LINES = 80;
const SCREEN_ERROR_TAIL_LINES = 40;

/** Render the freshest screen read for a failure message: ANSI-stripped,
 *  right-trimmed, capped to the last N lines. The screen is operator chrome —
 *  never data — but at failure time it is the only witness of WHY the TUI
 *  stalled (API retry spinner, usage-limit notice, login prompt, …); without
 *  it a timeout is undiagnosable post-hoc because `finally` tears the PTY down. */
function describeScreen(screen: string): string {
  const text = stripAnsi(screen).replace(/\s+$/u, '');
  if (!text) return '(screen empty)';
  return text.split('\n').slice(-SCREEN_ERROR_TAIL_LINES).join('\n');
}

/** Resolve a json_schema output format from request options or node config. */
function resolveOutputSchema(
  requestOptions: SendQueryOptions | undefined,
  nodeConfig: NodeConfig | undefined
): Record<string, unknown> | undefined {
  if (requestOptions?.outputFormat?.type === 'json_schema')
    return requestOptions.outputFormat.schema;
  if (nodeConfig?.output_format) return nodeConfig.output_format;
  return undefined;
}

/** Collapse a SystemPromptInput into text suitable for `--append-system-prompt`. */
function systemPromptAppend(sp: SystemPromptInput | undefined): string | undefined {
  if (!sp) return undefined;
  if (typeof sp === 'string') return sp || undefined;
  if (Array.isArray(sp)) return sp.join('\n') || undefined;
  if (sp.type === 'preset') return sp.append || undefined;
  return undefined;
}

/** Resolve an MCP config path (from nodeConfig.mcp) to an absolute path. */
function resolveMcpPath(mcp: string, cwd: string): string {
  return isAbsolute(mcp) ? mcp : join(cwd, mcp);
}

/** Injectable seams for testing without real terminalcp / fs / timers. */
export interface ClaudeTerminalProviderDeps {
  createClient?: (command?: string) => TerminalDriver;
  resolveBinary?: (configured?: string) => Promise<string | undefined>;
  /** Resolve a session transcript by id. `root` is the projects dir to scan
   *  (derived from the effective `CLAUDE_CONFIG_DIR`); defaults to `~/.claude`. */
  findTranscript?: (sessionId: string, root?: string) => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class ClaudeTerminalProvider implements IAgentProvider {
  private readonly createClient: (command?: string) => TerminalDriver;
  private readonly resolveBinary: (configured?: string) => Promise<string | undefined>;
  private readonly findTranscript: (sessionId: string, root?: string) => Promise<string | null>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(deps: ClaudeTerminalProviderDeps = {}) {
    this.createClient =
      deps.createClient ??
      ((command): TerminalDriver => new TerminalcpClient(command ? { command } : undefined));
    // Unlike the SDK-based ClaudeProvider, claude-terminal spawns the CLI
    // directly via terminalcp and has no SDK self-resolution fallback. Opt into
    // honoring the configured path in dev mode too, so a source/dev install that
    // sets `assistants.claude-terminal.claudeBinaryPath` launches that binary
    // instead of silently falling back to PATH (#3).
    this.resolveBinary =
      deps.resolveBinary ??
      ((configured): Promise<string | undefined> =>
        resolveClaudeBinaryPath(configured, {
          honorConfigInDevMode: true,
          configSourceLabel: 'assistants.claude-terminal.claudeBinaryPath',
        }));
    this.findTranscript = deps.findTranscript ?? findTranscriptByUuid;
    this.sleep =
      deps.sleep ?? ((ms): Promise<void> => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = deps.now ?? ((): number => Date.now());
  }

  getType(): string {
    return 'claude-terminal';
  }

  getCapabilities(): ProviderCapabilities {
    return CLAUDE_TERMINAL_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const log = getLog();
    const config = parseClaudeTerminalConfig(requestOptions?.assistantConfig ?? {});
    // The resolver returns undefined in dev mode (SDK would self-resolve), but
    // we spawn the CLI directly via terminalcp and need a concrete path: prefer
    // PATH resolution (Bun.which), then bare `claude` (found via the node
    // daemon's inherited PATH).
    const binary =
      (await this.resolveBinary(config.claudeBinaryPath)) ?? Bun.which('claude') ?? 'claude';
    const client = this.createClient(config.terminalcpCommand);

    // Resolve the effective Claude config dir (CLAUDE_CONFIG_DIR). When set, the
    // spawned TUI reads/writes ALL user-scope config (settings, transcripts,
    // .claude.json auth) from this dir — fully isolating Archon from the
    // operator's personal ~/.claude. Both sides must agree on the SAME resolved
    // absolute path: we inject it into the child env (write side) AND scan it
    // for the transcript (read side). Precedence: codebase env override > config
    // option > ambient CLAUDE_CONFIG_DIR > default (~/.claude, claudeConfigDir
    // left undefined so behavior stays byte-identical for non-isolated users).
    const explicitConfigDir =
      requestOptions?.env?.CLAUDE_CONFIG_DIR ??
      config.claudeConfigDir ??
      process.env.CLAUDE_CONFIG_DIR;
    const claudeConfigDir = explicitConfigDir
      ? resolveClaudeConfigDir(explicitConfigDir)
      : undefined;
    const transcriptRoot = claudeProjectsRoot(claudeConfigDir);
    // Re-inject the resolved (expanded, absolute, NFC) value so the child uses
    // exactly the path we scan — overriding any raw/`~`-laden codebase override.
    const launchEnv = claudeConfigDir
      ? { ...requestOptions?.env, CLAUDE_CONFIG_DIR: claudeConfigDir }
      : requestOptions?.env;

    const isResume = Boolean(resumeSessionId);
    const sessionId = resumeSessionId ?? randomUUID();
    const sessionName = `archon-ct-${sessionId.slice(0, 8)}`;
    const nodeConfig = requestOptions?.nodeConfig;

    const outputSchema = resolveOutputSchema(requestOptions, nodeConfig);
    const effectivePrompt = outputSchema
      ? augmentPromptForJsonSchema(prompt, outputSchema)
      : prompt;

    const spec: ClaudeLaunchSpec = {
      sessionId,
      resume: isResume,
      model: requestOptions?.model ?? config.model,
      // Canonical Archon effort (low/medium/high/max) → native `--effort` value.
      // claude-terminal's map is identity, but route through mapEffort so the
      // central table stays the single source of truth.
      effort: mapEffort(nodeConfig?.effort, 'claude-terminal'),
      appendSystemPrompt: systemPromptAppend(requestOptions?.systemPrompt),
      allowedTools: nodeConfig?.allowed_tools,
      disallowedTools: nodeConfig?.denied_tools,
      mcpConfigPaths: nodeConfig?.mcp ? [resolveMcpPath(nodeConfig.mcp, cwd)] : undefined,
    };
    const command = buildLaunchCommand(binary, buildClaudeArgs(spec), cwd, launchEnv);
    // Same launch but resuming this session — used by the stall watchdog to
    // replace a wedged TUI process without losing the conversation.
    const resumeCommand = buildLaunchCommand(
      binary,
      buildClaudeArgs({ ...spec, resume: true }),
      cwd,
      launchEnv
    );

    const turnTimeoutMs = config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const stallTimeoutMs = config.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    const maxStallRecoveries = config.maxStallRecoveries ?? DEFAULT_MAX_STALL_RECOVERIES;

    const abortSignal = requestOptions?.abortSignal;
    const throwIfAborted = (): void => {
      if (abortSignal?.aborted) throw new Error('Query aborted');
    };

    // Resume: the transcript already exists — start reading AFTER its current
    // end so prior turns are skipped (`--resume` appends to the same file).
    let transcriptPath = await this.findTranscript(sessionId, transcriptRoot);
    let startOffset = 0;
    if (transcriptPath) {
      try {
        startOffset = (await stat(transcriptPath)).size;
      } catch {
        startOffset = 0;
      }
    }

    log.info(
      { sessionId, isResume, cwd, hasOutputSchema: Boolean(outputSchema) },
      'claude_terminal.turn_started'
    );
    await client.start(sessionName, command);
    try {
      await this.ensureInputReady(client, sessionName, throwIfAborted, claudeConfigDir);

      // Clear any pre-filled input (operator plugins can inject box text) before
      // pasting our prompt, then bracketed-paste + Enter (raw \n does not submit;
      // a single Enter/CR does — Finding 6).
      throwIfAborted();
      await client.stdin(sessionName, ['::C-u']);
      await client.stdin(sessionName, [bracketedPaste(effectivePrompt), '::Enter']);

      const deadline = this.now() + turnTimeoutMs;
      if (!transcriptPath) {
        transcriptPath = await this.waitForTranscript(
          sessionId,
          transcriptRoot,
          deadline,
          throwIfAborted
        );
      }

      const reader = new TranscriptReader(transcriptPath, startOffset);
      let assistantText = '';
      let deadPolls = 0;
      let lastProgressAt = this.now();
      let stallRecoveries = 0;

      for (;;) {
        throwIfAborted();
        const { chunks, summary } = await reader.pull();
        for (const chunk of chunks) {
          if (chunk.type === 'assistant') assistantText += chunk.content;
          yield chunk;
        }
        if (chunks.length > 0) {
          lastProgressAt = this.now();
        }
        const screen = await client.stdout(sessionName, SCREEN_TAIL_LINES);
        if (isTurnComplete(summary, screen)) break;

        // Fail fast if the TUI process died mid-turn (a crash, or a Claude
        // session/usage-limit notice that terminates the CLI — #1852) instead of
        // hanging to turnTimeoutMs. Our spawn-per-turn TUI never self-exits during
        // a turn, so a CONFIRMED stopped/absent session is always a failure here.
        // `isSessionAlive` is tri-state: only a confirmed-dead reading (false)
        // counts toward deadPolls; an inconclusive `list` (undefined) is held, not
        // counted, so a transient hiccup can't abort a live turn. Two confirmed
        // readings are required, and we re-drain once in case a terminal line
        // landed as the process exited.
        const alive = await client.isSessionAlive(sessionName);
        if (alive === true) {
          deadPolls = 0;
        } else if (alive === false && ++deadPolls >= 2) {
          const drained = await reader.pull();
          for (const chunk of drained.chunks) {
            if (chunk.type === 'assistant') assistantText += chunk.content;
            yield chunk;
          }
          if (isTranscriptTurnComplete(drained.summary)) break;
          throw new Error(
            `claude-terminal session ${sessionId} exited before completing the turn ` +
              '(the TUI process died — e.g. a crash or a Claude session/usage limit). ' +
              `Last screen:\n${describeScreen(screen)}`
          );
        }

        if (this.now() > deadline) {
          throw new Error(
            `claude-terminal turn exceeded ${turnTimeoutMs}ms without completing (session ${sessionId}). ` +
              `Last screen:\n${describeScreen(screen)}`
          );
        }

        // Stall watchdog: no transcript progress for stallTimeoutMs while NO
        // tool call is in flight. openToolUses > 0 means silence is expected
        // (a long-running tool writes nothing between tool_use and tool_result);
        // with the tools balanced, prolonged silence is the signature of a turn
        // wedged in/before its next API request (observed: 9 min of dead air
        // after a delivered tool_result). Recovery is process-level, not
        // keystroke-level: kill the TUI (a stuck in-flight request dies with
        // it, writing nothing), respawn with --resume (appends to the same
        // transcript — the reader keeps its offset, and the resume-bootstrap
        // synthetic turn is already filtered), and nudge with a plain
        // "continue". The turn deadline above stays the hard backstop —
        // recoveries spend it, never extend it.
        if (
          stallRecoveries < maxStallRecoveries &&
          summary.openToolUses === 0 &&
          this.now() - lastProgressAt > stallTimeoutMs
        ) {
          stallRecoveries++;
          log.warn(
            {
              sessionId,
              stallRecoveries,
              stalledForMs: this.now() - lastProgressAt,
              screen: describeScreen(screen),
            },
            'claude_terminal.stall_recovery'
          );
          await client.stop(sessionName);
          await client.start(sessionName, resumeCommand);
          await this.ensureInputReady(client, sessionName, throwIfAborted);
          await client.stdin(sessionName, ['::C-u']);
          await client.stdin(sessionName, [bracketedPaste(STALL_CONTINUE_PROMPT), '::Enter']);
          lastProgressAt = this.now();
          deadPolls = 0;
          continue;
        }

        await this.sleep(pollIntervalMs);
      }

      // Final drain — catch any lines flushed between the last pull and break.
      const tail = await reader.pull();
      for (const chunk of tail.chunks) {
        if (chunk.type === 'assistant') assistantText += chunk.content;
        yield chunk;
      }

      const summary = reader.turnSummary;
      const structuredOutput = outputSchema ? tryParseStructuredOutput(assistantText) : undefined;
      yield {
        type: 'result',
        sessionId,
        ...(summary.usage ? { tokens: summary.usage } : {}),
        ...(structuredOutput !== undefined ? { structuredOutput } : {}),
        ...(summary.lastAssistantStopReason ? { stopReason: summary.lastAssistantStopReason } : {}),
      };
      log.info(
        { sessionId, tokens: summary.usage, stopReason: summary.lastAssistantStopReason },
        'claude_terminal.turn_completed'
      );
    } finally {
      await client.stop(sessionName);
    }
  }

  /** Wait for the TUI to boot: dismiss the folder-trust dialog and block until
   *  the input box is ready. Throws if it never becomes ready. When an isolated
   *  `isolatedConfigDir` is in effect, a boot timeout most likely means that dir
   *  is unprovisioned (the login/onboarding screens block input-readiness and
   *  this provider deliberately does not script them) — so the error points the
   *  operator at the one-time `CLAUDE_CONFIG_DIR=<dir> claude` provisioning. */
  private async ensureInputReady(
    client: TerminalDriver,
    sessionName: string,
    throwIfAborted: () => void,
    isolatedConfigDir?: string
  ): Promise<void> {
    const deadline = this.now() + BOOT_TIMEOUT_MS;
    let trustAccepts = 0;
    let lastScreen = '';
    while (this.now() < deadline) {
      throwIfAborted();
      const screen = await client.stdout(sessionName, SCREEN_TAIL_LINES);
      lastScreen = screen;
      if (isTrustPrompt(screen) && trustAccepts < 3) {
        // Option 1 ("Yes, I trust this folder") is preselected — Enter accepts.
        await client.stdin(sessionName, ['::Enter']);
        trustAccepts++;
        await this.sleep(700);
        continue;
      }
      if (detectScreenActivity(screen).inputReady) return;
      await this.sleep(INPUT_READY_POLL_MS);
    }
    const provisioningHint = isolatedConfigDir
      ? ` The isolated CLAUDE_CONFIG_DIR (${isolatedConfigDir}) may be unprovisioned — ` +
        `run \`CLAUDE_CONFIG_DIR=${isolatedConfigDir} claude\` once to log in and finish onboarding.`
      : '';
    throw new Error(
      'claude-terminal: TUI did not become input-ready within boot timeout.' +
        provisioningHint +
        `\nLast screen:\n${describeScreen(lastScreen)}`
    );
  }

  /** Poll for the session transcript file to appear (new session, after the
   *  first prompt) under `root` (the effective CLAUDE_CONFIG_DIR projects dir).
   *  Throws on timeout. */
  private async waitForTranscript(
    sessionId: string,
    root: string,
    deadline: number,
    throwIfAborted: () => void
  ): Promise<string> {
    while (this.now() < deadline) {
      throwIfAborted();
      const path = await this.findTranscript(sessionId, root);
      if (path) return path;
      await this.sleep(TRANSCRIPT_WAIT_POLL_MS);
    }
    throw new Error(`claude-terminal: transcript for session ${sessionId} never appeared`);
  }
}
