/**
 * Worker runtime (SRS §3.10) — imported by server.ts after the root .env is loaded.
 *
 * Runs one BullMQ Worker per queue with the documented retry policy and per-queue
 * concurrency (NFR-SCAL.2).
 *
 * Five of the six queues have a processor: `ipfs-pin`, `ai-enrichment`, `notify`,
 * `chain-license`, `xr-publish` and `blender-optimize`. If a processor is ever missing again, the
 * queue falls back to a deliberate no-op consumer that logs a warning — so a job enqueued before
 * its processor exists is visible rather than silently lost.
 *
 * The Blender runner is the one processor whose *dependency* is optional: with no
 * `BLENDER_RUNNER_URL` set it records a labelled simulation instead of converting, so the pipeline
 * stays inspectable without a 1 GB image. See `processors/blender-optimize.ts`.
 * See `docs/FR-traceability.md` for the requirement-level view.
 */
import { QUEUE_NAMES, type QueueName } from '@void-space/types';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import pino from 'pino';

import { createAiEnrichmentProcessor } from './processors/ai-enrichment';
import { createBlenderOptimizeProcessor } from './processors/blender-optimize';
import { createChainLicenseProcessor } from './processors/chain-license';
import { createIpfsPinProcessor } from './processors/ipfs-pin';
import { createNotifyProcessor } from './processors/notify';
import { createXrPublishProcessor } from './processors/xr-publish';
import { createWorkerProducer } from './lib/producer';
import { concurrencyFor, createQueueRegistry, jobOptionsFor } from './queues';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
      : undefined,
});

type Processor = (job: never) => Promise<unknown>;

/** Queues whose processors are implemented; the rest log and complete. */
const PROCESSORS: Partial<Record<QueueName, Processor>> = {};

export async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('[worker] REDIS_URL is not set — copy .env.example to .env (SRS §9.4)');
  }

  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  connection.on('error', (error) => logger.error({ err: error }, 'redis connection error'));

  await connection.ping();
  logger.info({ redis: redisUrl.replace(/\/\/.*@/, '//') }, 'redis connected');

  const registry = createQueueRegistry(connection);

  // The worker also produces a little: a completed mint queues the EoN push and the
  // Creator's notification. One producer per process, sharing the Redis connection.
  const producer = createWorkerProducer(connection);

  PROCESSORS['ipfs-pin'] = createIpfsPinProcessor({
    ipfsApiUrl: process.env.IPFS_API_URL ?? 'http://127.0.0.1:5001',
    logger,
  }) as Processor;

  PROCESSORS['ai-enrichment'] = createAiEnrichmentProcessor({
    logger,
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5-20250929',
    timeoutMs: Number.parseInt(process.env.ANTHROPIC_TIMEOUT_MS ?? '30000', 10),
  }) as Processor;

  PROCESSORS['notify'] = createNotifyProcessor({ logger }) as Processor;

  PROCESSORS['chain-license'] = createChainLicenseProcessor({
    logger,
    // `127.0.0.1` rather than `localhost` (see the note on IPFS_API_URL below): the IPv6
    // loopback is not reliably ours on a Windows host.
    rpcUrl: process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545',
    contractAddress: process.env.CONTRACT_ADDRESS ?? '',
    privateKey: process.env.PLATFORM_SIGNER_SEED ?? '',
    ipfsApiUrl: process.env.IPFS_API_URL ?? 'http://127.0.0.1:5001',
    producer,
  }) as Processor;

  PROCESSORS['xr-publish'] = createXrPublishProcessor({
    logger,
    apiUrl: process.env.EON_API_URL,
    apiKey: process.env.EON_API_KEY,
    publicBaseUrl: process.env.EON_PUBLIC_BASE_URL ?? 'https://localhost/eon',
  }) as Processor;

  // FR-6.3 — the headless Blender queue. `runnerUrl` unset is a supported state, not a
  // misconfiguration: the processor records a labelled simulation so the pipeline stays visible
  // without the ~1 GB image. See the processor's header for why that is preferable to failing.
  PROCESSORS['blender-optimize'] = createBlenderOptimizeProcessor({
    logger,
    runnerUrl: process.env.BLENDER_RUNNER_URL,
    jobDir: process.env.BLENDER_JOB_DIR ?? '/var/lib/void-space/blender-jobs',
  }) as Processor;

  const workers: Worker[] = [];

  for (const name of QUEUE_NAMES) {
    const processor = PROCESSORS[name];
    const worker = new Worker(
      name,
      processor
        ? (job) => processor(job as never)
        : async (job) => {
            logger.warn(
              { queue: name, jobId: job.id },
              'no processor is attached to this queue yet — the job is completed as a no-op',
            );
            return { skipped: true };
          },
      {
        connection,
        concurrency: concurrencyFor(name),
        ...(processor ? {} : {}),
      },
    );

    worker.on('failed', (job, error) => {
      logger.error(
        { queue: name, jobId: job?.id, attempts: job?.attemptsMade, err: error },
        'job failed',
      );
    });
    worker.on('completed', (job) => {
      logger.debug({ queue: name, jobId: job.id }, 'job completed');
    });

    workers.push(worker);
  }

  logger.info(
    {
      queues: QUEUE_NAMES.map((name) => ({
        name,
        attempts: jobOptionsFor(name).attempts,
        concurrency: concurrencyFor(name),
        implemented: name in PROCESSORS,
      })),
    },
    'worker ready',
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received — shutting down`);
    await Promise.all(workers.map((worker) => worker.close()));
    await producer.close();
    await registry.close();
    await connection.quit();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
