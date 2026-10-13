/**
 * Tenant user & role administration routes (FR-1.2, FR-1.3, §3.6).
 *
 *   GET    /api/v1/users                 list members            (tenant:manage-users)
 *   POST   /api/v1/users/invite          invite by email         (tenant:manage-users)
 *   GET    /api/v1/users/invites         pending invitations     (tenant:manage-users)
 *   PATCH  /api/v1/users/:id             change role             (tenant:manage-users)
 *   PATCH  /api/v1/users/:id/status      activate/deactivate     (tenant:manage-users)
 *   DELETE /api/v1/users/:id             remove from workspace   (tenant:manage-users)
 *   GET    /api/v1/roles                 the §3.6 role catalogue (any member)
 */
import { inviteUserSchema, updateUserRoleSchema } from '@void-space/types';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { parseBody, parseParams } from '../../lib/http';
import { createUsersService } from './service';

const idParams = z.object({ id: z.string().uuid() });
const statusSchema = z.object({ status: z.enum(['active', 'suspended']) });

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const users = createUsersService();
  const guard = app.requirePermission('tenant:manage-users');

  /** The caller, guaranteed present because `guard` ran first. */
  function principalOf(request: FastifyRequest) {
    const principal = request.principal;
    if (!principal) throw new Error('[users] principal missing after authenticate()');
    return principal;
  }

  app.get('/users', { preHandler: guard }, async (request, reply) => {
    const members = await users.list(principalOf(request));
    return reply.status(200).send({ users: members, total: members.length });
  });

  app.post('/users/invite', { preHandler: guard }, async (request, reply) => {
    const input = parseBody(inviteUserSchema, request.body);
    const invite = await users.invite(principalOf(request), input);
    return reply.status(201).send({ invite });
  });

  app.get('/users/invites', { preHandler: guard }, async (request, reply) => {
    const invites = await users.listInvites(principalOf(request));
    return reply.status(200).send({ invites });
  });

  app.patch('/users/:id', { preHandler: guard }, async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    const input = parseBody(updateUserRoleSchema, request.body);
    const result = await users.setRole(principalOf(request), id, input.role);
    return reply.status(200).send(result);
  });

  app.patch('/users/:id/status', { preHandler: guard }, async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    const input = parseBody(statusSchema, request.body);
    const result = await users.setStatus(principalOf(request), id, input.status);
    return reply.status(200).send(result);
  });

  app.delete('/users/:id', { preHandler: guard }, async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    const result = await users.remove(principalOf(request), id);
    return reply.status(200).send({
      ...result,
      message: 'Membership removed; the account was deactivated and all sessions revoked.',
    });
  });

  // Reading the role catalogue only needs authentication: the UI renders it for
  // every member (e.g. to explain what a role can do).
  app.get('/roles', { preHandler: app.authenticate }, async (_request, reply) => {
    return reply.status(200).send({ roles: await users.roles() });
  });
}
