import { describe, it, expect } from 'bun:test';
import { isValidEnvVarName, ENV_VAR_NAME_PATTERN } from './env-name';

describe('isValidEnvVarName', () => {
  it('accepts POSIX shell identifiers', () => {
    for (const ok of ['FOO', '_BAR', 'foo_bar1', 'A', '_', 'PATH', 'X1_Y2']) {
      expect(isValidEnvVarName(ok)).toBe(true);
    }
  });

  it('rejects injection payloads and non-identifiers', () => {
    for (const bad of [
      'X$(touch /tmp/pwn)',
      '`id`',
      'A;B',
      'A B',
      '1ABC',
      'FOO-BAR',
      'FOO.BAR',
      'FOO=BAR',
      '',
      'FOO\nBAR',
    ]) {
      expect(isValidEnvVarName(bad)).toBe(false);
    }
  });

  it('pattern is anchored (no partial match)', () => {
    expect(ENV_VAR_NAME_PATTERN.test('GOOD$(bad)')).toBe(false);
  });
});
