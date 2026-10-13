/**
 * Job production from inside the worker.
 *
 * The worker is normally a *consumer*, but two flows need it to enqueue follow-up work:
 * a completed mint queues the EoN push (§3.10) and the Creator notification, and both must
 * happen in the same transaction that records the licence. Without a producer here the
 * `jobs` row was written and the job never actually queued — a silent stall that looked fine
 * in the database and did nothing in the queue.
 */
import { QUEUE_POLICIES, type QueueName } from '@void-space/types';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export interface WorkerProducer {
  enqueue(params: {
    readonly id: string;
    readonly queue: QueueName;
    readonly payload: Record<string, unknown>;
    readonly maxAttempts: number;
  }): Promise<{ enqueued: boolean; error?: string }>;
  close(): Promise<void>;
}

export function createWorkerProducer(connection: Redis): WorkerProducer {
  const queues = new Map<QueueName, Queue>();

  function queueFor(name: QueueName): Queue {
    const existing = queues.get(name);
    if (existing) return existing;

    const policy = QUEUE_POLICIES[name];
    const created = new Queue(name, {
      connection,
      defaultJobOptions: {
        attempts: policy.attempts,
        backoff: { type: policy.backoff.type, delay: policy.backoff.delayMs },
        removeOnComplete: { age: 3_600, count: 500 },
        removeOnFail: false,
      },
    });
    queues.set(name, created);
    return created;
  }

  return {
    async enqueue({ id, queue, payload, maxAttempts }) {
      try {
        await queueFor(queue).add(queue, payload, { jobId: id, attempts: maxAttempts });
        return { enqueued: true };
      } catch (error) {
        return { enqueued: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async close() {
      await Promise.all([...queues.values()].map((queue) => queue.close()));
      queues.clear();
    },
  };
}
