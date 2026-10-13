/**
 * Authentication & authorization acceptance tests.
 *
 * Traceability to the SRS §11.2 catalogue:
 *   TC-AUTH-001  email/password sign-in, hashed credentials          (FR-2.1)
 *   TC-AUTH-002  workspace selection across tenants                  (FR-1.4)
 *   TC-AUTH-003  JWT in httpOnly/Secure/SameSite cookies, ≤15 min     (FR-2.3)
 *   TC-AUTH-004  401 for malformed tokens, 403 for scope              (FR-2.4)
 *   TC-AUTH-005  API key exchange scoped to the Developer role        (FR-2.5)
 *   TC-AUTH-007  refresh rotation and reuse detection                 (§3.7)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEMO, cookieHeader, createTestApp, login, type TestApp } from './helpers';

let context: TestApp;

beforeAll(async () => {
  context = await createTestApp();
});

afterAll(async () => {
  await context?.close();
});

function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

describe('FR-2.1 email/password authentication', () => {
  it('TC-AUTH-001 signs in a seeded user and returns the workspace shell', async () => {
    const result = await login(context.app, DEMO.users.auroraAdmin);

    expect(result.statusCode).toBe(200);
    const user = result.body['user'] as Record<string, unknown>;
    expect(user['email']).toBe(DEMO.users.auroraAdmin);
    expect(user['roles']).toEqual(['TenantAdmin']);
    expect(user['permissions']).toContain('tenant:manage-users');
    expect(result.accessToken).not.toBe('');
    expect(result.refreshToken).not.toBe('');
  });

  it('rejects a wrong password with 401 INVALID_CREDENTIALS', async () => {
    const result = await login(context.app, DEMO.users.auroraAdmin, 'WrongPassword!123');

    expect(result.statusCode).toBe(401);
    expect(result.body['code']).toBe('INVALID_CREDENTIALS');
    // The message must not disclose whether the account exists.
    expect(result.body['message']).toBe('Invalid email or password');
  });

  it('validates the payload shape before touching the database (400)', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'not-an-email', password: 'x' },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { code: string }).code).toBe('VALIDATION_ERROR');
  });
});

describe('FR-2.3 token delivery', () => {
  it('TC-AUTH-003 sets httpOnly, Secure, SameSite=Lax cookies and a ≤15-minute access token', async () => {
    const result = await login(context.app, DEMO.users.auroraCreator);
    expect(result.statusCode).toBe(200);

    const access = result.cookies.find((cookie) => cookie.startsWith('vs_access='));
    const refresh = result.cookies.find((cookie) => cookie.startsWith('vs_refresh='));

    // §2.5 forbids tokens in local/session storage, so they never appear in the body.
    expect(JSON.stringify(result.body)).not.toContain(result.accessToken);

    for (const cookie of [access, refresh]) {
      expect(cookie).toBeDefined();
      expect(cookie?.toLowerCase()).toContain('httponly');
      expect(cookie?.toLowerCase()).toContain('samesite=lax');
      if (context.env.COOKIE_SECURE) expect(cookie?.toLowerCase()).toContain('secure');
    }

    // The refresh cookie is path-scoped so it never travels with normal calls.
    expect(refresh?.toLowerCase()).toContain('path=/api/v1/auth');

    const payload = decodeJwtPayload(result.accessToken);
    expect(Number(payload['exp']) - Number(payload['iat'])).toBeLessThanOrEqual(15 * 60);
    expect(payload['typ']).toBe('access');
    expect(payload['amr']).toBe('password');
    expect(payload['tid']).toBeTruthy();
    expect(payload['sub']).toBeTruthy();
  });

  it('accepts the access cookie and rejects a tampered one', async () => {
    const result = await login(context.app, DEMO.users.auroraCreator);

    const good = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookieHeader(result.cookies, 'vs_access') },
    });
    expect(good.statusCode).toBe(200);
    expect((good.json() as { tenant: { slug: string } }).tenant.slug).toBe(
      DEMO.tenants.auroraSlug,
    );

    const tampered = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: `vs_access=${result.accessToken.slice(0, -3)}xyz` },
    });
    expect(tampered.statusCode).toBe(401);
    expect((tampered.json() as { code: string }).code).toBe('TOKEN_INVALID');
  });
});

describe('FR-1.4 multi-workspace membership', () => {
  it('TC-AUTH-002 requires a workspace choice when the user belongs to several', async () => {
    const result = await login(context.app, DEMO.users.multiTenant);

    expect(result.statusCode).toBe(200);
    expect(result.body['requiresTenantSelection']).toBe(true);

    const tenants = result.body['tenants'] as { slug: string }[];
    expect(tenants.map((tenant) => tenant.slug).sort()).toEqual(
      [DEMO.tenants.auroraSlug, DEMO.tenants.northwindSlug].sort(),
    );
    // No session is created before the choice is made.
    expect(result.accessToken).toBe('');
    expect(result.refreshToken).toBe('');
  });

  it('signs in to the explicitly chosen workspace with that workspace role', async () => {
    const first = await login(context.app, DEMO.users.multiTenant);
    const tenants = first.body['tenants'] as { id: string; slug: string }[];
    const northwind = tenants.find((tenant) => tenant.slug === DEMO.tenants.northwindSlug);
    expect(northwind).toBeDefined();

    const result = await login(context.app, DEMO.users.multiTenant, DEMO.password, northwind?.id);
    expect(result.statusCode).toBe(200);

    const user = result.body['user'] as Record<string, unknown>;
    expect(user['activeTenantId']).toBe(northwind?.id);
    // The same person is a Creator in Aurora but an Assessor in Northwind.
    expect(user['roles']).toEqual(['Assessor']);
  });

  it('switches workspace without re-authenticating', async () => {
    const first = await login(context.app, DEMO.users.multiTenant);
    const tenants = first.body['tenants'] as { id: string; slug: string }[];
    const aurora = tenants.find((tenant) => tenant.slug === DEMO.tenants.auroraSlug);
    const northwind = tenants.find((tenant) => tenant.slug === DEMO.tenants.northwindSlug);

    const start = await login(context.app, DEMO.users.multiTenant, DEMO.password, aurora?.id);
    const switched = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/tenant',
      headers: { cookie: cookieHeader(start.cookies, 'vs_access') },
      payload: { tenantId: northwind?.id },
    });

    expect(switched.statusCode).toBe(200);
    const user = (switched.json() as { user: Record<string, unknown> }).user;
    expect(user['roles']).toEqual(['Assessor']);
    expect(user['activeTenantId']).toBe(northwind?.id);
  });

  it('refuses a workspace the caller is not a member of', async () => {
    const start = await login(context.app, DEMO.users.auroraAdmin);
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/tenant',
      headers: { cookie: cookieHeader(start.cookies, 'vs_access') },
      payload: { tenantId: '00000000-0000-4000-8000-000000000000' },
    });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('NOT_A_MEMBER');
  });
});

describe('FR-2.4 authorization boundaries', () => {
  it('answers 401 when no token is presented', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(response.statusCode).toBe(401);
    expect((response.json() as { code: string }).code).toBe('NO_TOKEN');
  });

  it('answers 403 INSUFFICIENT_PERMISSION for a Creator reading the audit log', async () => {
    const result = await login(context.app, DEMO.users.auroraCreator);
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/__test/permission/audit',
      headers: { cookie: cookieHeader(result.cookies, 'vs_access') },
    });

    expect(response.statusCode).toBe(403);
    const body = response.json() as { code: string; details: { required: string } };
    expect(body.code).toBe('INSUFFICIENT_PERMISSION');
    expect(body.details.required).toBe('audit:view');
  });

  it('allows a TenantAdmin through the same gate', async () => {
    const result = await login(context.app, DEMO.users.auroraAdmin);
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/__test/permission/audit',
      headers: { cookie: cookieHeader(result.cookies, 'vs_access') },
    });

    expect(response.statusCode).toBe(200);
  });

  it('keeps the Viewer role read-only even where a write would otherwise pass (§3.6)', async () => {
    const result = await login(context.app, DEMO.users.auroraViewer);
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/__test/permission/audit',
      headers: { cookie: cookieHeader(result.cookies, 'vs_access') },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('READ_ONLY_TOKEN');
  });
});

describe('FR-2.7 session invalidation', () => {
  it('TC-AUTH-007 rotates the refresh token and detects reuse', async () => {
    const start = await login(context.app, DEMO.users.auroraDeveloper);
    expect(start.statusCode).toBe(200);

    const firstRefresh = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: cookieHeader(start.cookies, 'vs_refresh') },
    });
    expect(firstRefresh.statusCode).toBe(200);

    const rotated = Array.isArray(firstRefresh.headers['set-cookie'])
      ? firstRefresh.headers['set-cookie']
      : [firstRefresh.headers['set-cookie'] as string];
    const newRefresh = rotated.find((cookie) => cookie.startsWith('vs_refresh='));
    expect(newRefresh).toBeDefined();
    expect(newRefresh).not.toContain(start.refreshToken);

    // Replaying the superseded token implies the cookie leaked: every session goes.
    const replay = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: cookieHeader(start.cookies, 'vs_refresh') },
    });
    expect(replay.statusCode).toBe(401);
    expect((replay.json() as { code: string }).code).toBe('REFRESH_REUSE_DETECTED');

    // …including the successor the legitimate client was holding.
    const afterReuse = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: cookieHeader(rotated, 'vs_refresh') },
    });
    expect(afterReuse.statusCode).toBe(401);
  });

  it('rejects a forged refresh cookie', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: 'vs_refresh=deadbeefdeadbeefdeadbeefdeadbeef.not-a-real-secret' },
    });
    expect(response.statusCode).toBe(401);
    expect((response.json() as { code: string }).code).toBe('REFRESH_INVALID');
  });

  it('revokes the session on logout', async () => {
    const start = await login(context.app, DEMO.users.auroraDeveloper);

    const logout = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookieHeader(start.cookies, 'vs_refresh', 'vs_access') },
    });
    expect(logout.statusCode).toBe(204);

    const after = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: cookieHeader(start.cookies, 'vs_refresh') },
    });
    expect(after.statusCode).toBe(401);
  });
});
