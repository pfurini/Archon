/**
 * cursor provider — drives the beta `@cursor/sdk`
 * (`Agent.create → agent.send → run.stream()`) and streams Archon
 * `MessageChunk`s. Community provider (`builtIn: false`); the SDK is loaded
 * lazily via a dynamic import so the compiled Archon binary stays bootable
 * despite the SDK's native sqlite3 dependency (see `sdk-runtime.ts`).
 *
 * Per-turn flow:
 *   1. load the SDK (lazy); resolve apiKey + model (both required — fail fast)
 *   2. install the background-rejection guard + console fence (load-bearing)
 *   3. `Agent.create`/`Agent.resume` against a stable JsonlLocalAgentStore root,
 *      with settingSources:['project'], optional mcpServers + sandbox
 *   4. `agent.send(prompt, { onDelta })` capturing the `turn-ended` usage block
 *   5. iterate `run.stream()`, translating + COALESCING assistant deltas
 *   6. drain `run.wait()`, extract best-effort structured output, emit `result`
 *      (sessionId = agentId, tokens, structuredOutput?)
 *   7. close the agent (always, via finally)
 */
import { join } from 'node:path';

import { createLogger, getArchonHome } from '@archon/paths';

import type {
  IAgentProvider,
  MessageChunk,
  NodeConfig,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';
import { loadMcpConfig } from '../../mcp/config';
import {
  augmentPromptForJsonSchema,
  tryParseStructuredOutput,
} from '../../shared/structured-output';

import { CURSOR_CAPABILITIES } from './capabilities';
import { parseCursorConfig } from './config';
import { redactSecrets } from './redact';
import type {
  CursorSdkModule,
  CursorUsage,
  InteractionUpdate,
  McpServerConfig,
  Run,
  SDKAgent,
} from './sdk-types';
import { enterSdkConsoleScope, exitSdkConsoleScope } from './sdk-console-guard';
import { installSdkRejectionGuard, loadCursorSdk } from './sdk-runtime';
import {
  finalizeResult,
  flushText,
  makeTranslationState,
  translateSdkMessage,
} from './stream-translation';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.cursor');
  return cachedLog;
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

/** A single `result` error chunk (used for fail-fast paths before/around the run). */
function errorResult(message: string, subtype: string): MessageChunk {
  return { type: 'result', isError: true, errorSubtype: subtype, errors: [redactSecrets(message)] };
}

/** Injectable seam for testing the pump without the real `@cursor/sdk`. */
export interface CursorProviderDeps {
  loadSdk?: () => Promise<CursorSdkModule | null>;
}

export class CursorProvider implements IAgentProvider {
  private readonly loadSdk: () => Promise<CursorSdkModule | null>;

  constructor(deps: CursorProviderDeps = {}) {
    this.loadSdk = deps.loadSdk ?? loadCursorSdk;
  }

  getType(): string {
    return 'cursor';
  }

  getCapabilities(): ProviderCapabilities {
    return CURSOR_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const log = getLog();
    // Load-bearing: absorb the SDK's detached background rejections before they
    // reach the host crash guard. Installed once, lives for the process.
    installSdkRejectionGuard();

    const sdk = await this.loadSdk();
    if (!sdk) {
      yield errorResult(
        'The Cursor provider requires @cursor/sdk, which could not be loaded. ' +
          'It is fully supported on source / `bun run` installs; in the compiled binary the ' +
          'native sqlite3 dependency of the SDK cannot load.',
        'cursor_sdk_unavailable'
      );
      return;
    }

    const cfg = parseCursorConfig(requestOptions?.assistantConfig ?? {});
    // tier/alias already resolved upstream into requestOptions.model.
    const model = requestOptions?.model ?? cfg.model;
    if (!model) {
      yield errorResult(
        'The Cursor provider requires a model — local Cursor agents have no default. ' +
          'Set `model:` on the node/workflow, a tier, or assistants.cursor.model in config.',
        'cursor_model_required'
      );
      return;
    }

    // Honor Archon's per-user key injection (requestOptions.env) first, then the
    // ambient process env. Passed inline to the SDK — never bound to a named
    // variable, never logged.
    const apiKey = requestOptions?.env?.CURSOR_API_KEY ?? process.env.CURSOR_API_KEY;
    if (!apiKey) {
      yield errorResult(
        'CURSOR_API_KEY is not set. Connect a Cursor API key or set CURSOR_API_KEY in the environment.',
        'cursor_auth_missing'
      );
      return;
    }

    const nodeConfig = requestOptions?.nodeConfig;
    const outputSchema = resolveOutputSchema(requestOptions, nodeConfig);
    const effectivePrompt = outputSchema
      ? augmentPromptForJsonSchema(prompt, outputSchema)
      : prompt;

    // MCP passthrough: node `mcp:` file → Cursor's mcpServers map. Env vars in
    // the config are expanded from the per-request env first, then process env.
    let mcpServers: Record<string, McpServerConfig> | undefined;
    if (nodeConfig?.mcp) {
      try {
        const loaded = await loadMcpConfig(nodeConfig.mcp, cwd, {
          ...process.env,
          ...requestOptions?.env,
        });
        if (loaded.serverNames.length > 0) {
          mcpServers = loaded.servers as Record<string, McpServerConfig>;
        }
        if (loaded.missingVars.length > 0) {
          log.warn(
            { missingVars: [...new Set(loaded.missingVars)] },
            'cursor.mcp_env_vars_missing'
          );
        }
      } catch (err) {
        yield errorResult(
          `Failed to load MCP config: ${err instanceof Error ? err.message : String(err)}`,
          'cursor_mcp_config_error'
        );
        return;
      }
    }

    const sandboxEnabled = Boolean(nodeConfig?.sandbox);
    // Stable, install-wide store root (worktrees are ephemeral; agentIds are
    // globally unique, so one shared JSONL store is safe and survives the
    // worktree). Pure-JS store ⟹ the SDK's native SQLite path is never touched.
    const storeRoot = join(getArchonHome(), 'cursor', 'store');

    const state = makeTranslationState();
    const abortSignal = requestOptions?.abortSignal;

    enterSdkConsoleScope();
    let agent: SDKAgent | undefined;
    let run: Run | undefined;
    let capturedUsage: CursorUsage | undefined;

    log.info(
      {
        model,
        cwd,
        isResume: Boolean(resumeSessionId),
        hasOutputSchema: Boolean(outputSchema),
        mcp: Boolean(mcpServers),
        sandbox: sandboxEnabled,
      },
      'cursor.turn_started'
    );

    try {
      const store = new sdk.JsonlLocalAgentStore(storeRoot);
      const agentOptions = {
        apiKey,
        model: { id: model },
        local: {
          cwd,
          // settingSources MUST include 'project' so the SDK loads the repo's
          // `.cursor/rules` + `AGENTS.md`. 'user' is intentionally excluded —
          // it triggers a cross-tool skill scan that balloons the prompt.
          settingSources: ['project' as const],
          store,
          ...(sandboxEnabled ? { sandboxOptions: { enabled: true } } : {}),
        },
        ...(mcpServers ? { mcpServers } : {}),
      };

      agent = resumeSessionId
        ? await sdk.Agent.resume(resumeSessionId, agentOptions)
        : await sdk.Agent.create(agentOptions);
      const sessionId = agent.agentId;
      state.sessionId = sessionId;

      run = await agent.send(effectivePrompt, {
        onDelta: ({ update }: { update: InteractionUpdate }) => {
          if (update.type === 'turn-ended' && update.usage) capturedUsage = update.usage;
        },
      });

      if (abortSignal) {
        const r = run;
        abortSignal.addEventListener('abort', () => void r.cancel().catch(() => undefined), {
          once: true,
        });
      }

      for await (const msg of run.stream()) {
        if (abortSignal?.aborted) break;
        for (const chunk of translateSdkMessage(msg, state)) yield chunk;
      }

      if (abortSignal?.aborted) {
        for (const chunk of flushText(state)) yield chunk;
        yield {
          type: 'result',
          sessionId,
          isError: true,
          errorSubtype: 'aborted',
          stopReason: 'aborted',
        };
        log.info({ sessionId }, 'cursor.turn_aborted');
        return;
      }

      const result = await run.wait();
      const structuredOutput = outputSchema ? tryParseStructuredOutput(state.fullText) : undefined;
      for (const chunk of finalizeResult(state, {
        result,
        sessionId,
        usage: capturedUsage,
        structuredOutput,
      })) {
        yield chunk;
      }
      log.info(
        {
          sessionId,
          status: result.status,
          tokens: capturedUsage ? mapToken(capturedUsage) : undefined,
        },
        'cursor.turn_completed'
      );
    } catch (err) {
      if (abortSignal?.aborted) {
        yield { type: 'result', isError: true, errorSubtype: 'aborted', stopReason: 'aborted' };
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: redactSecrets(message) }, 'cursor.turn_failed');
      // Flush any buffered text before the error so partial output isn't lost.
      for (const chunk of flushText(state)) yield chunk;
      yield errorResult(message, 'cursor_error');
    } finally {
      try {
        agent?.close();
      } catch {
        // best-effort cleanup
      }
      exitSdkConsoleScope();
    }
  }
}

/** Compact usage for a log line (avoids importing the full mapper into logs). */
function mapToken(u: CursorUsage): { input: number; output: number } {
  return { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0 };
}
