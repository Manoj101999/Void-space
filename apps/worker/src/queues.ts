/**
 * Queue registry (SRS §3.10).
 *
 * Every queue is created with the retry policy documented in the SRS table, read
 * from the *shared* contract in @void-space/types so the API (producer) and the
 * worker (consumer) can never disagree about attempts or backoff.
 */
import { QUEUE_NAMES, QUEUE_POLICIES, type QueueName } from '@void-space/types';
import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';

export interface QueueRegistry {
  readonly queues: Record<QueueName, Queue>;
  close(): Promise<void>;
}

/** BullMQ job options derived from the documented policy for a queue. */
export function jobOptionsFor(queue: QueueName): JobsOptions {
  const policy = QUEUE_POLICIES[queue];
  return {
    attempts: policy.attempts,
    backoff: { type: policy.backoff.type, delay: policy.backoff.delayMs },
    // Finished jobs are mirrored into Postgres (the `jobs` table), so Redis is
    // only asked to keep a short tail for debugging.
    removeOnComplete: { age: 3_600, count: 500 },
    removeOnFail: false,
  };
}

/**
 * Worker concurrency per queue (NFR-SCAL.2), overridable by environment so a
 * deployment can scale each queue independently.
 */
export function concurrencyFor(queue: QueueName): number {
  const envKey = `WORKER_CONCURRENCY_${queue.replace(/-/g, '_').toUpperCase()}`;
  const configured = Number.parseInt(process.env[envKey] ?? '', 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : QUEUE_POLICIES[queue].defaultConcurrency;
}

export function createQueueRegistry(connection: Redis): QueueRegistry {
  const queues = {} as Record<QueueName, Queue>;

  for (const name of QUEUE_NAMES) {
    queues[name] = new Queue(name, {
      connection,
      defaultJobOptions: jobOptionsFor(name),
    });
  }

  return {
    queues,
    async close(): Promise<void> {
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
    },
  };
}
