/**
 * FR-12.4 — the rate-limit bucket follows the credential, not the address.
 *
 * This is a unit test rather than a request-storm because the property is a *mapping*, and
 * proving it through HTTP would mean 300 round trips to observe one 429. Two of these assertions
 * are the ones that matter: two different keys must not share a bucket (or forty integrations
 * behind one NAT share one budget), and the same key must map to the same bucket every time (or
 * the limit is not a limit).
 */
import { describe, expect, it } from 'vitest';

import { rateLimitKey } from '../src/lib/rate-limit-key';

describe('FR-12.4 rate-limit keys', () => {
  it('buckets a bearer token by credential, ignoring the source address', () => {
    const a = rateLimitKey({ headers: { authorization: 'Bearer token-a' }, ip: '10.0.0.1' });
    const b = rateLimitKey({ headers: { authorization: 'Bearer token-a' }, ip: '10.0.0.2' });

    // Same credential, different addresses — one budget. This is the fix: the same integration
    // must not multiply its allowance by moving between addresses.
    expect(a).toBe(b);
    expect(a.startsWith('token:')).toBe(true);
  });

  it('gives distinct credentials distinct budgets', () => {
    const a = rateLimitKey({ headers: { authorization: 'Bearer token-a' }, ip: '10.0.0.1' });
    const b = rateLimitKey({ headers: { authorization: 'Bearer token-b' }, ip: '10.0.0.1' });

    // One busy integration must not exhaust another's allowance.
    expect(a).not.toBe(b);
  });

  it('falls back to the address for cookie sessions and anonymous calls', () => {
    expect(rateLimitKey({ headers: {}, ip: '10.0.0.1' })).toBe('ip:10.0.0.1');
    expect(rateLimitKey({ headers: { authorization: 'Basic abc' }, ip: '10.0.0.1' })).toBe(
      'ip:10.0.0.1',
    );
    // A malformed header is not a credential, so it must not create a token bucket.
    expect(rateLimitKey({ headers: { authorization: 'Bearer' }, ip: '10.0.0.1' })).toBe(
      'ip:10.0.0.1',
    );
  });

  it('never puts the raw credential in the key', () => {
    const secret = 'vs_dev_deadbeef_super-secret-value';
    const key = rateLimitKey({ headers: { authorization: `Bearer ${secret}` }, ip: '10.0.0.1' });

    // A live token in the limiter's key space would leak working credentials through a heap dump
    // or a debug log of the store.
    expect(key).not.toContain(secret);
    expect(key).not.toContain('super-secret');
    expect(key).toMatch(/^token:[0-9a-f]{32}$/);
  });

  it('survives a missing remote address', () => {
    expect(rateLimitKey({ headers: {} })).toBe('ip:unknown');
  });
});
