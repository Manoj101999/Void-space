/**
 * Job failure bookkeeping (SRS FR-11.2, §3.10).
 *
 * `isTerminalFailure` decides whether the dashboard says "failed, will retry" or "failed". Getting
 * it wrong in one direction nests a retry loop inside a terminal failure; in the other it leaves a
 * row reading "will retry" for a job BullMQ has already thrown away, which renders as a spinner
 * that never resolves and hides a real problem behind a fake one.
 */
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { attemptOf, isTerminalFailure } from '../src/lib/job-tracking';

describe('attemptOf', () => {
  it('reports a 1-based attempt, matching the §3.10 "1 initial run" wording', () => {
    expect(attemptOf({ attemptsMade: 0 })).toBe(1);
    expect(attemptOf({ attemptsMade: 1 })).toBe(2);
    expect(attemptOf({ attemptsMade: 2 })).toBe(3);
  });
});

describe('isTerminalFailure', () => {
  it('keeps retrying while the policy still has attempts left', () => {
    expect(isTerminalFailure(new Error('flaky network'), { attempt: 1, maxAttempts: 3 })).toBe(false);
    expect(isTerminalFailure(new Error('flaky network'), { attempt: 2, maxAttempts: 3 })).toBe(false);
  });

  it('is terminal on the last attempt', () => {
    expect(isTerminalFailure(new Error('flaky network'), { attempt: 3, maxAttempts: 3 })).toBe(true);
  });

  it('is terminal when the first attempt is the only attempt', () => {
    expect(isTerminalFailure(new Error('one shot'), { attempt: 1, maxAttempts: 1 })).toBe(true);
  });

  it('is terminal for an unrecoverable error before the policy is spent', () => {
    // The case that matters: BullMQ will not retry this, so the row must not claim it will.
    const error = new UnrecoverableError('subject no longer exists');
    expect(isTerminalFailure(error, { attempt: 1, maxAttempts: 3 })).toBe(true);
  });

  it('recognises an unrecoverable error arriving from another bullmq instance', () => {
    // A cross-instance `instanceof` returns false, so the check also matches on the error name.
    const foreign = Object.assign(new Error('subject no longer exists'), {
      name: 'UnrecoverableError',
    });
    expect(isTerminalFailure(foreign, { attempt: 1, maxAttempts: 3 })).toBe(true);
  });

  it('does not treat an ordinary error named like another class as unrecoverable', () => {
    // Guards against a loose substring match: only the exact discriminant counts.
    const decoy = Object.assign(new Error('boom'), { name: 'RecoverableError' });
    expect(isTerminalFailure(decoy, { attempt: 1, maxAttempts: 3 })).toBe(false);
  });

  it('handles non-Error throwables without assuming a shape', () => {
    for (const thrown of ['a string', null, undefined, 42, { message: 'no name' }]) {
      expect(isTerminalFailure(thrown, { attempt: 3, maxAttempts: 3 })).toBe(true);
      expect(isTerminalFailure(thrown, { attempt: 1, maxAttempts: 3 })).toBe(false);
    }
  });
});
