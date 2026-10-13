/**
 * Audit log routes (FR-13.1–13.2).
 *
 *   GET /api/v1/audit   paginated, filterable tenant audit log (audit:view)
 *
 * Read-only by construction: FR-13.1 append-only is enforced by database grants,
 * not by convention (packages/db/prisma/sql/rls.sql).
 */
import { auditQuerySchema } from '@void-space/types';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { parseQuery } from '../../lib/http';
import { createAuditService } from './service';

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  const audit = createAuditService();

  app.get(
    '/audit',
    { preHandler: app.requirePermission('audit:view') },
    async (request: FastifyRequest, reply) => {
      const principal = request.principal;
      if (!principal) throw new Error('[audit] principal missing after authenticate()');

      const query = parseQuery(auditQuerySchema, request.query);
      return reply.status(200).send(await audit.query(principal, query));
    },
  );
}
