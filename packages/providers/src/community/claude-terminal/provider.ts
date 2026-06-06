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
import {
  augmentPromptForJsonSchema,
  tryParseStructuredOutput,
} from '../../shared/structured-output';

import { CLAUDE_TERMINAL_CAPABILITIES } from './capabilities';
import { parseClaudeTerminalConfig } from './config';
import {
  buildClaudeArgs,
  buildLaunchCommand,
  findTranscriptByUuid,
  isTrustPrompt,
  type ClaudeLaunchSpec,
} from './launch';
import { TerminalcpClient, bracketedPaste, type TerminalDriver } from './terminalcp';
import { TranscriptReader } from './transcript';
import { detectScreenActivity, isTranscriptTurnComplete, isTurnComplete } from './turn-detector';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.claude-terminal');
  return cachedLog;
}

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 800;
const BOOT_TIMEOUT_MS = 30_000;
const INPUT_READY_POLL_MS = 500;
const TRANSCRIPT_WAIT_POLL_MS = 400;
const SCREEN_TAIL_LINES = 80;

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
  findTranscript?: (sessionId: string) => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class ClaudeTerminalProvider implements IAgentProvider {
  private readonly createClient: (command?: string) => TerminalDriver;
  private readonly resolveBinary: (configured?: string) => Promise<string | undefined>;
  private readonly findTranscript: (sessionId: string) => Promise<string | null>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(deps: ClaudeTerminalProviderDeps = {}) {
    this.createClient =
      deps.createClient ??
      ((command): TerminalDriver => new TerminalcpClient(command ? { command } : undefined));
    this.resolveBinary = deps.resolveBinary ?? resolveClaudeBinaryPath;
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
      appendSystemPrompt: systemPromptAppend(requestOptions?.systemPrompt),
      allowedTools: nodeConfig?.allowed_tools,
      disallowedTools: nodeConfig?.denied_tools,
      mcpConfigPaths: nodeConfig?.mcp ? [resolveMcpPath(nodeConfig.mcp, cwd)] : undefined,
    };
    const command = buildLaunchCommand(binary, buildClaudeArgs(spec), cwd, requestOptions?.env);

    const turnTimeoutMs = config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    const abortSignal = requestOptions?.abortSignal;
    const throwIfAborted = (): void => {
      if (abortSignal?.aborted) throw new Error('Query aborted');
    };

    // Resume: the transcript already exists — start reading AFTER its current
    // end so prior turns are skipped (`--resume` appends to the same file).
    let transcriptPath = await this.findTranscript(sessionId);
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
      await this.ensureInputReady(client, sessionName, throwIfAborted);

      // Clear any pre-filled input (operator plugins can inject box text) before
      // pasting our prompt, then bracketed-paste + Enter (raw \n does not submit;
      // a single Enter/CR does — Finding 6).
      throwIfAborted();
      await client.stdin(sessionName, ['::C-u']);
      await client.stdin(sessionName, [bracketedPaste(effectivePrompt), '::Enter']);

      const deadline = this.now() + turnTimeoutMs;
      if (!transcriptPath) {
        transcriptPath = await this.waitForTranscript(sessionId, deadline, throwIfAborted);
      }

      const reader = new TranscriptReader(transcriptPath, startOffset);
      let assistantText = '';
      let deadPolls = 0;

      for (;;) {
        throwIfAborted();
        const { chunks, summary } = await reader.pull();
        for (const chunk of chunks) {
          if (chunk.type === 'assistant') assistantText += chunk.content;
          yield chunk;
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
              '(the TUI process died — e.g. a crash or a Claude session/usage limit)'
          );
        }

        if (this.now() > deadline) {
          throw new Error(
            `claude-terminal turn exceeded ${turnTimeoutMs}ms without completing (session ${sessionId})`
          );
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
   *  the input box is ready. Throws if it never becomes ready. */
  private async ensureInputReady(
    client: TerminalDriver,
    sessionName: string,
    throwIfAborted: () => void
  ): Promise<void> {
    const deadline = this.now() + BOOT_TIMEOUT_MS;
    let trustAccepts = 0;
    while (this.now() < deadline) {
      throwIfAborted();
      const screen = await client.stdout(sessionName, SCREEN_TAIL_LINES);
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
    throw new Error('claude-terminal: TUI did not become input-ready within boot timeout');
  }

  /** Poll for the session transcript file to appear (new session, after the
   *  first prompt). Throws on timeout. */
  private async waitForTranscript(
    sessionId: string,
    deadline: number,
    throwIfAborted: () => void
  ): Promise<string> {
    while (this.now() < deadline) {
      throwIfAborted();
      const path = await this.findTranscript(sessionId);
      if (path) return path;
      await this.sleep(TRANSCRIPT_WAIT_POLL_MS);
    }
    throw new Error(`claude-terminal: transcript for session ${sessionId} never appeared`);
  }
}
