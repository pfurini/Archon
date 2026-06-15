/**
 * cursor provider — drives the beta `@cursor/sdk` through a short-lived Node
 * sidecar (`cursor-runner.mjs`) and streams Archon `MessageChunk`s.
 *
 * ## Why a Node sidecar
 * The `@cursor/sdk` tool runtime (Read/Grep/Shell) DEADLOCKS in any git
 * repository when the SDK runs in-process under Bun (Archon's runtime); it works
 * correctly under Node. Since Archon executes every workflow inside a git
 * worktree, the SDK must not run in the Bun parent. Instead the parent spawns
 * `node cursor-runner.mjs`, passes the request via stdin + env, and the child
 * runs `Agent.create → send → run.stream()` forwarding raw `SDKMessage`s as
 * JSONL on stdout. The parent reuses the UNCHANGED `translateSdkMessage` /
 * `finalizeResult` to yield chunks. See docs/plans/cursor-node-sidecar.plan.md.
 *
 * Because the SDK never loads in the Bun process: the native-sqlite3
 * `bun build --compile` crash is sidestepped in the parent, and the SDK's
 * detached background rejections die with the child (no parent crash-guard or
 * console fence needed — both moved into the runner).
 *
 * Per-turn flow:
 *   1. resolve apiKey + model (both required — fail fast); resolve `node` (fail
 *      fast with `cursor_node_unavailable` if absent)
 *   2. build the effective prompt (shell `workingDirectory` directive + optional
 *      structured-output augmentation), resolve MCP + sandbox + stateRoot
 *   3. spawn the Node sidecar; pump its JSONL stdout:
 *        agent → state.sessionId; msg → translateSdkMessage; final →
 *        finalizeResult; error → isError result
 *   4. on abort: kill the child, yield a single aborted result
 *   5. no terminal `final` (child threw / died) → isError result (stderr tail)
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
import { type CursorCatalog, loadCursorCatalog } from './catalog';
import { CursorConfigError, DEFAULT_CURSOR_MODEL, parseCursorConfig } from './config';
import {
  CursorModelParamsError,
  type CursorKnobs,
  type CursorThinkingInput,
  isCursorParamRejection,
  resolveCursorParams,
} from './model-params';
import { redactSecrets } from './redact';
import type {
  CursorUsage,
  McpServerConfig,
  ModelParameterValue,
  RunResult,
  SDKMessage,
} from './sdk-types';
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

/** The JSON config written to the sidecar's stdin (see `cursor-runner.mjs`). */
export interface CursorRunnerConfig {
  prompt: string;
  cwd: string;
  model: string;
  resumeSessionId?: string;
  /** Stable Archon root for the SQLite store (survives ephemeral worktrees). */
  stateRoot: string;
  settingSources: string[];
  mcpServers?: Record<string, McpServerConfig>;
  sandbox?: boolean;
  /**
   * Per-model Cursor `ModelSelection.params` (effort/thinking/context/fast).
   * Minimal — only the knobs in play (plan §3). Omitted when no knob applies, so
   * the runner sends `model: { id }` (byte-for-byte the pre-feature shape).
   */
  modelParams?: ModelParameterValue[];
}

/** One JSONL line emitted by the sidecar on stdout. */
type RunnerLine =
  | { kind: 'agent'; agentId: string }
  | { kind: 'msg'; message: SDKMessage }
  | { kind: 'final'; status: RunResult['status']; result?: string; usage?: CursorUsage }
  | { kind: 'error'; message: string };

/** A live sidecar process: its parsed stdout lines, a killer, and its exit. */
export interface CursorRunnerHandle {
  /** Parsed JSONL lines from stdout (one string per line, newline-stripped). */
  lines: AsyncIterable<string>;
  /** Kill the child (abort / cleanup). Best-effort, idempotent. */
  kill: () => void;
  /** Resolves when the child exits, with its code + a bounded stderr tail. */
  exited: Promise<{ exitCode: number; stderrTail: string }>;
}

/** Max bytes of child stderr retained for the error-surface tail. */
const STDERR_TAIL_MAX = 4096;

/**
 * Spawn the Node sidecar and drive its stdio. Default {@link CursorProviderDeps.spawnRunner}.
 *
 * Load-bearing concurrency: stdin is written + closed (the child blocks on
 * stdin until EOF), and stderr is drained on a BACKGROUND task started before
 * the caller awaits stdout — a child that fills the stderr pipe buffer would
 * otherwise block on write while the parent blocks reading stdout (the same
 * deadlock class this whole change fixes).
 */
function defaultSpawnRunner(
  nodePath: string,
  cfg: CursorRunnerConfig,
  env: Record<string, string | undefined>
): CursorRunnerHandle {
  const runnerPath = join(import.meta.dir, 'cursor-runner.mjs');
  const proc = Bun.spawn([nodePath, runnerPath], {
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Write the config to stdin and close it. Await the write so a large cfg
  // (big mcpServers / prompt) isn't truncated before the child reads it.
  const writeConfig = (async (): Promise<void> => {
    proc.stdin.write(JSON.stringify(cfg));
    await proc.stdin.end();
  })().catch(() => undefined);

  let stderrTail = '';
  const drainStderr = (async (): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      // Redact before forwarding AND before tailing: the child's stderr carries
      // raw @cursor/sdk console/error output, which can contain bearer tokens.
      // Best-effort per-chunk (the SDK writes whole lines, so split secrets are
      // unlikely); the surfaced tail is redacted again at the result boundary.
      const text = redactSecrets(decoder.decode(chunk, { stream: true }));
      process.stderr.write(text); // forward SDK noise for observability
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_MAX);
    }
  })().catch(() => undefined);

  async function* readLines(): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length > 0) yield line;
      }
    }
    buf += decoder.decode();
    // A final/error line can arrive without a trailing newline before exit.
    if (buf.trim().length > 0) yield buf;
  }

  return {
    lines: readLines(),
    kill: (): void => {
      try {
        proc.kill();
      } catch {
        // already exited
      }
    },
    exited: (async (): Promise<{ exitCode: number; stderrTail: string }> => {
      const exitCode = await proc.exited;
      await writeConfig;
      await drainStderr;
      return { exitCode, stderrTail };
    })(),
  };
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

/**
 * Cost-default fail-CLOSED gate, shared by the initial spawn AND the
 * post-refresh retry. When the model can't be verified against the catalog the
 * implicit `fast=false` (standard-tier) default can't be applied, so proceeding
 * param-less makes the server bill at the premium (fast) tier. Block unless the
 * user opted into premium-on-degraded.
 *
 * BOTH the first resolve and the retry-after-catalog-refresh MUST run this — a
 * refresh that drops the model from the catalog would otherwise retry param-less
 * and silently bill premium, bypassing the gate (Cursor Bugbot finding).
 */
function evaluateCostDefaultGate(
  modelFound: boolean,
  allowPremiumOnDegraded: boolean | undefined,
  model: string,
  log: ReturnType<typeof createLogger>
): { blocked: true; message: string } | { blocked: false; degradedWarning?: string } {
  if (modelFound) return { blocked: false };
  if (!allowPremiumOnDegraded) {
    log.warn({ model }, 'cursor.cost_default_unavailable');
    return {
      blocked: true,
      message: `Cannot apply the standard-tier (fast=false) default for '${model}': the Cursor model catalog is unavailable (or does not list this model), so the run would bill at the premium (fast) tier. Restore catalog access, or set assistants.cursor.allowPremiumOnDegraded: true to proceed at premium tier.`,
    };
  }
  return {
    blocked: false,
    degradedWarning:
      'Cursor model catalog unavailable — proceeding without the standard-tier (fast=false) default. This run may bill at the premium (fast) tier.',
  };
}

/** Load the Cursor model catalog. Default: {@link loadCursorCatalog}. */
export type CursorCatalogLoader = (opts: {
  stateRoot: string;
  apiKey: string;
  nodePath: string;
}) => Promise<CursorCatalog>;

/** Injectable seams for testing the pump without a real `node` / `@cursor/sdk`. */
export interface CursorProviderDeps {
  /** Resolve the `node` binary path (null → fail fast). Default: `Bun.which('node')`. */
  resolveNodePath?: () => string | null;
  /** Spawn the sidecar. Default: {@link defaultSpawnRunner} (real `Bun.spawn`). */
  spawnRunner?: (
    nodePath: string,
    cfg: CursorRunnerConfig,
    env: Record<string, string | undefined>
  ) => CursorRunnerHandle;
  /** Load the model catalog. Default: {@link loadCursorCatalog} (spawns node helper). */
  loadCatalog?: CursorCatalogLoader;
}

export class CursorProvider implements IAgentProvider {
  private readonly resolveNodePath: () => string | null;
  private readonly spawnRunner: (
    nodePath: string,
    cfg: CursorRunnerConfig,
    env: Record<string, string | undefined>
  ) => CursorRunnerHandle;
  private readonly loadCatalog: CursorCatalogLoader;

  constructor(deps: CursorProviderDeps = {}) {
    this.resolveNodePath = deps.resolveNodePath ?? ((): string | null => Bun.which('node'));
    this.spawnRunner = deps.spawnRunner ?? defaultSpawnRunner;
    this.loadCatalog =
      deps.loadCatalog ??
      (({ stateRoot, apiKey, nodePath }): Promise<CursorCatalog> =>
        loadCursorCatalog({ stateRoot, apiKey, nodePath }));
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

    let cfg;
    try {
      cfg = parseCursorConfig(requestOptions?.assistantConfig ?? {});
    } catch (err) {
      // A present-but-invalid assistants.cursor.* value (e.g. `fast: "yes"`) is
      // surfaced, never silently dropped — a silent drop could invert the cost
      // default. Fail-loud (plan §3).
      if (err instanceof CursorConfigError) {
        yield errorResult(err.message, 'cursor_config_invalid');
        return;
      }
      throw err;
    }
    // tier/alias already resolved upstream into requestOptions.model; fall back
    // to the config default, then the built-in default (local Cursor agents
    // require a concrete model).
    const model = requestOptions?.model ?? cfg.model ?? DEFAULT_CURSOR_MODEL;

    // Honor Archon's per-user key injection (requestOptions.env) first, then the
    // ambient process env. Passed to the child via env — never logged.
    const apiKey = requestOptions?.env?.CURSOR_API_KEY ?? process.env.CURSOR_API_KEY;
    if (!apiKey) {
      yield errorResult(
        'CURSOR_API_KEY is not set. Connect a Cursor API key or set CURSOR_API_KEY in the environment.',
        'cursor_auth_missing'
      );
      return;
    }

    // The SDK runs in a Node subprocess (it deadlocks under Bun in git repos);
    // `node` must be on PATH. Fail fast with a clear, actionable error.
    const nodePath = this.resolveNodePath();
    if (!nodePath) {
      yield errorResult(
        'The Cursor provider runs the SDK in a Node subprocess; `node` was not found on PATH. ' +
          'Install Node, or run Archon from a source / `bun run` install.',
        'cursor_node_unavailable'
      );
      return;
    }

    const nodeConfig = requestOptions?.nodeConfig;
    const outputSchema = resolveOutputSchema(requestOptions, nodeConfig);
    const basePrompt = outputSchema ? augmentPromptForJsonSchema(prompt, outputSchema) : prompt;
    // Workaround for an upstream @cursor/sdk (1.0.18) bug: the built-in Shell
    // tool returns EMPTY output / no exit code when a tool call omits
    // `workingDirectory` — it does NOT fall back to the agent's cwd the way
    // Read/Grep do. The model then retries forever and reports "Shell failed".
    // Prepending this directive makes the model set `workingDirectory` reliably.
    // (Prepended, not appended, so it never displaces the structured-output
    // "final message = JSON" instruction.) Runtime-agnostic prompt building, so
    // it stays in the parent and travels to the child in cfg.prompt.
    const shellDirective =
      `When using the Shell tool, ALWAYS set its \`workingDirectory\` argument to "${cwd}". ` +
      'The Cursor Shell tool returns no output when it is omitted.';
    const effectivePrompt = `${shellDirective}\n\n${basePrompt}`;

    // MCP passthrough: node `mcp:` file → Cursor's mcpServers map. Env vars in
    // the config are expanded from the per-request env first, then process env.
    // Resolved in the parent; forwarded to the child in cfg.mcpServers.
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
    // globally unique). The SDK-default SQLite store at this root is
    // concurrency-safe across parallel sidecar processes via `index.db`
    // file-locking — resume routes by agentId through it, not via the cwd.
    const stateRoot = join(getArchonHome(), 'cursor', 'store');

    // ── Per-model parameters (effort / thinking / context / fast) ──────────────
    // Knob provenance = PRESENCE in its source. effort/thinking are explicit iff
    // present in nodeConfig (the executor flattens node/workflow values there).
    // fast/context are explicit iff the key is present in config; `fast` defaults
    // to the IMPLICIT cost default `false` (standard tier, ~6× cheaper) — Cursor's
    // own server default is `fast=true` (premium), so we set it explicitly.
    const knobs: CursorKnobs = {};
    if (nodeConfig?.effort !== undefined)
      knobs.effort = { value: nodeConfig.effort, explicit: true };
    if (nodeConfig?.thinking !== undefined)
      knobs.thinking = { value: nodeConfig.thinking as CursorThinkingInput, explicit: true };
    if (typeof cfg.context === 'string') knobs.context = { value: cfg.context, explicit: true };
    // parseCursorConfig only ever sets `fast` to a boolean (or throws), so a
    // boolean value IS the presence/explicit signal; absent ⇒ the implicit default.
    // `policy: true` marks `fast` as a blanket cost-tier default: on a model with
    // no `fast` param it is omitted (single tier, no ambiguity) rather than
    // failing loud — see resolveCursorParams' policy-exemption note.
    knobs.fast =
      typeof cfg.fast === 'boolean'
        ? { value: cfg.fast, explicit: true, policy: true }
        : { value: false, explicit: false, policy: true };

    // Load the durable model catalog (zero blocking network when a snapshot
    // exists) and translate the knobs into a MINIMAL, validated param list.
    const catalog = await this.loadCatalog({
      stateRoot: join(getArchonHome(), 'cursor'),
      apiKey,
      nodePath,
    });

    let modelParams: ModelParameterValue[];
    try {
      const resolved = resolveCursorParams(catalog.models, model, knobs);
      const gate = evaluateCostDefaultGate(
        resolved.modelFound,
        cfg.allowPremiumOnDegraded,
        model,
        log
      );
      if (gate.blocked) {
        yield errorResult(gate.message, 'cursor_model_params_unavailable');
        return;
      }
      if (gate.degradedWarning) yield { type: 'system', content: gate.degradedWarning };
      modelParams = resolved.params;
    } catch (err) {
      // An EXPLICIT knob the resolved model can't express → fail-loud, sidecar
      // NOT spawned (plan §3 / finding 1).
      if (err instanceof CursorModelParamsError) {
        log.warn({ model, err: err.message }, 'cursor.model_params_unavailable');
        yield errorResult(err.message, 'cursor_model_params_unavailable');
        return;
      }
      throw err;
    }

    let runnerCfg: CursorRunnerConfig = {
      prompt: effectivePrompt,
      cwd,
      model,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      stateRoot,
      // settingSources MUST include 'project' so the SDK loads the repo's
      // `.cursor/rules` + `AGENTS.md`. 'user' is intentionally excluded — it
      // triggers a cross-tool skill scan that balloons the prompt.
      settingSources: ['project'],
      ...(mcpServers ? { mcpServers } : {}),
      ...(sandboxEnabled ? { sandbox: true } : {}),
      ...(modelParams.length > 0 ? { modelParams } : {}),
    };
    // CURSOR_API_KEY passed inline to the child env — never bound to a logged var.
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...requestOptions?.env,
      CURSOR_API_KEY: apiKey,
    };

    const abortSignal = requestOptions?.abortSignal;

    log.info(
      {
        model,
        cwd,
        isResume: Boolean(resumeSessionId),
        hasOutputSchema: Boolean(outputSchema),
        mcp: Boolean(mcpServers),
        sandbox: sandboxEnabled,
        modelParams: runnerCfg.modelParams,
      },
      'cursor.turn_started'
    );

    // Run the sidecar. A create-time PARAM rejection from a (possibly stale) disk
    // snapshot triggers a single invalidate + refresh + retry before failing
    // (plan §4 / finding 5). Any other error is yielded as-is.
    for (let attempt = 0; ; attempt++) {
      const allowParamRejectionRetry =
        attempt === 0 && catalog.servedFromDisk && (runnerCfg.modelParams?.length ?? 0) > 0;
      try {
        yield* this.pumpRunner(nodePath, runnerCfg, env, {
          abortSignal,
          outputSchema,
          log,
          allowParamRejectionRetry,
        });
        return;
      } catch (err) {
        if (!(err instanceof ParamRejectionRetrySignal) || attempt > 0) throw err;
        log.warn({ model, detail: redactSecrets(err.detail) }, 'cursor.param_rejection_retry');
        try {
          await catalog.forceRefresh();
        } catch {
          yield errorResult(
            `Cursor rejected a model parameter and refreshing the model catalog failed: ${err.detail}`,
            'cursor_model_params_unavailable'
          );
          return;
        }
        try {
          const refreshed = resolveCursorParams(catalog.models, model, knobs);
          // Reapply the SAME fail-closed cost gate as the first spawn: a refresh
          // that dropped the model from the catalog must not retry param-less and
          // bill premium just because the explicit-knob check (catch) didn't fire.
          const gate = evaluateCostDefaultGate(
            refreshed.modelFound,
            cfg.allowPremiumOnDegraded,
            model,
            log
          );
          if (gate.blocked) {
            yield errorResult(gate.message, 'cursor_model_params_unavailable');
            return;
          }
          if (gate.degradedWarning) yield { type: 'system', content: gate.degradedWarning };
          runnerCfg = { ...runnerCfg, modelParams: refreshed.params };
        } catch (reErr) {
          if (reErr instanceof CursorModelParamsError) {
            yield errorResult(reErr.message, 'cursor_model_params_unavailable');
            return;
          }
          throw reErr;
        }
        // loop: retry once with the refreshed params
      }
    }
  }

  /**
   * Spawn the sidecar and pump one attempt's JSONL stdout into Archon chunks.
   *
   * When `allowParamRejectionRetry` is set, a CREATE-TIME error (one that arrives
   * before any `agent`/content chunk) whose message looks like a parameter
   * rejection is NOT yielded — instead a {@link ParamRejectionRetrySignal} is
   * thrown so `sendQuery` can refresh the catalog and retry once. On the retry
   * pass the flag is false, so any error surfaces normally.
   */
  private async *pumpRunner(
    nodePath: string,
    runnerCfg: CursorRunnerConfig,
    env: Record<string, string | undefined>,
    opts: {
      abortSignal?: AbortSignal;
      outputSchema?: Record<string, unknown>;
      log: ReturnType<typeof createLogger>;
      allowParamRejectionRetry: boolean;
    }
  ): AsyncGenerator<MessageChunk> {
    const { abortSignal, outputSchema, log } = opts;
    const state = makeTranslationState();

    let handle: CursorRunnerHandle;
    try {
      handle = this.spawnRunner(nodePath, runnerCfg, env);
    } catch (err) {
      // Bun.spawn can throw synchronously (e.g. the resolved node path is not
      // executable). Surface it as a clean, redacted result rather than letting
      // it escape the generator.
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: redactSecrets(message) }, 'cursor.turn_failed');
      yield errorResult(`Failed to start the Cursor sidecar: ${message}`, 'cursor_error');
      return;
    }
    const onAbort = (): void => {
      handle.kill();
    };
    if (abortSignal) {
      if (abortSignal.aborted) handle.kill();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    let sawFinal = false;
    let sawAgent = false;
    let yieldedContent = false;
    let capturedUsage: CursorUsage | undefined;
    let errorMessage: string | undefined;
    // An error-status `final` is finalized AFTER the loop, once `handle.exited`
    // has resolved the sidecar's stderr tail — the SDK's RunResult carries no
    // detail on error, so the tail is the only diagnostic. A `finished` final is
    // finalized inline (no stderr needed) so success has zero added latency.
    let errorFinal: { result: RunResult; structuredOutput: unknown } | undefined;

    try {
      for await (const line of handle.lines) {
        if (abortSignal?.aborted) break;
        let parsed: RunnerLine;
        try {
          parsed = JSON.parse(line) as RunnerLine;
        } catch {
          continue; // skip any non-JSON noise that slipped onto stdout
        }
        switch (parsed.kind) {
          case 'agent':
            sawAgent = true;
            state.sessionId = parsed.agentId;
            break;
          case 'msg':
            for (const chunk of translateSdkMessage(parsed.message, state)) {
              yieldedContent = true;
              yield chunk;
            }
            break;
          case 'final': {
            sawFinal = true;
            capturedUsage = parsed.usage;
            const structuredOutput = outputSchema
              ? tryParseStructuredOutput(state.fullText)
              : undefined;
            const result: RunResult = {
              id: 'cursor-run',
              status: parsed.status,
              ...(parsed.result !== undefined ? { result: parsed.result } : {}),
            };
            if (parsed.status === 'finished') {
              for (const chunk of finalizeResult(state, {
                result,
                sessionId: state.sessionId ?? '',
                usage: capturedUsage,
                structuredOutput,
              })) {
                yield chunk;
              }
            } else {
              // Defer: finalize with the stderr tail once `handle.exited` resolves.
              errorFinal = { result, structuredOutput };
            }
            break;
          }
          case 'error':
            errorMessage = parsed.message;
            break;
        }
      }

      const { exitCode, stderrTail } = await handle.exited;

      // Error-status `final`: finalize now, threading the captured stderr tail so
      // the SDK's own reason surfaces instead of a bare `run error`.
      if (errorFinal) {
        for (const chunk of finalizeResult(state, {
          result: errorFinal.result,
          sessionId: state.sessionId ?? '',
          usage: capturedUsage,
          structuredOutput: errorFinal.structuredOutput,
          stderrTail,
        })) {
          yield chunk;
        }
        log.error(
          { sessionId: state.sessionId, status: errorFinal.result.status, exitCode },
          'cursor.turn_failed'
        );
        return;
      }

      // A terminal `final` is the authoritative end of the turn: if it was
      // emitted, the run completed before/around the abort, so don't also emit an
      // aborted result (that would yield two terminal `result` chunks).
      if (sawFinal) {
        log.info(
          {
            sessionId: state.sessionId,
            tokens: capturedUsage ? mapToken(capturedUsage) : undefined,
          },
          'cursor.turn_completed'
        );
        return;
      }

      if (abortSignal?.aborted) {
        for (const chunk of flushText(state)) yield chunk;
        yield {
          type: 'result',
          ...(state.sessionId ? { sessionId: state.sessionId } : {}),
          isError: true,
          errorSubtype: 'aborted',
          stopReason: 'aborted',
        };
        log.info({ sessionId: state.sessionId }, 'cursor.turn_aborted');
        return;
      }

      // No terminal `final` line — the sidecar threw (`kind:error`) or died.
      const detail =
        errorMessage ??
        (stderrTail.trim() || `Cursor sidecar exited with code ${exitCode} before completing`);

      // A create-time param rejection (error before any agent/content) from a
      // stale catalog is recoverable: signal the caller to refresh + retry once
      // rather than yielding the error. Nothing user-visible has been emitted yet.
      if (
        opts.allowParamRejectionRetry &&
        !sawAgent &&
        !yieldedContent &&
        isCursorParamRejection(detail)
      ) {
        throw new ParamRejectionRetrySignal(detail);
      }

      // Flush any buffered text before the error so partial output isn't lost.
      for (const chunk of flushText(state)) yield chunk;
      log.error({ err: redactSecrets(detail), exitCode }, 'cursor.turn_failed');
      yield errorResult(detail, 'cursor_error');
    } finally {
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      handle.kill(); // best-effort: ensure the child is dead
    }
  }
}

/**
 * Internal control-flow signal: a recoverable create-time parameter rejection
 * from a stale catalog. Caught by `sendQuery` to drive the refresh + retry-once
 * path; never escapes the provider.
 */
class ParamRejectionRetrySignal extends Error {
  constructor(public readonly detail: string) {
    super('cursor: recoverable model-parameter rejection');
    this.name = 'ParamRejectionRetrySignal';
  }
}

/** Compact usage for a log line (avoids importing the full mapper into logs). */
function mapToken(u: CursorUsage): { input: number; output: number } {
  return { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0 };
}
