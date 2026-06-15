/**
 * Cursor SDK Node sidecar.
 *
 * The `@cursor/sdk` tool runtime (Read/Grep/Shell) DEADLOCKS in any git
 * repository when the SDK runs in-process under Bun (Archon's runtime). It works
 * correctly under Node. Since Archon executes every workflow inside a git
 * worktree, the SDK must not run in the Bun parent — this short-lived `node`
 * child runs `Agent.create → send → run.stream()` and forwards raw `SDKMessage`s
 * as JSONL on stdout. The Bun parent (`provider.ts`) reuses the unchanged
 * `translateSdkMessage` / `finalizeResult` to yield Archon `MessageChunk`s.
 * See docs/plans/cursor-node-sidecar.plan.md §5a.
 *
 * Protocol:
 *   stdin  : one JSON line — { prompt, cwd, model, resumeSessionId?, stateRoot,
 *                              settingSources?, mcpServers?, sandbox? }
 *   env    : CURSOR_API_KEY (+ inherited)
 *   stdout : JSONL, one object per line —
 *              { kind:'agent', agentId }
 *              { kind:'msg',   message:<raw SDKMessage> }   // many
 *              { kind:'final', status, result?, usage? }
 *              { kind:'error', message }                    // on throw
 *   stderr : SDK console noise (settings-loader INFO lines) — fenced here so
 *            stdout stays PURE JSONL.
 *
 * This file is plain `.mjs` (no TS build step) and runs under `node`, which
 * resolves `@cursor/sdk` from `packages/providers/node_modules`.
 */

// Keep stdout PURE JSONL: the SDK writes settings-loader INFO lines to
// console.* — redirect every console method to stderr before importing it.
for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
  console[m] = (...a) => process.stderr.write('[sdk] ' + a.map(String).join(' ') + '\n');
}

import { Agent, SqliteLocalAgentStore } from '@cursor/sdk';

/** Emit one JSONL line on stdout. `JSON.stringify` escapes embedded newlines,
 *  so very long tool-result lines remain newline-framed. */
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

let store;
try {
  const cfg = await readStdin();
  // SDK-default SQLite store at a stable stateRoot — concurrency-safe across
  // sidecar processes via `index.db` file-locking (plan §4). `workspaceRef` is
  // the run cwd (worktree); `stateRoot` is the stable Archon root so resume by
  // agentId persists across ephemeral worktrees.
  store = await SqliteLocalAgentStore.open({ workspaceRef: cfg.cwd, stateRoot: cfg.stateRoot });

  const opts = {
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: cfg.model },
    local: {
      cwd: cfg.cwd,
      settingSources: cfg.settingSources ?? ['project'],
      store,
      ...(cfg.sandbox ? { sandboxOptions: { enabled: true } } : {}),
    },
    ...(cfg.mcpServers ? { mcpServers: cfg.mcpServers } : {}),
  };

  const agent = cfg.resumeSessionId
    ? await Agent.resume(cfg.resumeSessionId, opts)
    : await Agent.create(opts);
  emit({ kind: 'agent', agentId: agent.agentId });

  // Usage is delivered ONLY via the onDelta `turn-ended` interaction update —
  // never on run.wait()'s RunResult nor any run.stream() message.
  let usage;
  const run = await agent.send(cfg.prompt, {
    onDelta: ({ update }) => {
      if (update?.type === 'turn-ended' && update.usage) usage = update.usage;
    },
  });

  for await (const msg of run.stream()) emit({ kind: 'msg', message: msg });
  const res = await run.wait();
  emit({ kind: 'final', status: res.status, result: res.result, usage });

  try {
    agent.close();
  } catch {
    // best-effort cleanup
  }
  try {
    await store?.dispose();
  } catch {
    // best-effort cleanup
  }
  process.exit(0);
} catch (err) {
  emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
  try {
    await store?.dispose();
  } catch {
    // best-effort cleanup
  }
  process.exit(1);
}
