/**
 * Asynchronous job status (SRS FR-6.5, §3.10).
 *
 *   GET /api/v1/jobs/:id   the state of one long-running operation
 *
 * The `jobs` table has existed since the async platform landed — it is how the console shows
 * pipeline progress — but the polling endpoint the SRS names never did. This closes FR-6.5.
 *
 * Two things are deliberate:
 *
 *  1. **A foreign job is a 404, not a 403.** The response must not confirm that an id exists in
 *     another workspace, so a job whose asset the caller cannot read is reported as absent. This
 *     is the same rule the asset detail route uses, and it is what makes an id-guessing sweep
 *     uninformative rather than merely unsuccessful.
 *
 *  2. **Visibility follows the asset, not the job.** A job is an internal record with no
 *     audience of its own, so the caller's right to see it is derived from the entity it acted
 *     on: its creator, anyone who can review, or a published asset. `catalog:view` is required
 *     first, which every role holds, so the check that matters is the second one.
 */
import { jobIdParamsSchema, queueNameFromDb, type JobStatusView } from '@void-space/types';
import { withTenant } from '@void-space/db';
import type { FastifyInstance } from 'fastify';

import { ForbiddenError, NotFoundError } from '../../lib/errors';
import { parseParams } from '../../lib/http';

/** Terminal states; anything else means "keep polling". */
const TERMINAL = new Set(['completed', 'failed']);

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/jobs/:id',
    { preHandler: app.requirePermission('catalog:view') },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const { id } = parseParams(jobIdParamsSchema, request.params);

      const view = await withTenant(principal.tenantId, async (db) => {
        const job = await db.job.findFirst({
          where: { id, tenantId: principal.tenantId },
        });
        if (!job) throw new NotFoundError('Job');

        // A job on an asset is readable by whoever may read that asset. Jobs on other entity
        // types (a bare `notify`, for instance) carry no asset to check, and stay tenant-scoped:
        // any member may poll their own workspace's job state.
        if (job.entityType === 'asset' && job.entityId) {
          const asset = await db.asset.findFirst({
            where: { id: job.entityId, tenantId: principal.tenantId },
            select: { creatorId: true, status: true },
          });
          if (!asset) throw new NotFoundError('Job');

          const readable =
            asset.creatorId === principal.userId ||
            asset.status === 'published' ||
            principal.permissions.includes('review:decide');
          if (!readable) throw new NotFoundError('Job');
        }

        const mapped: JobStatusView = {
          id: job.id,
          queue: queueNameFromDb(job.queue),
          status: job.status,
          entityType: job.entityType,
          entityId: job.entityId,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          error: job.error,
          result: (job.result ?? null) as Record<string, unknown> | null,
          inProgress: !TERMINAL.has(job.status),
          startedAt: job.startedAt?.toISOString() ?? null,
          finishedAt: job.finishedAt?.toISOString() ?? null,
          createdAt: job.createdAt.toISOString(),
          updatedAt: job.updatedAt.toISOString(),
        };
        return mapped;
      });

      // Polling a terminal job is pointless, and saying so is cheaper than a client-side
      // timer that keeps asking. `Retry-After` is the same header FR-12.4 uses for its 429,
      // so a client that already honours rate limits needs no new code.
      if (view.inProgress) reply.header('Retry-After', '2');
      return reply.status(200).send(view);
    },
  );
}
