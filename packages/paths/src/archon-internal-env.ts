/**
 * Archon-internal-infra env denylist — the mirror of stripCwdEnv().
 *
 * stripCwdEnv() stops the TARGET repo's env from poisoning Archon. This module
 * stops Archon's OWN internal-infra env from poisoning target-repo deterministic
 * commands (bash / script / loop `until_bash` nodes).
 *
 * Background (#: gate-env-isolation): `loadArchonEnv` loads `~/.archon/.env`
 * with `override: true`, so Archon's `DATABASE_URL` (its own Postgres) lands in
 * `process.env`. Every deterministic-command env was built as
 * `{ ...process.env, ...overrides }`, spreading that internal DB url into the
 * child. A gate running `pnpm test:e2e` whose own loader (`dotenv -e .env.e2e`)
 * does NOT override an already-set var then connected to Archon's unmigrated DB.
 *
 * Design (deliberately conservative):
 *   - This is a DENYLIST of archon-internal *infra* vars, NOT an allowlist-strip
 *     of everything archon-owned. Target commands like `gh pr comment`
 *     (post-review-comments) legitimately need managed credentials (GH tokens,
 *     provider API keys) that also live in `~/.archon/.env`. Stripping those
 *     would break working gates.
 *   - A wrong strip breaks a working gate; a missed strip is only a latent
 *     collision. So when unsure whether a var is "archon-internal infra" vs "a
 *     managed credential the target needs", it is left OUT.
 *
 * Audit (charter: `DATABASE_URL`). The full archon env surface was reviewed
 * (`process.env.*` in core/server/paths, `.env.example`, the credential
 * catalog). `DATABASE_URL` is the only var that clears the bar:
 * archon-internal-infra AND collides by-name with typical target projects AND
 * not-unsure. Notable rejected candidates and why:
 *   - GH_TOKEN / GITHUB_TOKEN / *_TOKEN / provider API keys / AWS_* — managed
 *     credentials the target commands need (`gh`, provider CLIs). Never strip.
 *   - PORT / HOST — archon reads them but defaults internally and does NOT
 *     export them; they sit in `process.env` mainly when the user set them in
 *     their shell, where stripping a legitimately-inherited value is a "wrong
 *     strip" with no observed collision to justify it.
 *   - LOG_LEVEL / NODE_ENV — too essential/ambiguous to strip unconditionally.
 *   - POSTHOG_* / TOKEN_ENCRYPTION_KEY / WEB_UI_* / WORKTREE_BASE etc. — archon
 *     config with low by-name collision risk; left out to stay conservative.
 *
 * A future v2 could widen the strip precisely by gating on the keys
 * `loadArchonEnv` actually loaded (`result.parsed`) so only archon-OWNED values
 * are stripped — not required here.
 */
export const ARCHON_INTERNAL_ENV_KEYS: ReadonlySet<string> = new Set([
  'DATABASE_URL', // archon's own DB url — the observed collision
]);

/**
 * Build the env for a target-repo deterministic command: archon's `process.env`
 * minus archon-internal infra vars, with explicit overrides (workflow vars +
 * `config.envVars`) layered on top so they still win — a var re-provided via
 * `config.envVars` (incl. one on the denylist) passes through unchanged.
 */
export function buildTargetCommandEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!ARCHON_INTERNAL_ENV_KEYS.has(key)) base[key] = value;
  }
  return { ...base, ...overrides };
}
