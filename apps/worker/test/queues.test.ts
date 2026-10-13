/**
 * Queue wiring tests (SRS §3.10, NFR-SCAL.2).
 *
 * `jobOptionsFor` and `concurrencyFor` are the two places where the documented retry
 * policy meets BullMQ. Both are pure functions, so they can be checked without Redis:
 * a drift between the SRS table and the runtime options fails here.
 */
import { describe, expect, it } from 'vitest';

import { QUEUE_NAMES, QUEUE_POLICIES } from '@void-space/types';

import { concurrencyFor, jobOptionsFor } from '../src/queues';

describe('§3.10 queue wiring', () => {
  it('translates every documented policy into BullMQ job options', () => {
    for (const name of QUEUE_NAMES) {
      const options = jobOptionsFor(name);
      const policy = QUEUE_POLICIES[name];

      expect(options.attempts).toBe(policy.attempts);
      expect(options.backoff).toEqual({
        type: policy.backoff.type,
        delay: policy.backoff.delayMs,
      });
    }
  });

  it('keeps only a short tail of completed jobs and never drops failures', () => {
    const options = jobOptionsFor('ai-enrichment');
    // Postgres mirrors job history, so Redis is bounded (see §3.10 / the jobs table).
    expect(options.removeOnComplete).toEqual({ age: 3_600, count: 500 });
    expect(options.removeOnFail).toBe(false);
  });

  it('uses the documented default concurrency when no override is set', () => {
    const previous = process.env['WORKER_CONCURRENCY_IPFS_PIN'];
    delete process.env['WORKER_CONCURRENCY_IPFS_PIN'];

    try {
      expect(concurrencyFor('ipfs-pin')).toBe(QUEUE_POLICIES['ipfs-pin'].defaultConcurrency);
    } finally {
      if (previous !== undefined) process.env['WORKER_CONCURRENCY_IPFS_PIN'] = previous;
    }
  });

  it('allows a per-queue concurrency override (NFR-SCAL.2)', () => {
    const key = 'WORKER_CONCURRENCY_CHAIN_LICENSE';
    const previous = process.env[key];
    process.env[key] = '7';

    try {
      expect(concurrencyFor('chain-license')).toBe(7);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it('ignores a nonsensical override instead of stalling the queue', () => {
    const key = 'WORKER_CONCURRENCY_NOTIFY';
    const previous = process.env[key];
    process.env[key] = '0';

    try {
      // A worker with concurrency 0 would never process anything, so the default wins.
      expect(concurrencyFor('notify')).toBe(QUEUE_POLICIES['notify'].defaultConcurrency);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});
