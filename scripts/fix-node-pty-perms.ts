#!/usr/bin/env bun
/**
 * Make node-pty's prebuilt `spawn-helper` executable.
 *
 * node-pty ships the macOS/Linux `spawn-helper` binary inside its `prebuilds/`,
 * but the published tarball records it as mode 0644 — so after install it lacks
 * the execute bit and `posix_spawnp` fails the moment terminalcp (used by the
 * `claude-terminal` community provider) tries to allocate a PTY. We restore +x.
 *
 * Runs as the root `postinstall` (sub-package postinstalls don't fire on a
 * workspace `bun install`, and node-pty hoists to the root node_modules).
 * No-op on Windows (conpty, no spawn-helper) and when terminalcp/node-pty isn't
 * installed (it's an optionalDependency). Best-effort: never fails the install.
 */
import { chmodSync } from 'node:fs';
import { Glob } from 'bun';

if (process.platform !== 'win32') {
  const glob = new Glob('**/node-pty/prebuilds/*/spawn-helper');
  let fixed = 0;
  // dot: true so the scan descends into Bun's isolated `.bun/` store, where the
  // hoisted node-pty actually lives (node_modules/.bun/node-pty@x/node_modules/…).
  for (const file of glob.scanSync({
    cwd: 'node_modules',
    absolute: true,
    onlyFiles: true,
    dot: true,
  })) {
    try {
      chmodSync(file, 0o755);
      fixed++;
    } catch {
      // best-effort — ignore unreadable/locked files
    }
  }
  if (fixed > 0) {
    console.log(`fix-node-pty-perms: chmod +x on ${fixed} spawn-helper binary(ies)`);
  }
}
