/**
 * Launch helpers for the claude-terminal provider: build the interactive
 * `claude` CLI argv, the `cd … && env … claude …` command string handed to
 * terminalcp, resolve the session transcript path, and detect the folder-trust
 * interstitial.
 *
 * All flags used here are session-level (NOT `--print`-gated) in Claude Code
 * 2.1.166: --session-id, --resume, --model, --mcp-config, --append-system-prompt,
 * --permission-mode / --dangerously-skip-permissions, --allowed-tools /
 * --disallowed-tools, --add-dir.
 */
import { readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Spec for one TUI launch. */
export interface ClaudeLaunchSpec {
  /** The session id this turn operates on. New turn → a fresh uuid pinned via
   *  `--session-id`; resumed turn → the prior id passed via `--resume`. Either
   *  way the transcript is `<sessionId>.jsonl`. */
  sessionId: string;
  /** When true, resume `sessionId` (turn ≥ 2) — `--resume` APPENDS to the same
   *  `<sessionId>.jsonl`. NEVER add --fork-session (it would split the file —
   *  Finding 7). */
  resume?: boolean;
  model?: string;
  /** MCP config file paths (from nodeConfig.mcp). */
  mcpConfigPaths?: string[];
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  addDirs?: string[];
  /** Default true — Archon drives the TUI unattended. When false, permissionMode applies. */
  dangerouslySkipPermissions?: boolean;
  permissionMode?: string;
}

/** Build the `claude` argv for an interactive TUI launch. */
export function buildClaudeArgs(spec: ClaudeLaunchSpec): string[] {
  // New session pins --session-id (so we know the transcript filename); a
  // resumed turn passes --resume (which APPENDS to the same <id>.jsonl).
  const args: string[] = spec.resume
    ? ['--resume', spec.sessionId]
    : ['--session-id', spec.sessionId];

  if (spec.model) args.push('--model', spec.model);

  if (spec.dangerouslySkipPermissions === false) {
    if (spec.permissionMode) args.push('--permission-mode', spec.permissionMode);
  } else {
    args.push('--dangerously-skip-permissions');
  }

  for (const path of spec.mcpConfigPaths ?? []) args.push('--mcp-config', path);
  if (spec.appendSystemPrompt) args.push('--append-system-prompt', spec.appendSystemPrompt);
  if (spec.allowedTools?.length) args.push('--allowed-tools', ...spec.allowedTools);
  if (spec.disallowedTools?.length) args.push('--disallowed-tools', ...spec.disallowedTools);
  for (const dir of spec.addDirs ?? []) args.push('--add-dir', dir);

  return args;
}

/** POSIX single-quote escaping for a value placed in a `bash -c` command string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Env vars stripped from the spawned TUI so it isn't treated as a nested Claude
 *  Code session (which alters behavior / can trip nested-session guards). */
const STRIPPED_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

/**
 * Build the command string handed to `terminalcp start` (run via its `bash -c`):
 * `cd <cwd> && env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT [K=V …] <binary> <args…>`.
 * `envOverrides` carries codebase-scoped env vars (requestOptions.env).
 */
export function buildLaunchCommand(
  binary: string,
  args: string[],
  cwd: string,
  envOverrides?: Record<string, string>
): string {
  const unset = STRIPPED_ENV.map(k => `-u ${k}`).join(' ');
  const sets = Object.entries(envOverrides ?? {})
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(' ');
  const envPrefix = `env ${unset}${sets ? ` ${sets}` : ''}`;
  const quotedArgs = args.map(shellQuote).join(' ');
  return `cd ${shellQuote(cwd)} && ${envPrefix} ${shellQuote(binary)} ${quotedArgs}`;
}

/** Root of Claude Code's per-project session transcripts. */
export function claudeProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * Compute the EXPECTED transcript directory for a cwd. Claude Code dashes the
 * realpath (replacing `/` and `.` with `-`), e.g. `/Users/x/p` → `-Users-x-p`.
 * This is a best-effort hint; `findTranscriptByUuid` is the authoritative
 * resolver because it doesn't depend on reproducing the encoding exactly.
 */
export async function expectedTranscriptDir(cwd: string): Promise<string> {
  let real = cwd;
  try {
    real = await realpath(cwd);
  } catch {
    // cwd not resolvable — fall back to the raw path
  }
  return real.replace(/[/.]/g, '-');
}

/**
 * Locate the transcript for a pinned session id by scanning project dirs for
 * `<uuid>.jsonl`. Robust against the exact dir-encoding (the uuid filename is
 * unique). Returns null until Claude Code creates the file (after the first
 * prompt of a new session).
 */
export async function findTranscriptByUuid(
  sessionId: string,
  root: string = claudeProjectsRoot()
): Promise<string | null> {
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return null;
  }
  const target = `${sessionId}.jsonl`;
  for (const dir of dirs) {
    const candidate = join(root, dir, target);
    try {
      const entries = await readdir(join(root, dir));
      if (entries.includes(target)) return candidate;
    } catch {
      // not a directory / unreadable — skip
    }
  }
  return null;
}

/** True when the screen shows the first-run folder-trust dialog (must be accepted
 *  even with --dangerously-skip-permissions — Finding 5). */
export function isTrustPrompt(screen: string): boolean {
  return /is this a (project|folder) you|trust this folder/i.test(screen);
}
