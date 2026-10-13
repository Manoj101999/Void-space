/**
 * Notification centre (SRS FR-12.x, FR-11.3).
 *
 *   GET  /api/v1/notifications        list (unreadOnly, paginated) + unreadCount
 *   POST /api/v1/notifications/read   mark read (specific ids, or everything)
 *
 * Notifications are produced by the `notify` worker, never by a request handler, so a slow
 * fan-out can never delay the domain change that caused it.
 */
import { markNotificationsReadSchema, notificationListQuerySchema } from '@void-space/types';
import { withTenant } from '@void-space/db';
import type { FastifyInstance } from 'fastify';

import { ForbiddenError } from '../../lib/errors';
import { parseBody, parseQuery } from '../../lib/http';

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/notifications', { preHandler: app.authenticate }, async (request, reply) => {
    const principal = request.principal;
    if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

    const query = parseQuery(notificationListQuerySchema, request.query);

    const result = await withTenant(principal.tenantId, async (db) => {
      const where = {
        tenantId: principal.tenantId,
        userId: principal.userId,
        ...(query.unreadOnly ? { readAt: null } : {}),
      };

      const [total, unreadCount, rows] = await Promise.all([
        db.notification.count({ where }),
        db.notification.count({
          where: { tenantId: principal.tenantId, userId: principal.userId, readAt: null },
        }),
        db.notification.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ]);

      return {
        items: rows.map((row) => ({
          id: row.id,
          type: row.type,
          payload: (row.payload ?? {}) as Record<string, unknown>,
          readAt: row.readAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        })),
        unreadCount,
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      };
    });

    return reply.status(200).send(result);
  });

  app.get('/notifications/count', { preHandler: app.authenticate }, async (request, reply) => {
    const principal = request.principal;
    if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

    const unreadCount = await withTenant(principal.tenantId, (db) =>
      db.notification.count({
        where: { tenantId: principal.tenantId, userId: principal.userId, readAt: null },
      }),
    );

    return reply.status(200).send({ unreadCount });
  });

  app.post('/notifications/read', { preHandler: app.authenticate }, async (request, reply) => {
    const principal = request.principal;
    if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

    const input = parseBody(markNotificationsReadSchema, request.body);

    const updated = await withTenant(principal.tenantId, (db) =>
      db.notification.updateMany({
        where: {
          tenantId: principal.tenantId,
          userId: principal.userId,
          readAt: null,
          ...(input.ids && input.ids.length > 0 ? { id: { in: input.ids } } : {}),
        },
        data: { readAt: new Date() },
      }),
    );

    return reply.status(200).send({ markedRead: updated.count });
  });
}
