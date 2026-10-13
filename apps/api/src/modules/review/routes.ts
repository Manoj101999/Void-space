/**
 * Review routes (FR-4.x, FR-7.5, §6.1).
 *
 *   GET  /api/v1/review/queue          assessor triage list      (review:view-queue)
 *   GET  /api/v1/review/stats          assessor KPIs             (review:view-queue)
 *   POST /api/v1/assets/:id/decisions  approve / reject / revise (review:decide)
 *   POST /api/v1/assets/:id/comments   threaded comment          (catalog:view)
 */
import { createCommentSchema, reviewDecisionSchema, reviewQueueQuerySchema } from '@void-space/types';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import type { ApiEnv } from '../../env';
import { ForbiddenError } from '../../lib/errors';
import { parseBody, parseParams, parseQuery } from '../../lib/http';
import type { JobProducer } from '../../lib/jobs';
import { StagingStorage } from '../../lib/storage';
import { createReviewService } from './service';

const idParams = z.object({ id: z.string().uuid() });

export interface ReviewRoutesOptions {
  readonly env: ApiEnv;
  readonly producer: JobProducer;
}

export async function reviewRoutes(
  app: FastifyInstance,
  options: ReviewRoutesOptions,
): Promise<void> {
  const review = createReviewService({
    producer: options.producer,
    storage: new StagingStorage({ stagingDir: options.env.STAGING_DIR }),
  });

  app.get(
    '/review/queue',
    { preHandler: app.requirePermission('review:view-queue') },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const query = parseQuery(reviewQueueQuerySchema, request.query);
      return reply.status(200).send(await review.queue(principal, query));
    },
  );

  app.get(
    '/review/stats',
    { preHandler: app.requirePermission('review:view-queue') },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');
      return reply.status(200).send({ stats: await review.stats(principal) });
    },
  );

  app.post(
    '/assets/:id/decisions',
    { preHandler: app.requirePermission('review:decide') },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const { id } = parseParams(idParams, request.params);
      const input = parseBody(reviewDecisionSchema, request.body);
      return reply.status(201).send({ asset: await review.decide(principal, id, input) });
    },
  );

  app.post(
    '/assets/:id/comments',
    { preHandler: app.requirePermission('catalog:view') },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const { id } = parseParams(idParams, request.params);
      const input = parseBody(createCommentSchema, request.body);
      return reply.status(201).send({ asset: await review.comment(principal, id, input) });
    },
  );
}
