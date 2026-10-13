/**
 * Tenant administration acceptance tests: users, roles, invites, suspension and
 * the audit log (FR-1.2–1.5, FR-2.7, FR-13.1–13.2, §3.6).
 *
 * Each test creates its own throwaway workspace through `POST /auth/register`, so
 * the seeded demo tenants and their users are never mutated — a re-run is safe.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEMO,
  cookieHeader,
  createTestApp,
  login,
  removeTestTenants,
  type TestApp,
} from './helpers';

let context: TestApp;
let suffix: string;

beforeAll(async () => {
  context = await createTestApp();
  suffix = Math.random().toString(36).slice(2, 8);
});

afterAll(async () => {
  // The suite creates real workspaces through the API; leave the dev database as we found it.
  await removeTestTenants();
  await context?.close();
});

interface Registered {
  readonly tenantId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly cookies: string[];
}

/** Creates an isolated workspace whose owner is a TenantAdmin. */
async function newWorkspace(label: string): Promise<Registered> {
  const slug = `t-${label}-${suffix}`.slice(0, 60);
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      organizationName: `Test ${label} ${suffix}`,
      organizationSlug: slug,
      fullName: `Owner ${label}`,
      email: `owner-${label}-${suffix}@example.test`,
      password: 'Throwaway!Pass1',
    },
  });

  expect(response.statusCode).toBe(201);
  const setCookie = response.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const body = response.json() as { user: { activeTenantId: string } };

  return {
    tenantId: body.user.activeTenantId,
    accessToken: cookies.find((c) => c.startsWith('vs_access='))?.split(';')[0]?.slice(10) ?? '',
    refreshToken: cookies.find((c) => c.startsWith('vs_refresh='))?.split(';')[0]?.slice(11) ?? '',
    cookies,
  };
}

describe('FR-1.2/1.3 user & role administration', () => {
  it('lets a TenantAdmin list members and rejects a Creator with 403', async () => {
    const admin = await login(context.app, DEMO.users.auroraAdmin);
    const allowed = await context.app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: { cookie: cookieHeader(admin.cookies, 'vs_access') },
    });
    expect(allowed.statusCode).toBe(200);
    const users = (allowed.json() as { users: { email: string; roles: string[] }[] }).users;
    expect(users.some((user) => user.email === DEMO.users.auroraAssessor)).toBe(true);

    const creator = await login(context.app, DEMO.users.auroraCreator);
    const denied = await context.app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: { cookie: cookieHeader(creator.cookies, 'vs_access') },
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { code: string }).code).toBe('INSUFFICIENT_PERMISSION');
  });

  it('invites a new member, who accepts and signs in with the invited role', async () => {
    const workspace = await newWorkspace('invite');
    const email = `invitee-${suffix}@example.test`;

    const invited = await context.app.inject({
      method: 'POST',
      url: '/api/v1/users/invite',
      headers: { cookie: cookieHeader(workspace.cookies, 'vs_access') },
      payload: { email, fullName: 'Invited Person', role: 'Assessor' },
    });
    expect(invited.statusCode).toBe(201);
    const invite = (invited.json() as { invite: { token: string; role: string } }).invite;
    expect(invite.role).toBe('Assessor');

    // Re-inviting supersedes the pending invitation rather than leaving two live
    // tokens for the same address.
    const reInvited = await context.app.inject({
      method: 'POST',
      url: '/api/v1/users/invite',
      headers: { cookie: cookieHeader(workspace.cookies, 'vs_access') },
      payload: { email, fullName: 'Invited Person', role: 'Assessor' },
    });
    expect(reInvited.statusCode).toBe(201);
    const freshInvite = (reInvited.json() as { invite: { token: string } }).invite;

    // The superseded token is dead …
    const staleToken = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/invite/accept',
      payload: { token: invite.token, fullName: 'Invited Person', password: 'Invitee!Pass1' },
    });
    expect(staleToken.statusCode).toBe(404);

    // … and the replacement works, signing the invitee straight in.
    const accepted = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/invite/accept',
      payload: { token: freshInvite.token, fullName: 'Invited Person', password: 'Invitee!Pass1' },
    });
    expect(accepted.statusCode).toBe(201);
    const acceptedUser = (accepted.json() as { user: { email: string; roles: string[] } }).user;
    expect(acceptedUser.email).toBe(email);
    expect(acceptedUser.roles).toEqual(['Assessor']);

    // An invitation is single-use (FR-2.6).
    const replay = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/invite/accept',
      payload: { token: freshInvite.token, fullName: 'Invited Person', password: 'Invitee!Pass1' },
    });
    expect(replay.statusCode).toBe(409);
    expect((replay.json() as { code: string }).code).toBe('INVITE_ALREADY_USED');
  });

  it('revokes the affected user’s sessions when their role changes (FR-2.7)', async () => {
    const workspace = await newWorkspace('role');
    const email = `member-${suffix}@example.test`;

    const invited = await context.app.inject({
      method: 'POST',
      url: '/api/v1/users/invite',
      headers: { cookie: cookieHeader(workspace.cookies, 'vs_access') },
      payload: { email, fullName: 'Role Member', role: 'Creator' },
    });
    const inviteToken = (invited.json() as { invite: { token: string } }).invite.token;

    const accepted = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/invite/accept',
      payload: { token: inviteToken, fullName: 'Role Member', password: 'Member!Pass1' },
    });
    expect(accepted.statusCode).toBe(201);
    const memberCookies = Array.isArray(accepted.headers['set-cookie'])
      ? accepted.headers['set-cookie']
      : [accepted.headers['set-cookie'] as string];
    const memberId = (accepted.json() as { user: { id: string } }).user.id;

    const changed = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${memberId}`,
      headers: { cookie: cookieHeader(workspace.cookies, 'vs_access') },
      payload: { role: 'Assessor' },
    });
    expect(changed.statusCode).toBe(200);
    const outcome = changed.json() as { user: { roles: string[] }; sessionsRevoked: number };
    expect(outcome.user.roles).toEqual(['Assessor']);
    expect(outcome.sessionsRevoked).toBeGreaterThan(0);

    // FR-2.7: the member's existing refresh token is dead.
    const stale = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: cookieHeader(memberCookies, 'vs_refresh') },
    });
    expect(stale.statusCode).toBe(401);

    // …but they can sign in again and now hold the new role.
    const reLogin = await login(context.app, email, 'Member!Pass1');
    expect(reLogin.statusCode).toBe(200);
    expect((reLogin.body['user'] as { roles: string[] }).roles).toEqual(['Assessor']);
  });

  it('refuses to leave a workspace without an administrator', async () => {
    const workspace = await newWorkspace('lastadmin');
    const me = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookieHeader(workspace.cookies, 'vs_access') },
    });
    const myId = (me.json() as { user: { id: string } }).user.id;

    const demoteSelf = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${myId}`,
      headers: { cookie: cookieHeader(workspace.cookies, 'vs_access') },
      payload: { role: 'Viewer' },
    });
    expect(demoteSelf.statusCode).toBe(409);
    expect((demoteSelf.json() as { code: string }).code).toBe('LAST_ADMIN');

    const removeSelf = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${myId}`,
      headers: { cookie: cookieHeader(workspace.cookies, 'vs_access') },
    });
    expect(removeSelf.statusCode).toBe(409);
    expect((removeSelf.json() as { code: string }).code).toBe('CANNOT_REMOVE_SELF');
  });
});

describe('FR-1.5 workspace suspension', () => {
  it('blocks sign-in and revokes sessions, then restores access on reinstatement', async () => {
    const workspace = await newWorkspace('suspend');
    const ownerEmail = `owner-suspend-${suffix}@example.test`;

    const superAdmin = await login(context.app, DEMO.users.superAdmin);
    expect(superAdmin.statusCode).toBe(200);

    // FR-14.1 — the platform tenant list is SuperAdmin-only.
    const list = await context.app.inject({
      method: 'GET',
      url: '/api/v1/tenants',
      headers: { cookie: cookieHeader(superAdmin.cookies, 'vs_access') },
    });
    expect(list.statusCode).toBe(200);
    const tenants = (list.json() as { tenants: Record<string, unknown>[] }).tenants;
    const listed = tenants.find((tenant) => tenant.id === workspace.tenantId);
    expect(listed).toBeDefined();

    // FR-14.1 requires status, user count *and* asset count. The latter two cannot come from one
    // query: §5.3 denies the platform role the asset table, so the count is read per workspace
    // inside that workspace's own RLS context. This asserts the fan-out actually happened —
    // the field being present but always 0 is exactly the failure it would otherwise hide.
    expect(listed).toHaveProperty('userCount');
    expect(listed).toHaveProperty('assetCount');
    expect(listed).toHaveProperty('licenseCount');
    expect(typeof listed?.['userCount']).toBe('number');
    expect(typeof listed?.['assetCount']).toBe('number');

    const suspend = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/tenants/${workspace.tenantId}/status`,
      headers: { cookie: cookieHeader(superAdmin.cookies, 'vs_access') },
      payload: { status: 'suspended', reason: 'integration test' },
    });
    expect(suspend.statusCode).toBe(200);
    expect((suspend.json() as { sessionsRevoked: number }).sessionsRevoked).toBeGreaterThan(0);

    // FR-1.5 — the suspended tenant's users can neither refresh nor sign in.
    const refresh = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: cookieHeader(workspace.cookies, 'vs_refresh') },
    });
    expect(refresh.statusCode).toBe(401);

    const signIn = await login(context.app, ownerEmail, 'Throwaway!Pass1');
    expect(signIn.statusCode).toBe(403);
    expect(signIn.body['code']).toBe('TENANT_SUSPENDED');

    // Reinstate, and access comes back.
    const reinstate = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/tenants/${workspace.tenantId}/status`,
      headers: { cookie: cookieHeader(superAdmin.cookies, 'vs_access') },
      payload: { status: 'active' },
    });
    expect(reinstate.statusCode).toBe(200);

    const after = await login(context.app, ownerEmail, 'Throwaway!Pass1');
    expect(after.statusCode).toBe(200);
  });

  it('refuses tenant suspension from a TenantAdmin', async () => {
    const admin = await login(context.app, DEMO.users.auroraAdmin);
    const response = await context.app.inject({
      method: 'PATCH',
      url: `/api/v1/tenants/${'00000000-0000-4000-8000-000000000001'}/status`,
      headers: { cookie: cookieHeader(admin.cookies, 'vs_access') },
      payload: { status: 'suspended' },
    });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('INSUFFICIENT_PERMISSION');
  });
});

describe('FR-13.1 audit log', () => {
  it('records workspace, invite and auth events for a TenantAdmin to read', async () => {
    const workspace = await newWorkspace('audit');

    const invited = await context.app.inject({
      method: 'POST',
      url: '/api/v1/users/invite',
      headers: { cookie: cookieHeader(workspace.cookies, 'vs_access') },
      payload: {
        email: `member-${suffix}-audit@example.test`,
        fullName: 'Audit Member',
        role: 'Creator',
      },
    });
    expect(invited.statusCode).toBe(201);

    const log = await context.app.inject({
      method: 'GET',
      url: '/api/v1/audit?pageSize=100',
      headers: { cookie: cookieHeader(workspace.cookies, 'vs_access') },
    });
    expect(log.statusCode).toBe(200);
    const body = log.json() as {
      items: { action: string }[];
      actions: string[];
      total: number;
      page: number;
    };

    const recorded = body.items.map((item) => item.action);
    expect(recorded).toContain('auth.register');
    expect(recorded).toContain('tenant.created');
    expect(recorded).toContain('tenant.user_invited');
    expect(body.actions).toContain('auth.register');
    expect(body.page).toBe(1);

    // Filters are applied server-side and stay within the tenant.
    const filtered = await context.app.inject({
      method: 'GET',
      url: '/api/v1/audit?action=tenant.user_invited',
      headers: { cookie: cookieHeader(workspace.cookies, 'vs_access') },
    });
    expect(filtered.statusCode).toBe(200);
    const filteredBody = filtered.json() as { items: { action: string }[]; total: number };
    expect(filteredBody.total).toBeGreaterThan(0);
    expect(filteredBody.items.every((item) => item.action === 'tenant.user_invited')).toBe(true);
  });

  it('keeps the audit log away from roles without audit:view', async () => {
    const creator = await login(context.app, DEMO.users.auroraCreator);
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/audit',
      headers: { cookie: cookieHeader(creator.cookies, 'vs_access') },
    });
    expect(response.statusCode).toBe(403);
  });

  it('never leaks another tenant’s entries (NFR-SEC.5)', async () => {
    const workspace = await newWorkspace('isolated');

    // The seeded Aurora tenant has plenty of audit rows; none may appear here.
    const log = await context.app.inject({
      method: 'GET',
      url: '/api/v1/audit?pageSize=100',
      headers: { cookie: cookieHeader(workspace.cookies, 'vs_access') },
    });
    const body = log.json() as { items: { tenantId: string | null }[] };

    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item.tenantId).toBe(workspace.tenantId);
    }
  });
});

