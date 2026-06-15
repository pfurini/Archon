import { describe, expect, it } from 'bun:test';

// Pure builder — no SDK / console / stdin side effects, so it imports cleanly.
import { buildAgentOptions } from './runner-options.mjs';

const STORE = { __fake: 'store' };
const baseCfg = {
  model: 'composer-2.5',
  cwd: '/repo',
  settingSources: ['project'],
};

describe('buildAgentOptions', () => {
  it('emits model.params when modelParams are present (create path)', () => {
    const opts = buildAgentOptions(
      { ...baseCfg, modelParams: [{ id: 'fast', value: 'false' }] },
      { store: STORE, apiKey: 'k' }
    );
    expect(opts.model).toEqual({ id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] });
    expect(opts.local.cwd).toBe('/repo');
    expect(opts.local.store).toBe(STORE);
    expect(opts.apiKey).toBe('k');
  });

  it('produces the SAME options shape on the resume path (resumeSessionId is irrelevant to opts)', () => {
    // The runner passes the same opts to Agent.create and Agent.resume; resume is
    // selected by `cfg.resumeSessionId` upstream, NOT by a different opts object.
    const params = [{ id: 'reasoning', value: 'high' }];
    const create = buildAgentOptions(
      { ...baseCfg, modelParams: params },
      { store: STORE, apiKey: 'k' }
    );
    const resume = buildAgentOptions(
      { ...baseCfg, resumeSessionId: 'agent-prev', modelParams: params },
      { store: STORE, apiKey: 'k' }
    );
    expect(resume.model).toEqual({ id: 'composer-2.5', params });
    expect(resume.model).toEqual(create.model);
  });

  it('omits the params key when no modelParams are provided (byte-for-byte today)', () => {
    const opts = buildAgentOptions(baseCfg, { store: STORE, apiKey: 'k' });
    expect(opts.model).toEqual({ id: 'composer-2.5' });
    expect(Object.hasOwn(opts.model, 'params')).toBe(false);
  });

  it('omits the params key when modelParams is an empty array', () => {
    const opts = buildAgentOptions({ ...baseCfg, modelParams: [] }, { store: STORE, apiKey: 'k' });
    expect(opts.model).toEqual({ id: 'composer-2.5' });
    expect(Object.hasOwn(opts.model, 'params')).toBe(false);
  });

  it('passes sandbox + mcpServers through, defaulting settingSources to [project]', () => {
    const opts = buildAgentOptions(
      { model: 'composer-2.5', cwd: '/repo', sandbox: true, mcpServers: { foo: { command: 'x' } } },
      { store: STORE, apiKey: undefined }
    );
    expect(opts.local.settingSources).toEqual(['project']);
    expect(opts.local.sandboxOptions).toEqual({ enabled: true });
    expect(opts.mcpServers).toEqual({ foo: { command: 'x' } });
  });
});
