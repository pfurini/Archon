# Patch spec: stop archon-internal env from leaking into target-repo commands

**Status:** proposed · **Date:** 2026-06-15 · **Repo:** archon (this repo)
**Audience:** the agent implementing this patch. Self-contained — anchors at the end.
**Relation to the lexup workaround:** the opsx-wave-harness already works around the symptom with
`env -u DATABASE_URL pnpm test:e2e` in its gate. This patch is the general, root-level fix so no
target workflow has to special-case it. (The harness workaround can stay as belt-and-suspenders or
be removed once this lands.)

---

## 1. Problem (observed)

A workflow gate ran `pnpm test:e2e`. lexup's e2e loads its DB via `dotenv -e .env.e2e --`, and
dotenv-cli does **not** override an already-set shell var. archon's **own** `DATABASE_URL` (archon's
Postgres, loaded from `~/.archon/.env`) was present in the gate command's env and won, so `next start`
(Playwright webServer) connected to the unmigrated archon DB → `relation "verification" does not
exist` → `send-verification-otp` 500 → e2e storageState seeding failed.

Generalized: **archon's internal infra env (e.g. its DB url) leaks into every target-repo command run
by a workflow** and can collide with the target's own configuration. `DATABASE_URL` is the observed
case; any archon-internal var with a name a target project also uses is a latent collision.

## 2. Root cause (precise)

- At boot, `loadArchonEnv(cwd)` (`packages/paths/src/env-loader.ts:63`) loads `~/.archon/.env` then
  `<repo>/.archon/.env` into `process.env` with **`override: true`** — so archon's `DATABASE_URL`
  clobbers any inherited one and sits in `process.env`.
- Every target-command env is built as `{ ...process.env, <workflow vars>, ...(config.envVars) }`,
  spreading archon's full `process.env` (incl. its internal infra vars) into the child:
  - `executeBashNode` — `packages/workflows/src/dag-executor.ts:1680-1682`
  - `executeScriptNode` — `dag-executor.ts:1855-1857`
  - loop `until_bash` — `dag-executor.ts:2563-2564`
- There is already a boot-time guard in the OTHER direction — `stripCwdEnv()`
  (`packages/paths/src/strip-cwd-env.ts:41`) strips the target repo's `<cwd>/.env` from archon so the
  target can't poison archon. **This patch is its mirror:** stop archon's internal env from poisoning
  the target.

## 3. Goal / non-goals

**Goal:** archon-**internal infra** env vars (charter: `DATABASE_URL`) must NOT appear in the env of
target-repo deterministic commands (bash nodes, script nodes, `until_bash`). The target's own env
mechanisms (`.env`, `.env.e2e`, `dotenv -e …`, config.envVars) then populate those names with the
target's values.

**Non-goals / must-not-break:**
- **Managed credentials must still reach target commands.** `post-review-comments` runs `gh pr
  comment` (a bash node) and needs a GitHub token; other gates may need provider/managed creds. Many
  of these also live in `~/.archon/.env`. So a **blanket "strip everything archon-owned"** approach
  is WRONG — it would strip the GH/provider creds those commands depend on. Use a **denylist of
  archon-internal infra vars**, not an allowlist-strip of all archon-owned keys.
- **Provider subprocess env is out of scope** (claude/cursor). Providers legitimately consume
  archon-owned credentials (API keys), so they need a credential-aware strip — different trust model,
  separate patch. This patch covers only the deterministic command surface (bash/script/until_bash).
- **config.envVars / workflow vars still win.** If a workflow/project explicitly sets a var (incl.
  one on the denylist) via `config.envVars`, that explicit value must pass through — the strip applies
  to the inherited BASE only, before the explicit overrides are layered on.

## 4. Design

### 4.1 Define the archon-internal-infra denylist

A single source of truth (e.g. `packages/paths/src/archon-internal-env.ts`) exporting:

```ts
/** Archon-internal infra env vars that must never propagate to target-repo commands.
 *  Credentials/passthrough (GitHub tokens, provider API keys) are deliberately NOT here —
 *  target commands like `gh pr comment` need them. */
export const ARCHON_INTERNAL_ENV_KEYS: ReadonlySet<string> = new Set([
  'DATABASE_URL',     // archon's own DB — the observed collision
  // AUDIT & ADD: other archon-internal infra vars (DB/cache/telemetry/internal config) that a
  // target repo could also use by the same name. EXCLUDE managed credentials and OS essentials.
]);
```

**Task for the implementer:** audit archon's own env surface (the keys archon reads for its DB /
cache / telemetry / internal services — grep `process.env.` in `packages/core`, `packages/server`,
and the setup command's `~/.archon/.env` writers) and add any archon-internal infra var that collides
by-name with typical target-project vars. Keep the list conservative: when unsure whether a var is
"archon-internal infra" vs "managed credential the target needs", leave it OUT (don't strip) — a
missed strip is a latent collision; a wrong strip breaks a working gate.

> Optional hardening (note, don't block on it): have `loadArchonEnv` record the keys it loaded from
> archon env files (`result.parsed`) and expose `getArchonOwnedEnvKeys()`. A var that is BOTH on the
> infra denylist AND archon-owned is definitely safe to strip; this lets a future v2 widen the strip
> precisely. Not required for v1.

### 4.2 A single helper for target-command env

Add (e.g. `packages/workflows/src/executor-shared.ts` or `packages/paths`):

```ts
/** Build the env for a target-repo command: archon's process.env minus archon-internal infra
 *  vars, then explicit overrides (workflow vars + config.envVars) layered on top (they win). */
export function buildTargetCommandEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!ARCHON_INTERNAL_ENV_KEYS.has(k)) base[k] = v;
  }
  return { ...base, ...overrides };
}
```

### 4.3 Apply at the three target-command sites

Replace `{ ...process.env, <vars>, ...(config.envVars ?? {}) }` with
`buildTargetCommandEnv({ <vars>, ...(config.envVars ?? {}) })` at:
- `executeBashNode` — `dag-executor.ts:1680`
- `executeScriptNode` — `dag-executor.ts:1855`
- `until_bash` — `dag-executor.ts:2563`

Ordering preserved: stripped base first, then the same explicit overrides as today (so a var
re-provided via `config.envVars` still wins — §3 non-goal).

## 5. Acceptance criteria

1. A bash/script/until_bash node does NOT see `DATABASE_URL` from `~/.archon/.env` in its child env
   (unless re-provided via `config.envVars` / a workflow var).
2. A target command that loads its own DB url (`dotenv -e .env.e2e --`) gets the TARGET value, not
   archon's — i.e. the observed e2e failure cannot recur even without the harness's `env -u`
   workaround.
3. **Managed credentials still flow:** a bash node still receives the GitHub token used by `gh`
   (`post-review-comments`), provider/managed creds, and OS essentials (PATH/HOME/…).
4. `config.envVars` (and workflow vars) override the strip — an explicitly-set `DATABASE_URL` in
   config passes through.
5. Provider (agent) subprocess env is unchanged by this patch.
6. No regression to `stripCwdEnv` / `loadArchonEnv` boot behavior.

## 6. Tests (`packages/workflows/` + `packages/paths/`)

1. `buildTargetCommandEnv` strips `ARCHON_INTERNAL_ENV_KEYS` from the base but keeps everything else.
2. `buildTargetCommandEnv` lets `overrides` re-introduce a denied key (config.envVars wins).
3. Integration: an `executeBashNode` whose script echoes `$DATABASE_URL` sees it EMPTY when only
   `~/.archon/.env` set it, and sees the override value when `config.envVars.DATABASE_URL` is set.
4. A bash node still sees a managed GitHub token (not on the denylist) in its env.
5. `until_bash` and `executeScriptNode` get the same treatment (parametrized).

## 7. Out of scope

- Provider/agent subprocess env isolation (needs a credential-aware strip — separate patch).
- Changing `loadArchonEnv`'s `override: true` semantics (archon-intent-wins is intentional).
- The harness-side `env -u DATABASE_URL` gate workaround — leave as-is; it's harmless once this lands
  and acts as defense-in-depth. (Optionally remove it in a follow-up after verifying this fix.)

## 8. Anchor index (file:line, archon repo)

| What | Location |
|---|---|
| archon env-file loader (`override: true`, source of the leak) | `packages/paths/src/env-loader.ts:63` (`loadArchonEnv`) |
| Existing mirror guard (target→archon) | `packages/paths/src/strip-cwd-env.ts:41` (`stripCwdEnv`) |
| Bash node env construction | `packages/workflows/src/dag-executor.ts:1680-1682` |
| Script node env construction | `dag-executor.ts:1855-1857` |
| `until_bash` env construction | `dag-executor.ts:2563-2564` |
| Boot order (strip then load) | `packages/cli/src/cli.ts:10-17` |
| Credential catalog (what NOT to strip — managed creds) | `packages/core/src/credentials/catalog.ts` |
