/**
 * Job production (SRS §3.10, FR-11.x).
 *
 * The API is a BullMQ *producer*: it enqueues work and mirrors the job into Postgres
 * so the UI can poll progress without talking to Redis (FR-11.2). The worker owns
 * the lifecycle after that (`apps/worker/src/lib/job-tracking.ts`).
 *
 * Enqueueing is best-effort by design (NFR-REL.1): if Redis is unavailable the domain
 * change still commits — the asset exists, in `draft` with a failed job row — rather
 * than failing the whole request. The audit row and the failed job are what make that
 * visible instead of silent.
 */
import { Queue, type JobsOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { QUEUE_POLICIES, type QueueName } from '@void-space/types';

export interface JobRecord {
  readonly id: string;
  readonly queue: QueueName;
  readonly tenantId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly payload: Record<string, unknown>;
  readonly maxAttempts: number;
}

export interface EnqueuedJob {
  readonly id: string;
  readonly queue: QueueName;
  readonly enqueued: boolean;
  readonly error?: string;
}

let connection: Redis | undefined;
const queues = new Map<QueueName, Queue>();

/** The BullMQ job options for a queue, from the shared §3.10 policy. */
export function jobOptionsFor(queue: QueueName): JobsOptions {
  const policy = QUEUE_POLICIES[queue];
  return {
    attempts: policy.attempts,
    backoff: { type: policy.backoff.type, delay: policy.backoff.delayMs },
    removeOnComplete: { age: 3_600, count: 500 },
    removeOnFail: false,
  };
}

/** Lazily connects; repeated calls reuse one connection per process. */
function connect(redisUrl: string): Redis {
  connection ??= new IORedis(redisUrl, {
    // BullMQ requires the connection to tolerate long blocking commands.
    maxRetriesPerRequest: null,
    lazyConnect: false,
    enableOfflineQueue: true,
  });
  connection.on('error', () => {
    // Swallowed on purpose: the producer degrades, the request does not fail.
  });
  return connection;
}

export interface JobProducerOptions {
  readonly redisUrl: string;
  /** Injected for tests; defaults to the real Postgres writer. */
  readonly onEnqueued?: (job: EnqueuedJob) => Promise<void>;
}

export class JobProducer {
  private readonly redisUrl: string;
  private readonly onEnqueued?: (job: EnqueuedJob) => Promise<void>;

  constructor(options: JobProducerOptions) {
    this.redisUrl = options.redisUrl;
    this.onEnqueued = options.onEnqueued;
  }

  private queueFor(name: QueueName): Queue {
    const existing = queues.get(name);
    if (existing) return existing;

    const created = new Queue(name, {
      connection: connect(this.redisUrl),
      defaultJobOptions: jobOptionsFor(name),
    });
    queues.set(name, created);
    return created;
  }

  /**
   * Adds a job with a caller-supplied id, so the Postgres mirror and the Redis job
   * share one identifier (FR-11.2 makes them the same object to the user).
   */
  async enqueue(record: JobRecord): Promise<EnqueuedJob> {
    try {
      await this.queueFor(record.queue).add(record.queue, record.payload, {
        jobId: record.id,
        attempts: record.maxAttempts,
      });
      const result: EnqueuedJob = { id: record.id, queue: record.queue, enqueued: true };
      await this.onEnqueued?.(result);
      return result;
    } catch (error) {
      return {
        id: record.id,
        queue: record.queue,
        enqueued: false,
        error: (error as Error).message,
      };
    }
  }

  /** Queue depth per queue, for the System Health screen (§3.10, NFR-SCAL.2). */
  async counts(): Promise<Partial<Record<QueueName, number>>> {
    const result: Partial<Record<QueueName, number>> = {};
    for (const name of Object.keys(QUEUE_POLICIES) as QueueName[]) {
      try {
        result[name] = await this.queueFor(name).count();
      } catch {
        result[name] = 0;
      }
    }
    return result;
  }

  async close(): Promise<void> {
    await Promise.all([...queues.values()].map((queue) => queue.close()));
    queues.clear();
    await connection?.quit();
    connection = undefined;
  }
}
