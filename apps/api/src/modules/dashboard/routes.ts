/**
 * Dashboard read model (SRS §6.1: "Role-aware dashboards"; FR-11.2 for the unread count,
 * §3.10 for the queue depth).
 *
 *   GET /api/v1/dashboard   one payload for the landing screen
 *
 * A single endpoint on purpose: the home screen is the most frequently loaded page in the
 * product, and four sequential round trips to render six counters is what makes a dashboard
 * feel slow. Counts are role-aware — a Creator sees their own library, a reviewer sees the
 * tenant backlog — so the same page is honest for every role.
 */
import { withTenant, type Prisma } from '@void-space/db';
import {
  REVIEWABLE_STATUSES,
  type AssetStatus,
} from '@void-space/types';
import type { FastifyInstance } from 'fastify';

import { ForbiddenError } from '../../lib/errors';

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dashboard', { preHandler: app.authenticate }, async (request, reply) => {
    const principal = request.principal;
    if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

    const payload = await withTenant(principal.tenantId, async (db) => {
      const tenantId = principal.tenantId;
      const tenantWide = principal.permissions.includes('review:decide');
      // Typed explicitly: a bare union confuses Prisma's `where` inference when extra
      // conditions are merged into it below.
      const scope: Prisma.AssetWhereInput = tenantWide
        ? { tenantId }
        : { tenantId, creatorId: principal.userId };
      const since = new Date(Date.now() - 14 * 86_400_000);

      const [byStatus, awaiting, myDrafts, published, licensed, storage, users, apiKeys, recent, activity, jobs] =
        await Promise.all([
          db.asset.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
          db.asset.count({ where: { tenantId, status: { in: [...REVIEWABLE_STATUSES] } } }),
          db.asset.count({ where: { tenantId, creatorId: principal.userId, status: 'draft' } }),
          db.asset.count({ where: { ...scope, status: 'published' } }),
          db.license.count({ where: { tenantId } }),
          db.assetVersion.aggregate({ where: { tenantId }, _sum: { sizeBytes: true } }),
          db.user.count({ where: { tenantId } }),
          db.apiKey.count({ where: { tenantId, revokedAt: null } }),
          db.auditLog.findMany({
            where: { tenantId },
            orderBy: { createdAt: 'desc' },
            take: 8,
            select: { id: true, action: true, actorLabel: true, entityType: true, entityId: true, createdAt: true },
          }),
          db.asset.findMany({
            where: { ...scope, createdAt: { gte: since } },
            select: { createdAt: true },
          }),
          db.job.groupBy({
            by: ['queue', 'status'],
            where: { tenantId, status: { in: ['queued', 'active', 'delayed'] } },
            _count: { _all: true },
          }),
        ]);

      const statusCounts = Object.fromEntries(
        byStatus.map((row) => [row.status as AssetStatus, row._count._all]),
      ) as Partial<Record<AssetStatus, number>>;

      // 14-day ingest histogram for the sparkline.
      const histogram = new Map<string, number>();
      for (let day = 13; day >= 0; day -= 1) {
        histogram.set(new Date(Date.now() - day * 86_400_000).toISOString().slice(0, 10), 0);
      }
      for (const asset of activity) {
        const key = asset.createdAt.toISOString().slice(0, 10);
        if (histogram.has(key)) histogram.set(key, (histogram.get(key) ?? 0) + 1);
      }

      return {
        scope: tenantWide ? 'tenant' : 'own',
        counts: {
          assets: Object.values(statusCounts).reduce((sum, value) => sum + (value ?? 0), 0),
          byStatus: statusCounts,
          awaitingReview: awaiting,
          myDrafts,
          published,
          licensesMinted: licensed,
          users,
          activeApiKeys: apiKeys,
          storageBytes: Number(storage._sum.sizeBytes ?? 0),
        },
        jobsInFlight: jobs.map((row) => ({
          queue: row.queue,
          status: row.status,
          count: row._count._all,
        })),
        recent: recent.map((entry) => ({
          id: entry.id,
          action: entry.action,
          actorLabel: entry.actorLabel,
          entityType: entry.entityType,
          entityId: entry.entityId,
          createdAt: entry.createdAt.toISOString(),
        })),
        ingest: [...histogram.entries()].map(([day, count]) => ({ day, count })),
      };
    });

    return reply.status(200).send(payload);
  });
}
