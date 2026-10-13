/**
 * Tenant routes (FR-1.4, FR-1.5, FR-14.1, FR-14.3).
 *
 *   GET   /api/v1/tenant                     current workspace + settings + counts
 *   PATCH /api/v1/tenant/settings            update upload defaults   (tenant:manage)
 *   GET   /api/v1/tenants                    platform tenant list     (SuperAdmin)
 *   PATCH /api/v1/tenants/:id/status         suspend / reinstate      (SuperAdmin)
 */
import { setTenantStatusSchema, tenantSettingsSchema } from '@void-space/types';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { parseBody, parseParams } from '../../lib/http';
import { createTenantsService } from './service';

const idParams = z.object({ id: z.string().uuid() });

export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  const tenants = createTenantsService();

  function principalOf(request: FastifyRequest) {
    const principal = request.principal;
    if (!principal) throw new Error('[tenant] principal missing after authenticate()');
    return principal;
  }

  app.get('/tenant', { preHandler: app.authenticate }, async (request, reply) => {
    return reply.status(200).send({ tenant: await tenants.detail(principalOf(request)) });
  });

  // `tenant:manage` is SuperAdmin-only in the §3.6 matrix.
  app.patch(
    '/tenant/settings',
    { preHandler: app.requirePermission('tenant:manage') },
    async (request, reply) => {
      const input = parseBody(tenantSettingsSchema, request.body);
      const settings = await tenants.updateSettings(principalOf(request), input);
      return reply.status(200).send({ settings });
    },
  );

  app.get('/tenants', { preHandler: app.requirePermission('tenant:manage') }, async (request, reply) => {
    const list = await tenants.list(principalOf(request));
    return reply.status(200).send({ tenants: list, total: list.length });
  });

  app.patch(
    '/tenants/:id/status',
    { preHandler: app.requirePermission('tenant:manage') },
    async (request, reply) => {
      const { id } = parseParams(idParams, request.params);
      const input = parseBody(setTenantStatusSchema, request.body);
      const result = await tenants.setStatus(principalOf(request), id, input.status, input.reason);
      return reply.status(200).send(result);
    },
  );
}
