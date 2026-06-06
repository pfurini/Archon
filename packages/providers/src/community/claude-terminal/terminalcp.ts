/**
 * Thin client over the terminalcp CLI (https://github.com/badlogic/terminalcp).
 *
 * terminalcp runs a persistent PTY daemon and exposes start/stdin/stdout/stop
 * actions. We drive it OUT-OF-PROCESS as a subprocess (the proven integration
 * from de-risk spikes) so node-pty's native bindings live in terminalcp's
 * daemon, never imported into Archon's Bun process.
 *
 * The terminalcp invocation is configurable (`command`/`commandArgv`) and
 * defaults to running the workspace-installed terminalcp by its resolved entry
 * (via the current JS runtime) so it works from any cwd — using the copy whose
 * node-pty `spawn-helper` the root postinstall made executable (Finding 3).
 * Falls back to `npx` when terminalcp isn't installed.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * Resolve the argv that launches terminalcp.
 *
 * terminalcp is a Node tool: its daemon (xterm.js-headless + node-pty) renders
 * nothing under Bun, so we run it with **node explicitly** — NOT
 * `process.execPath`, which is Bun in dev (empirically: bun → empty screen,
 * node → works). We point node at the workspace-installed entry so it works
 * from any cwd and uses the copy whose node-pty spawn-helper the postinstall
 * made executable. Falls back to `npx` when terminalcp isn't installed (note:
 * the npx-fetched copy may hit the spawn-helper exec-bit bug — Finding 3).
 */
function resolveDefaultCommandArgv(): string[] {
  const node = Bun.which('node') ?? 'node';
  try {
    const req = createRequire(import.meta.url);
    return [node, req.resolve('@mariozechner/terminalcp')];
  } catch {
    return ['npx', '-y', '@mariozechner/terminalcp'];
  }
}

/** Bracketed-paste markers — make the TUI treat multi-line text as one paste,
 *  not a sequence of submits (raw `\n` does NOT submit, but a paste burst is the
 *  robust path — Finding 6). Submit with a separate Enter (`\r`). */
const BRACKET_START = '\x1b[200~';
const BRACKET_END = '\x1b[201~';

/** Wrap text in bracketed-paste markers. */
export function bracketedPaste(text: string): string {
  return `${BRACKET_START}${text}${BRACKET_END}`;
}

/** Injectable exec for tests. Returns the command's stdout/stderr. */
export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = async (file, args) => {
  const { stdout, stderr } = await execFileP(file, args, { maxBuffer: 16 * 1024 * 1024 });
  return { stdout, stderr };
};

export interface TerminalcpClientOptions {
  /** How to invoke terminalcp (space-separated). Overrides the resolved default.
   *  Use `commandArgv` instead for paths containing spaces. */
  command?: string;
  /** Pre-split argv to invoke terminalcp (space-safe; takes precedence over `command`). */
  commandArgv?: string[];
  /** Override the exec function (tests). */
  exec?: ExecFn;
}

/** Minimal terminal-driver surface the provider depends on (injectable for tests). */
export interface TerminalDriver {
  start(name: string, command: string): Promise<string>;
  stdin(name: string, segments: string[]): Promise<void>;
  stdout(name: string, lines?: number): Promise<string>;
  /** Liveness of the named session, tri-state:
   *  - `true`  — listed as running;
   *  - `false` — listed as stopped, or absent from a successful `list` (gone);
   *  - `undefined` — `list` itself couldn't be read (transient), so the caller
   *    must treat it as inconclusive rather than as death. */
  isSessionAlive(name: string): Promise<boolean | undefined>;
  stop(name: string): Promise<void>;
}

export class TerminalcpClient implements TerminalDriver {
  private readonly file: string;
  private readonly baseArgs: string[];
  private readonly exec: ExecFn;

  constructor(opts?: TerminalcpClientOptions) {
    const argv =
      opts?.commandArgv ??
      (opts?.command !== undefined
        ? opts.command.trim().split(/\s+/)
        : resolveDefaultCommandArgv());
    this.file = argv[0];
    this.baseArgs = argv.slice(1);
    this.exec = opts?.exec ?? defaultExec;
  }

  private async run(args: string[]): Promise<string> {
    try {
      const { stdout } = await this.exec(this.file, [...this.baseArgs, ...args]);
      return stdout;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/posix_spawnp failed/i.test(msg)) {
        throw new Error(
          "terminalcp could not spawn a PTY (posix_spawnp failed). node-pty's " +
            'prebuilt spawn-helper is likely not executable. Fix with: ' +
            'chmod +x node_modules/**/node-pty/prebuilds/*/spawn-helper ' +
            '(the @archon/providers postinstall does this automatically).'
        );
      }
      throw new Error(`terminalcp ${args[0] ?? ''} failed: ${msg}`);
    }
  }

  /** Start a PTY session named `name` running `command` (via terminalcp's bash -c).
   *  The caller embeds any `cd <cwd> &&` prefix in `command`. Returns the session id. */
  async start(name: string, command: string): Promise<string> {
    return (await this.run(['start', name, command])).trim();
  }

  /** Send input segments — plain text or terminalcp `::Key` tokens (e.g. '::Enter'). */
  async stdin(name: string, segments: string[]): Promise<void> {
    await this.run(['stdin', name, ...segments]);
  }

  /** Read the rendered screen (optionally the last `lines`). */
  async stdout(name: string, lines?: number): Promise<string> {
    return this.run(lines ? ['stdout', name, String(lines)] : ['stdout', name]);
  }

  /** True while the named session's child process is running. The terminalcp CLI
   *  `list` prints one indented block per session:
   *
   *      <id>
   *        Status: running | stopped
   *        CWD: …
   *        Command: …
   *
   *  We locate the block whose header line equals `name` (session ids are
   *  space/colon-free, so an exact trim-match is unambiguous) and read its
   *  `Status:`. Tri-state (see the interface): running → true, stopped/absent →
   *  false, `list` exec-failure → undefined. The exec-failure case is
   *  deliberately NOT counted as death: the provider only calls this right after
   *  a successful `stdout` on the same daemon, so a failed `list` is a transient
   *  hiccup, not a dead child — counting it would risk false-aborting a live turn. */
  async isSessionAlive(name: string): Promise<boolean | undefined> {
    let out: string;
    try {
      out = await this.run(['list']);
    } catch {
      return undefined; // inconclusive — `list` failed, not a death signal
    }
    const lines = out.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== name) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const match = /^\s*Status:\s*(\S+)/.exec(lines[j]);
        if (match) return match[1] === 'running';
        if (lines[j].trim() === '') break; // end of this session's block
      }
      return false; // header found but no Status line → treat as not alive
    }
    return false; // session not listed
  }

  /** Stop a session. Tolerant — a missing/already-stopped session is not an error. */
  async stop(name: string): Promise<void> {
    try {
      await this.run(['stop', name]);
    } catch {
      // session already gone — cleanup is best-effort
    }
  }
}
