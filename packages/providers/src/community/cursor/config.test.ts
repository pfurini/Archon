import { describe, expect, it } from 'bun:test';

import { CursorConfigError, parseCursorConfig } from './config';

describe('parseCursorConfig', () => {
  it('extracts a string model', () => {
    expect(parseCursorConfig({ model: 'composer-1' })).toEqual({ model: 'composer-1' });
  });

  it('returns an empty object for empty config', () => {
    expect(parseCursorConfig({})).toEqual({});
  });

  it('drops a non-string model silently (never throws — model choice is not a billing risk)', () => {
    expect(parseCursorConfig({ model: 123 })).toEqual({});
    expect(parseCursorConfig({ model: null })).toEqual({});
  });

  it('ignores unknown fields', () => {
    expect(parseCursorConfig({ model: 'x', bogus: true })).toEqual({ model: 'x' });
  });

  describe('fast (strict — gates the cost default)', () => {
    it('parses a boolean fast and preserves presence', () => {
      const a = parseCursorConfig({ fast: false });
      expect(a.fast).toBe(false);
      expect(Object.hasOwn(a, 'fast')).toBe(true);
      expect(parseCursorConfig({ fast: true })).toEqual({ fast: true });
    });
    it('is absent (no key) when not provided — distinguishable from explicit false', () => {
      expect(Object.hasOwn(parseCursorConfig({}), 'fast')).toBe(false);
    });
    it('throws on a present-but-invalid fast (not silently dropped)', () => {
      expect(() => parseCursorConfig({ fast: 'yes' })).toThrow(CursorConfigError);
      expect(() => parseCursorConfig({ fast: 'false' })).toThrow(CursorConfigError);
      expect(() => parseCursorConfig({ fast: 1 })).toThrow(CursorConfigError);
    });
  });

  describe('context (strict)', () => {
    it('parses a non-empty string context', () => {
      expect(parseCursorConfig({ context: '1m' })).toEqual({ context: '1m' });
    });
    it('throws on a non-string or empty context', () => {
      expect(() => parseCursorConfig({ context: 123 })).toThrow(CursorConfigError);
      expect(() => parseCursorConfig({ context: '' })).toThrow(CursorConfigError);
    });
  });

  describe('allowPremiumOnDegraded (strict)', () => {
    it('parses a boolean', () => {
      expect(parseCursorConfig({ allowPremiumOnDegraded: true })).toEqual({
        allowPremiumOnDegraded: true,
      });
    });
    it('throws on a non-boolean', () => {
      expect(() => parseCursorConfig({ allowPremiumOnDegraded: 'true' })).toThrow(
        CursorConfigError
      );
    });
  });
});
