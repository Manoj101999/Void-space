/**
 * FR-2.5 — machine-to-machine authentication with Developer API keys.
 *
 * Keys are created through the same `generateApiKey` helper the seed and the
 * Developer settings UI use, so this suite also guards the key format and the
 * tenant-scoped lookup (resolving a key must never need cross-tenant access).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateApiKey, withPlatform, withTenant } from '@void-space/db';

import { DEMO, createTestApp, login, type TestApp } from './helpers';

let context: TestApp;

beforeAll(async () => {
  context = await createTestApp();
});

afterAll(async () => {
  await context?.close();
});

/** The seeded Developer in Aurora (owner of the printed demo key). */
async function developer(): Promise<{ userId: string; tenantId: string }> {
  const row = await withPlatform((db) =>
    db.user.findFirst({
      where: { email: DEMO.users.auroraDeveloper },
      select: { id: true, tenantId: true },
    }),
  );
  if (!row) throw new Error('Seed the database first (pnpm db:seed)');
  return { userId: row.id, tenantId: row.tenantId };
}

async function createKey(label: string): Promise<{
  key: string;
  id: string;
  tenantId: string;
  userId: string;
}> {
  const { userId, tenantId } = await developer();
  const generated = generateApiKey(tenantId, 'test');
  const created = await withTenant(tenantId, (db) =>
    db.apiKey.create({
      data: { tenantId, userId, label, prefix: generated.prefix, hashedKey: generated.hashedKey },
      select: { id: true },
    }),
  );
  return { key: generated.key, id: created.id, tenantId, userId };
}

async function deleteKey(id: string, tenantId: string): Promise<void> {
  await withTenant(tenantId, (db) => db.apiKey.delete({ where: { id } }));
}

describe('FR-2.5 API-key tokens', () => {
  it('TC-AUTH-005 exchanges a key for a short-lived token scoped to Developer', async () => {
    const { key, id, tenantId } = await createKey('integration test key');

    try {
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/token',
        payload: { apiKey: key },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        accessToken: string;
        tokenType: string;
        expiresIn: number;
        user: { roles: string[] };
      };
      expect(body.tokenType).toBe('Bearer');
      expect(body.expiresIn).toBeLessThanOrEqual(900);
      expect(body.user.roles).toEqual(['Developer']);

      const [, payload] = body.accessToken.split('.');
      const claims = JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8')) as {
        roles: string[];
        perms: string[];
        amr: string;
        kid?: string;
      };
      expect(claims.amr).toBe('apikey');
      expect(claims.kid).toBe(id);
      expect(claims.roles).toEqual(['Developer']);
      // FR-2.5 — exactly the Developer role's permission set (§3.6), nothing more.
      expect([...claims.perms].sort()).toEqual(['api:call', 'apikey:manage', 'catalog:view']);
      expect(claims.perms).not.toContain('tenant:manage');
      expect(claims.perms).not.toContain('audit:view');
      expect(claims.perms).not.toContain('asset:upload-own');

      // The bearer token authenticates subsequent calls.
      const me = await context.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      expect(me.statusCode).toBe(200);
      expect((me.json() as { authMethod: string }).authMethod).toBe('apikey');

      // A Developer cannot read the audit log (403 per the §3.6 matrix).
      const denied = await context.app.inject({
        method: 'GET',
        url: '/api/v1/__test/permission/audit',
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      expect(denied.statusCode).toBe(403);
    } finally {
      await deleteKey(id, tenantId);
    }
  });

  it('records lastUsedAt so dormant keys are visible in the UI', async () => {
    const { key, id, tenantId } = await createKey('dormancy check');

    try {
      const before = await withTenant(tenantId, (db) =>
        db.apiKey.findUnique({ where: { id }, select: { lastUsedAt: true } }),
      );
      expect(before?.lastUsedAt).toBeNull();

      await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/token',
        payload: { apiKey: key },
      });

      const after = await withTenant(tenantId, (db) =>
        db.apiKey.findUnique({ where: { id }, select: { lastUsedAt: true } }),
      );
      expect(after?.lastUsedAt).not.toBeNull();
    } finally {
      await deleteKey(id, tenantId);
    }
  });

  it('rejects a revoked key', async () => {
    const { key, id, tenantId } = await createKey('revoked key');

    await withTenant(tenantId, (db) =>
      db.apiKey.update({ where: { id }, data: { revokedAt: new Date() } }),
    );

    try {
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/token',
        payload: { apiKey: key },
      });
      expect(response.statusCode).toBe(401);
      expect((response.json() as { code: string }).code).toBe('API_KEY_INVALID');
    } finally {
      await deleteKey(id, tenantId);
    }
  });

  it('rejects an expired key', async () => {
    const { userId, tenantId } = await developer();
    const generated = generateApiKey(tenantId, 'test');
    const created = await withTenant(tenantId, (db) =>
      db.apiKey.create({
        data: {
          tenantId,
          userId,
          label: 'expired key',
          prefix: generated.prefix,
          hashedKey: generated.hashedKey,
          expiresAt: new Date(Date.now() - 60_000),
        },
        select: { id: true },
      }),
    );

    try {
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/token',
        payload: { apiKey: generated.key },
      });
      expect(response.statusCode).toBe(401);
      expect((response.json() as { code: string }).code).toBe('API_KEY_EXPIRED');
    } finally {
      await deleteKey(created.id, tenantId);
    }
  });

  it('rejects unknown and malformed keys', async () => {
    const { tenantId } = await developer();

    const unknown = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: { apiKey: generateApiKey(tenantId, 'test').key },
    });
    expect(unknown.statusCode).toBe(401);
    expect((unknown.json() as { code: string }).code).toBe('API_KEY_INVALID');

    const malformed = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: { apiKey: 'vs_not-a-real-key-at-all-really' },
    });
    expect(malformed.statusCode).toBe(401);
    expect((malformed.json() as { code: string }).code).toBe('API_KEY_MALFORMED');
  });

  it('never falls back to a cookie when an explicit Authorization header is bad', async () => {
    // An Aurora Viewer's cookie must not be quietly substituted for the malformed
    // credential the client presented (no confused-deputy fallback).
    const viewer = await login(context.app, DEMO.users.auroraViewer);
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/__test/permission/audit',
      headers: {
        cookie: `vs_access=${viewer.accessToken}`,
        authorization: 'Bearer vs_not-a-real-key-at-all-really',
      },
    });

    expect(response.statusCode).toBe(401);
    expect((response.json() as { code: string }).code).toBe('TOKEN_INVALID');
  });
});
