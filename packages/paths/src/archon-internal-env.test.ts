import { describe, it, expect, afterEach } from 'bun:test';
import { ARCHON_INTERNAL_ENV_KEYS, buildTargetCommandEnv } from './archon-internal-env';

describe('archon-internal-env denylist', () => {
  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.TEST_TARGET_KEEP;
    delete process.env.GH_TOKEN;
  });

  it('lists DATABASE_URL (the charter infra var) and excludes managed credentials', () => {
    expect(ARCHON_INTERNAL_ENV_KEYS.has('DATABASE_URL')).toBe(true);
    // Credentials target commands depend on must NOT be on the denylist.
    expect(ARCHON_INTERNAL_ENV_KEYS.has('GH_TOKEN')).toBe(false);
    expect(ARCHON_INTERNAL_ENV_KEYS.has('GITHUB_TOKEN')).toBe(false);
    expect(ARCHON_INTERNAL_ENV_KEYS.has('PATH')).toBe(false);
  });

  it('strips denied keys from the inherited base but keeps everything else', () => {
    process.env.DATABASE_URL = 'postgres://archon-internal/db';
    process.env.TEST_TARGET_KEEP = 'keep-me';
    process.env.GH_TOKEN = 'ghp_managed_token';

    const env = buildTargetCommandEnv({});

    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.TEST_TARGET_KEEP).toBe('keep-me');
    // Managed credential (not on the denylist) still flows to target commands.
    expect(env.GH_TOKEN).toBe('ghp_managed_token');
  });

  it('lets overrides re-introduce a denied key (config.envVars / workflow vars win)', () => {
    process.env.DATABASE_URL = 'postgres://archon-internal/db';

    const env = buildTargetCommandEnv({ DATABASE_URL: 'postgres://target/explicit' });

    expect(env.DATABASE_URL).toBe('postgres://target/explicit');
  });

  it('layers overrides on top of the stripped base', () => {
    process.env.TEST_TARGET_KEEP = 'base-value';

    const env = buildTargetCommandEnv({ ARTIFACTS_DIR: '/tmp/artifacts' });

    expect(env.ARTIFACTS_DIR).toBe('/tmp/artifacts');
    expect(env.TEST_TARGET_KEEP).toBe('base-value');
  });
});
