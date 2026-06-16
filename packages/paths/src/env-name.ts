/**
 * Validation for environment-variable NAMES.
 *
 * Env var names flow from untrusted sources (a cloned repo's `.archon/config.yaml`
 * `env:` block, the `PUT /api/codebases/:id/env` body, the DB) into execution
 * surfaces. The claude-terminal provider interpolates them into a `bash -c`
 * command string, so a name containing shell metacharacters (e.g. `X$(touch /tmp/pwn)`)
 * would execute at launch (command injection / RCE — issue #8). We constrain names
 * to POSIX shell identifiers at every boundary so a name can never carry a payload.
 *
 * This is the single source of truth shared by @archon/providers (launch boundary,
 * fail-loud), @archon/server (API schema, reject), and @archon/core (config loader,
 * filter-with-warn).
 */

/** POSIX shell identifier: a letter or underscore, then letters/digits/underscores. */
export const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True when `name` is a valid POSIX env var name (safe to place in a shell `K=V`). */
export function isValidEnvVarName(name: string): boolean {
  return ENV_VAR_NAME_PATTERN.test(name);
}
