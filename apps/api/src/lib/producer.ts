/**
 * Shared job producer factory.
 *
 * One `JobProducer` per API process: it holds the Redis connection and the BullMQ Queue
 * objects, so creating it per request would leak connections.
 */
import type { ApiEnv } from '../env';
import { JobProducer } from './jobs';

export function createJobProducer(env: ApiEnv): JobProducer {
  return new JobProducer({ redisUrl: env.REDIS_URL });
}
