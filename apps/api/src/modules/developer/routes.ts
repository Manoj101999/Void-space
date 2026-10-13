/**
 * API key management (SRS FR-12.3, NFR-SEC.7; endpoint shape from §6.4).
 *
 *   POST   /api/v1/tenants/:id/api-keys                 create → raw key, once
 *   GET    /api/v1/tenants/:id/api-keys                 list   (never the secret)
 *   POST   /api/v1/tenants/:id/api-keys/:keyId/rotate   rotate → new raw key, once
 *   DELETE /api/v1/tenants/:id/api-keys/:keyId          revoke
 *
 * Until now a key could only be created by the seed script, which printed it to a terminal — so
 * FR-12.3 ("creation, copy once at creation, and rotation from the developer-facing dashboard")
 * had its hashing helpers, its exchange endpoint (`POST /auth/token`, FR-2.5) and its test suite,
 * but no way for a person to actually mint one. This is that way.
 *
 * Three rules hold the shape together:
 *
 *  1. **The path tenant must be the caller's own.** A key embeds its tenant id, so minting one
 *     for a different workspace would be a cross-tenant write dressed up as an admin action. A
 *     mismatch is a 404 rather than a 403: the caller learns nothing about whether that
 *     workspace exists.
 *
 *  2. **The secret leaves exactly once.** `POST` and `rotate` return the raw key; `GET` returns
 *     `prefix` and `lastUsedAt` only. There is no endpoint that can re-read a key, which is what
 *     NFR-SEC.7 means by "shown to the user exactly once".
 *
 *  3. **Rotation is revoke-then-issue, not an edit.** Nothing can change a key's secret in place
 *     — the stored value is a salted hash — so rotation marks the old row revoked and creates a
 *     new one with the same label and the same expiry. The revoked row stays, for the audit.
 */
import {
  apiKeyListQuerySchema,
  createApiKeySchema,
  type ApiKeySummary,
  type CreatedApiKey,
} from '@void-space/types';
import { generateApiKey, recordAudit, withTenant } from '@void-space/db';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import { ForbiddenError, NotFoundError } from '../../lib/errors';
import { parseBody, parseParams, parseQuery } from '../../lib/http';

const tenantParams = z.object({ id: z.string().uuid() });
const keyParams = z.object({ id: z.string().uuid(), keyId: z.string().uuid() });

/** FR-12.3 — creation, rotation and revocation all sit behind the §3.6 key permission. */
const MANAGE = 'apikey:manage';

export async function developerRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Every handler's second guard: the caller may manage keys only in their own active tenant.
   * A key minted for another workspace would be a cross-tenant write, so a mismatch reads as
   * "no such tenant" rather than "forbidden".
   */
  function ownTenant(principal: { tenantId: string }, pathTenantId: string): string {
    if (pathTenantId !== principal.tenantId) throw new NotFoundError('Tenant');
    return principal.tenantId;
  }

  // ------------------------------------------------------------------------- list
  app.get(
    '/tenants/:id/api-keys',
    { preHandler: app.requirePermission(MANAGE) },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const { id } = parseParams(tenantParams, request.params);
      const tenantId = ownTenant(principal, id);
      const query = parseQuery(apiKeyListQuerySchema, request.query);

      const { items, total } = await withTenant(tenantId, async (db) => {
        const [rows, total] = await Promise.all([
          db.apiKey.findMany({
            where: { tenantId },
            orderBy: { createdAt: 'desc' },
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
            include: { user: { select: { id: true, fullName: true } } },
          }),
          db.apiKey.count({ where: { tenantId } }),
        ]);

        const items: ApiKeySummary[] = rows.map((row) => ({
          id: row.id,
          label: row.label,
          prefix: row.prefix,
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt?.toISOString() ?? null,
          revokedAt: row.revokedAt?.toISOString() ?? null,
          createdBy: row.user ? { id: row.user.id, fullName: row.user.fullName } : null,
        }));
        return { items, total };
      });

      return reply.status(200).send({ items, total, page: query.page, pageSize: query.pageSize });
    },
  );

  // ----------------------------------------------------------------------- create
  app.post(
    '/tenants/:id/api-keys',
    { preHandler: app.requirePermission(MANAGE) },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const { id } = parseParams(tenantParams, request.params);
      const tenantId = ownTenant(principal, id);
      const input = parseBody(createApiKeySchema, request.body);

      const generated = generateApiKey(tenantId, 'dev');
      const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 86_400_000)
        : null;

      const created = await withTenant(tenantId, async (db) => {
        const row = await db.apiKey.create({
          data: {
            tenantId,
            userId: principal.userId,
            label: input.label,
            prefix: generated.prefix,
            hashedKey: generated.hashedKey,
            expiresAt,
          },
          select: { id: true, createdAt: true },
        });

        await recordAudit(
          {
            action: 'apikey.created',
            entityType: 'apiKey',
            entityId: row.id,
            actorId: principal.userId,
            actorLabel: `${principal.fullName} <${principal.email}>`,
            // The label and prefix are recorded; the secret is not, and never lives anywhere
            // except the response body the caller is reading right now.
            afterState: { label: input.label, prefix: generated.prefix },
          },
          db,
        );

        return row;
      });

      const body: CreatedApiKey = {
        id: created.id,
        label: input.label,
        key: generated.key,
        prefix: generated.prefix,
        createdAt: created.createdAt.toISOString(),
        expiresAt: expiresAt?.toISOString() ?? null,
      };
      return reply.status(201).send(body);
    },
  );

  // ----------------------------------------------------------------------- rotate
  app.post(
    '/tenants/:id/api-keys/:keyId/rotate',
    { preHandler: app.requirePermission(MANAGE) },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const { id, keyId } = parseParams(keyParams, request.params);
      const tenantId = ownTenant(principal, id);

      const generated = generateApiKey(tenantId, 'dev');

      const rotated = await withTenant(tenantId, async (db) => {
        const existing = await db.apiKey.findFirst({ where: { id: keyId, tenantId } });
        // An already-revoked key is not found: rotating a dead credential is a client bug, and
        // answering with a fresh secret would make revocation look reversible.
        if (!existing || existing.revokedAt) throw new NotFoundError('API key');

        // Revoke first, then issue. If the second write failed, the old key is already dead and
        // the caller has a clear "no working key" state rather than two live secrets.
        await db.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });

        const replacement = await db.apiKey.create({
          data: {
            tenantId,
            userId: principal.userId,
            label: existing.label,
            prefix: generated.prefix,
            hashedKey: generated.hashedKey,
            // Rotation does not silently extend an expiring key's life; the replacement inherits
            // the old window, so rotation cannot be used to make a short-lived key immortal.
            expiresAt: existing.expiresAt,
          },
          select: { id: true, label: true, createdAt: true, expiresAt: true },
        });

        await recordAudit(
          {
            action: 'apikey.rotated',
            entityType: 'apiKey',
            entityId: replacement.id,
            actorId: principal.userId,
            actorLabel: `${principal.fullName} <${principal.email}>`,
            beforeState: { revokedKeyId: keyId, prefix: existing.prefix },
            afterState: { label: replacement.label, prefix: generated.prefix },
          },
          db,
        );

        return replacement;
      });

      const body: CreatedApiKey = {
        id: rotated.id,
        label: rotated.label,
        key: generated.key,
        prefix: generated.prefix,
        createdAt: rotated.createdAt.toISOString(),
        expiresAt: rotated.expiresAt?.toISOString() ?? null,
      };
      return reply.status(201).send(body);
    },
  );

  // ----------------------------------------------------------------------- revoke
  app.delete(
    '/tenants/:id/api-keys/:keyId',
    { preHandler: app.requirePermission(MANAGE) },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const { id, keyId } = parseParams(keyParams, request.params);
      const tenantId = ownTenant(principal, id);

      await withTenant(tenantId, async (db) => {
        const existing = await db.apiKey.findFirst({ where: { id: keyId, tenantId } });
        if (!existing) throw new NotFoundError('API key');

        // Revoked, never deleted: an audit trail that cannot show when a credential was
        // withdrawn is not an audit trail. Re-revoking is a no-op rather than a conflict, so a
        // retried request stays safe.
        if (!existing.revokedAt) {
          const revokedAt = new Date();
          await db.apiKey.update({ where: { id: keyId }, data: { revokedAt } });
          await recordAudit(
            {
              action: 'apikey.revoked',
              entityType: 'apiKey',
              entityId: keyId,
              actorId: principal.userId,
              actorLabel: `${principal.fullName} <${principal.email}>`,
              beforeState: { label: existing.label, prefix: existing.prefix, revokedAt: null },
              afterState: { revokedAt: revokedAt.toISOString() },
            },
            db,
          );
        }
      });

      return reply.status(204).send();
    },
  );
}



