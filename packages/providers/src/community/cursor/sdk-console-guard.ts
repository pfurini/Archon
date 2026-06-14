/**
 * Console fence for the in-process `@cursor/sdk`.
 *
 * `@cursor/sdk` runs inside the Archon process and writes INFO/WARN/ERROR lines
 * straight to `console.*` — its settings loaders (`.cursor/rules` / `AGENTS.md`)
 * log on every run, and the SDK exposes no public logger-config API. Those
 * writes land on the shared process stdout/stderr: harmless on the server, but
 * on the CLI path they pollute machine-readable stdout and the structured Pino
 * stream. (Ported from gsd-pi cursor-cli `sdk-console-guard.ts`.)
 *
 * Mechanism (mirrors {@link import('./sdk-runtime').installSdkRejectionGuard}):
 * the five console methods are wrapped ONCE, permanently. Each wrapper consults
 * a depth counter — while a cursor pump is active (`depth > 0`) the call is
 * dropped; otherwise it passes through untouched. A counter, not a boolean,
 * keeps concurrent pumps (parallel DAG nodes) balanced.
 *
 * Dropped, not redirected: the SDK's genuine failures still surface through the
 * run API (`run.wait()` status, thrown errors) and the rejection guard — the
 * console channel is pure noise on top. Set `ARCHON_CURSOR_SDK_CONSOLE=1` to opt
 * out of the fence (e.g. when debugging the SDK itself).
 */
type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';

const GUARDED_METHODS: readonly ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug'];

// `console` retyped so the guarded methods can be reassigned without fighting
// the `(...data: any[])` overloads on the platform console typings.
const consoleRef = console as unknown as Record<ConsoleMethod, (...args: unknown[]) => void>;

let depth = 0;
let installed = false;
const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();

/** True while a cursor pump is active AND the user has not opted out. */
export function isSdkConsoleSuppressed(env: NodeJS.ProcessEnv = process.env): boolean {
  return depth > 0 && !env.ARCHON_CURSOR_SDK_CONSOLE;
}

/** Wrap the console methods exactly once for the process. */
function install(): void {
  if (installed) return;
  installed = true;
  for (const method of GUARDED_METHODS) {
    const original = consoleRef[method].bind(console);
    originals.set(method, original);
    consoleRef[method] = (...args: unknown[]): void => {
      if (isSdkConsoleSuppressed()) return;
      original(...args);
    };
  }
}

/** Enter a cursor console scope: install-once, then depth++. */
export function enterSdkConsoleScope(): void {
  install();
  depth += 1;
}

/**
 * Leave a cursor console scope. Clamped at zero so an unbalanced call can never
 * wedge the guard into permanent suppression.
 */
export function exitSdkConsoleScope(): void {
  depth = Math.max(0, depth - 1);
}

/** @internal Test-only — restore original console methods and reset state. */
export function resetSdkConsoleGuardForTests(): void {
  for (const [method, original] of originals) {
    consoleRef[method] = original;
  }
  originals.clear();
  installed = false;
  depth = 0;
}
