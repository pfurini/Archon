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
import { isAbsolute, join } from 'node:path';
import { isValidEnvVarName } from '@archon/paths';

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
  /** Provider-native effort level (already mapped from the canonical Archon
   *  scale). Emitted as the interactive `--effort <level>` flag. */
  effort?: string;
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
  // `--effort <level>` sets the session's reasoning effort (Claude Code 2.1.166+).
  // Validated by the CLI: an unknown value is warned-and-ignored, never fatal.
  if (spec.effort) args.push('--effort', spec.effort);

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
 *  Code session (which alters behavior / can trip nested-session guards).
 *  CLAUDE_EFFORT is OUTPUT-ONLY: Claude Code exports it (from its resolved
 *  `effortLevel`) to hook commands, the Bash tool, and `${CLAUDE_EFFORT}` prompt
 *  substitution — it is NOT read back as an effort input (verified against the
 *  2.1.177 binary). We strip the inherited value purely as hygiene, so an outer
 *  session's stale CLAUDE_EFFORT can't leak into the worker's hook/`${CLAUDE_EFFORT}`
 *  substitution before Claude Code re-exports its own. The worker's reasoning
 *  effort is governed by the `--effort` flag (see buildClaudeArgs), not by env. */
const STRIPPED_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_EFFORT'];

/** Env vars FORCED onto the spawned TUI (rendered before `envOverrides`, so an
 *  explicit override can still opt back in).
 *  CLAUDE_CODE_DISABLE_ADVISOR_TOOL: the advisor is an interactive-harness
 *  feature — at its checkpoints it forwards the whole conversation to a
 *  reviewer model out-of-band, rendering only on the screen and writing
 *  NOTHING to the transcript, for minutes at a time. In an unattended worker
 *  that is pure turn-budget burn (observed: two implement-node timeouts at
 *  exactly the advisor checkpoints), and a workflow's own review nodes cover
 *  the same ground. */
const FORCED_ENV: Record<string, string> = { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' };

/**
 * Build the command string handed to `terminalcp start` (run via its `bash -c`):
 * `cd <cwd> && env -u <STRIPPED_ENV…> <FORCED_ENV…> [K=V …] <binary> <args…>`.
 * `envOverrides` carries codebase-scoped env vars (requestOptions.env) and is
 * rendered after FORCED_ENV, so a same-key override wins.
 */
export function buildLaunchCommand(
  binary: string,
  args: string[],
  cwd: string,
  envOverrides?: Record<string, string>
): string {
  const unset = STRIPPED_ENV.map(k => `-u ${k}`).join(' ');
  const sets = Object.entries({ ...FORCED_ENV, ...envOverrides })
    .map(([k, v]) => {
      // The key is interpolated raw into a `bash -c` string; a name with shell
      // metacharacters (e.g. `X$(touch /tmp/pwn)`) would execute at launch.
      // Fail loud before spawning — env names must be POSIX shell identifiers
      // (issue #8). Values are made safe by shellQuote.
      if (!isValidEnvVarName(k)) {
        throw new Error(
          `Invalid environment variable name: ${JSON.stringify(k)}. ` +
            'Names must match /^[A-Za-z_][A-Za-z0-9_]*$/ (POSIX shell identifier).'
        );
      }
      return `${k}=${shellQuote(v)}`;
    })
    .join(' ');
  const envPrefix = `env ${unset}${sets ? ` ${sets}` : ''}`;
  const quotedArgs = args.map(shellQuote).join(' ');
  return `cd ${shellQuote(cwd)} && ${envPrefix} ${shellQuote(binary)} ${quotedArgs}`;
}

/** Default Claude Code config dir when `CLAUDE_CONFIG_DIR` is unset. */
function defaultClaudeConfigDir(): string {
  return join(homedir(), '.claude');
}

/**
 * Resolve an explicit `CLAUDE_CONFIG_DIR` value to an absolute, NFC-normalized
 * path. Expands a leading `~`/`~/…` and resolves a relative path against the
 * home dir, so the value we INJECT into the spawned CLI's env and the value we
 * READ transcripts from are byte-identical. Two reasons this normalization is
 * load-bearing: (1) the env assignment is single-quoted in the `bash -c`
 * launch string, so the shell can't expand a `~` for us; (2) Claude Code itself
 * NFC-normalizes the config dir (`(process.env.CLAUDE_CONFIG_DIR ??
 * ~/.claude).normalize("NFC")`, verified against the 2.1.179 binary), so an
 * un-normalized root could fail to match the dir the CLI actually writes to.
 */
export function resolveClaudeConfigDir(value: string): string {
  let p = value.trim();
  if (p === '~') p = homedir();
  else if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
  if (!isAbsolute(p)) p = join(homedir(), p);
  return p.normalize('NFC');
}

/**
 * Root of Claude Code's per-project session transcripts. With an explicit
 * `configDir` (a resolved `CLAUDE_CONFIG_DIR`), transcripts live at
 * `<configDir>/projects`; otherwise the default `~/.claude/projects`.
 */
export function claudeProjectsRoot(configDir?: string): string {
  return join(configDir ?? defaultClaudeConfigDir(), 'projects');
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
