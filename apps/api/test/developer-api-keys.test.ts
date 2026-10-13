/**
 * FR-12.3 — API key management.
 *
 * `api-keys.test.ts` covers the *exchange* half of the story (FR-2.5) with keys built by the
 * `generateApiKey` helper. This suite exercises the management routes, which until now did not
 * exist — a key could only be minted by the seed script, which printed it to a terminal.
 *
 * The property worth guarding is the one NFR-SEC.7 names: the secret is returned at creation
 * and is *unreachable* afterwards.
 *
 * Every workspace id comes from `DEMO_TENANT_IDS` rather than a literal, for the same reason the
 * seed derives them — a hard-coded UUID silently stops testing anything if the seed changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '@void-space/db';

import {
  DEMO,
  DEMO_TENANT_IDS,
  cookieHeader,
  createTestApp,
  login,
  type TestApp,
} from './helpers';

let context: TestApp;

beforeAll(async () => {
  context = await createTestApp();
});

afterAll(async () => {
  await context?.close();
});

describe('FR-12.3 API-key management', () => {
  /** Creates a key through the API and returns the raw secret with its id. */
  async function issueKey(
    cookies: string,
    tenantId: string,
    label: string,
  ): Promise<{ id: string; key: string }> {
    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/api-keys`,
      headers: { cookie: cookies },
      payload: { label },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; key: string; prefix: string };
    // The raw key is well-formed and identifies its tenant, which is what lets the exchange
    // endpoint resolve it without a cross-tenant lookup.
    expect(body.key.startsWith('vs_')).toBe(true);
    expect(body.prefix.length).toBeGreaterThan(0);
    expect(body.key.startsWith(body.prefix)).toBe(true);
    return { id: body.id, key: body.key };
  }

  async function dropKey(tenantId: string, id: string): Promise<void> {
    await withTenant(tenantId, (db) => db.apiKey.delete({ where: { id } }));
  }

  async function adminCookies(email: string): Promise<{ cookies: string }> {
    const session = await login(context.app, email);
    return { cookies: cookieHeader(session.cookies, 'vs_access', 'vs_refresh') };
  }

  it('creates a key that authenticates, and never exposes the secret again', async () => {
    const { cookies } = await adminCookies(DEMO.users.auroraAdmin);
    const tenantId = DEMO_TENANT_IDS.aurora;

    const { id, key } = await issueKey(cookies, tenantId, 'created via API');
    try {
      // It works.
      const exchange = await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/token',
        payload: { apiKey: key },
      });
      expect(exchange.statusCode).toBe(200);
      expect((exchange.json() as { tokenType: string }).tokenType).toBe('Bearer');

      // And the secret is gone from every subsequent read.
      const list = await context.app.inject({
        method: 'GET',
        url: `/api/v1/tenants/${tenantId}/api-keys`,
        headers: { cookie: cookies },
      });
      expect(list.statusCode).toBe(200);
      const listed = list.json() as { items: readonly Record<string, unknown>[] };
      const row = listed.items.find((entry) => entry.id === id);
      expect(row).toBeDefined();
      expect(row).toHaveProperty('prefix');
      expect(row).not.toHaveProperty('key');
      expect(row).not.toHaveProperty('hashedKey');
      expect(JSON.stringify(listed)).not.toContain(key);
    } finally {
      await dropKey(tenantId, id);
    }
  });

  it('rotation invalidates the old secret and issues a working replacement', async () => {
    const { cookies } = await adminCookies(DEMO.users.auroraAdmin);
    const tenantId = DEMO_TENANT_IDS.aurora;

    const original = await issueKey(cookies, tenantId, 'rotate me');
    let replacementId: string | null = null;

    try {
      const rotated = await context.app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${tenantId}/api-keys/${original.id}/rotate`,
        headers: { cookie: cookies },
      });
      expect(rotated.statusCode).toBe(201);
      const next = rotated.json() as { id: string; key: string; label: string };
      replacementId = next.id;
      expect(next.key).not.toBe(original.key);
      // The label is inherited, so a rotated key is still recognisable in the list.
      expect(next.label).toBe('rotate me');

      const oldExchange = await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/token',
        payload: { apiKey: original.key },
      });
      expect(oldExchange.statusCode).toBe(401);
      expect((oldExchange.json() as { code: string }).code).toBe('API_KEY_INVALID');

      const newExchange = await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/token',
        payload: { apiKey: next.key },
      });
      expect(newExchange.statusCode).toBe(200);

      // A dead credential cannot be rotated into life again.
      const again = await context.app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${tenantId}/api-keys/${original.id}/rotate`,
        headers: { cookie: cookies },
      });
      expect(again.statusCode).toBe(404);
    } finally {
      await dropKey(tenantId, original.id);
      if (replacementId) await dropKey(tenantId, replacementId);
    }
  });

  it('revocation is immediate, idempotent, and keeps the row for the audit trail', async () => {
    const { cookies } = await adminCookies(DEMO.users.auroraAdmin);
    const tenantId = DEMO_TENANT_IDS.aurora;

    const { id, key } = await issueKey(cookies, tenantId, 'revoke me');
    try {
      const first = await context.app.inject({
        method: 'DELETE',
        url: `/api/v1/tenants/${tenantId}/api-keys/${id}`,
        headers: { cookie: cookies },
      });
      expect(first.statusCode).toBe(204);

      // A repeated revoke is a no-op, not a 409 — a retried request must stay safe.
      const second = await context.app.inject({
        method: 'DELETE',
        url: `/api/v1/tenants/${tenantId}/api-keys/${id}`,
        headers: { cookie: cookies },
      });
      expect(second.statusCode).toBe(204);

      const exchange = await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/token',
        payload: { apiKey: key },
      });
      expect(exchange.statusCode).toBe(401);

      // Revoked, not deleted: the trail survives.
      const stillThere = await withTenant(tenantId, (db) =>
        db.apiKey.findUnique({ where: { id }, select: { revokedAt: true } }),
      );
      expect(stillThere?.revokedAt).not.toBeNull();
    } finally {
      await dropKey(tenantId, id);
    }
  });

  it('refuses to manage keys in a workspace the caller is not in', async () => {
    const { cookies } = await adminCookies(DEMO.users.auroraAdmin);

    // Aurora's admin naming Northwind's workspace: a 404, because confirming that the
    // workspace exists would itself be a disclosure.
    const response = await context.app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${DEMO_TENANT_IDS.northwind}/api-keys`,
      headers: { cookie: cookies },
      payload: { label: 'cross-tenant attempt' },
    });
    expect(response.statusCode).toBe(404);

    // And the northbound read is closed too, so the list cannot be enumerated either.
    const list = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${DEMO_TENANT_IDS.northwind}/api-keys`,
      headers: { cookie: cookies },
    });
    expect(list.statusCode).toBe(404);
  });

  it('gates management on apikey:manage, not merely on being logged in', async () => {
    const tenantId = DEMO_TENANT_IDS.aurora;

    // A Creator holds upload and catalogue rights but not key management (§3.6).
    const creator = await login(context.app, DEMO.users.auroraCreator);
    const denied = await context.app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/api-keys`,
      headers: { cookie: cookieHeader(creator.cookies, 'vs_access', 'vs_refresh') },
      payload: { label: 'should not exist' },
    });
    expect(denied.statusCode).toBe(403);

    // A Developer does hold it, which is the whole point of the role.
    const developer = await login(context.app, DEMO.users.auroraDeveloper);
    const allowed = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenantId}/api-keys`,
      headers: { cookie: cookieHeader(developer.cookies, 'vs_access', 'vs_refresh') },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('records key lifecycle events in the audit log (FR-13.1)', async () => {
    const { cookies } = await adminCookies(DEMO.users.auroraAdmin);
    const tenantId = DEMO_TENANT_IDS.aurora;

    const { id } = await issueKey(cookies, tenantId, 'audited');
    try {
      await context.app.inject({
        method: 'DELETE',
        url: `/api/v1/tenants/${tenantId}/api-keys/${id}`,
        headers: { cookie: cookies },
      });

      const actions = await withTenant(tenantId, (db) =>
        db.auditLog.findMany({
          where: { entityType: 'apiKey', entityId: id },
          select: { action: true, actorId: true },
          orderBy: { createdAt: 'asc' },
        }),
      );
      expect(actions.map((row) => row.action)).toEqual(['apikey.created', 'apikey.revoked']);
      // An actor is always recorded — an unattributed credential change is not auditable.
      expect(actions.every((row) => row.actorId !== null)).toBe(true);
    } finally {
      await dropKey(tenantId, id);
    }
  });
});

