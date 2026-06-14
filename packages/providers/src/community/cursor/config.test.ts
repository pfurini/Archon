import { describe, expect, it } from 'bun:test';

import { parseCursorConfig } from './config';

describe('parseCursorConfig', () => {
  it('extracts a string model', () => {
    expect(parseCursorConfig({ model: 'composer-1' })).toEqual({ model: 'composer-1' });
  });

  it('returns an empty object for empty config', () => {
    expect(parseCursorConfig({})).toEqual({});
  });

  it('drops a non-string model silently (never throws)', () => {
    expect(parseCursorConfig({ model: 123 })).toEqual({});
    expect(parseCursorConfig({ model: null })).toEqual({});
  });

  it('ignores unknown fields', () => {
    expect(parseCursorConfig({ model: 'x', bogus: true })).toEqual({ model: 'x' });
  });
});
