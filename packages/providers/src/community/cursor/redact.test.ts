import { describe, expect, it } from 'bun:test';

import { redactSecrets } from './redact';

describe('redactSecrets', () => {
  it('masks Authorization Bearer tokens', () => {
    expect(redactSecrets('Authorization: Bearer abc123def456ghi')).toBe(
      'Authorization: [REDACTED]'
    );
  });

  it('masks sk- style keys', () => {
    expect(redactSecrets('key=sk-ABCdef1234567890')).toBe('key=[REDACTED]');
  });

  it('masks cursor-key- tokens', () => {
    expect(redactSecrets('using cursor-key-abc123XYZ789 now')).toBe('using [REDACTED] now');
  });

  it('masks JWT three-segment tokens', () => {
    const jwt = 'eyJhbGciOi.eyJzdWIiOiIxMjM.SflKxwRJSMeKKF2QT';
    expect(redactSecrets(`token ${jwt}`)).toBe('token [REDACTED]');
  });

  it('leaves non-secret text untouched and is null-safe', () => {
    expect(redactSecrets('just a normal error message')).toBe('just a normal error message');
    expect(redactSecrets('')).toBe('');
  });

  it('masks multiple secrets in one string', () => {
    const out = redactSecrets('Bearer aaaaaaee and sk-bbbbbbbb');
    expect(out).toBe('[REDACTED] and [REDACTED]');
  });
});
