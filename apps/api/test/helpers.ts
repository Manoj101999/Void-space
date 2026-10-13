/**
 * Integration test harness.
 *
 * Builds the *real* application (same plugins, same guards, same database) and
 * drives it through `app.inject()`, so a test that passes here exercises the
 * shipping code path rather than a mock of it. The dockerized Postgres must be up
 * and seeded (`pnpm dev:up` / `pnpm db:seed`).
 */
import { demoId, withPlatform, withTenant } from '@void-space/db';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app';
import { loadEnv, type ApiEnv } from '../src/env';

export const DEMO = {
  password: 'VoidSpace!2026',
  tenants: {
    platformSlug: 'void-space-platform',
    auroraSlug: 'aurora-industrial',
    northwindSlug: 'northwind-safety',
  },
  users: {
    superAdmin: 'superadmin@void-space.dev',
    auroraAdmin: 'admin@aurora.dev',
    auroraCreator: 'creator@aurora.dev',
    auroraAssessor: 'assessor@aurora.dev',
    auroraDeveloper: 'developer@aurora.dev',
    auroraViewer: 'viewer@aurora.dev',
    northwindAdmin: 'admin@northwind.dev',
    /** Present in both Aurora and Northwind — exercises FR-1.4. */
    multiTenant: 'priya@void-space.dev',
  },
} as const;

/**
 * Deterministic demo tenant ids.
 *
 * The seed derives ids from names (`demoId('tenant:aurora')`) so re-running it is idempotent;
 * tests reuse the same derivation rather than hard-coding UUIDs.
 */
export const DEMO_TENANT_IDS = {
  platform: demoId('tenant:platform'),
  aurora: demoId('tenant:aurora'),
  northwind: demoId('tenant:northwind'),
} as const;

export interface TestApp {
  readonly app: FastifyInstance;
  readonly env: ApiEnv;
  close(): Promise<void>;
}

/** Boots the API against the real database, with a probe route for RBAC checks. */
export async function createTestApp(): Promise<TestApp> {
  const env = loadEnv({ ...process.env, NODE_ENV: 'test' });
  const app = await buildApp(env);

  // A route that throws a known AppError, so tests can assert the error envelope
  // (a root-registered route, mirroring how every feature module is mounted).
  app.get('/api/v1/__test/probe-errors', async () => {
    const { ValidationError } = await import('../src/lib/errors');
    throw new ValidationError('probe failure', { from: 'probe' });
  });

  // A route that exists only in tests: it lets us assert the §3.6 permission
  // gate (403 paths) without depending on a Phase-4 business endpoint.
  app.get(
    '/api/v1/__test/permission/audit',
    { preHandler: app.requirePermission('audit:view') },
    async () => ({ ok: true }),
  );
  app.post(
    '/api/v1/__test/permission/audit',
    { preHandler: app.requirePermission('audit:view') },
    async () => ({ ok: true }),
  );

  await app.ready();

  return {
    app,
    env,
    close: async () => {
      await app.close();
    },
  };
}

/** Extracts a cookie value from a response's Set-Cookie header(s). */
export function readCookie(setCookie: string[] | string | undefined, name: string): string | null {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const header of headers) {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(header);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

/** Returns the raw `name=value` form, suitable for the `cookie` request header. */
export function cookieHeader(
  setCookie: string[] | string | undefined,
  ...names: string[]
): string {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const parts: string[] = [];
  for (const name of names) {
    for (const header of headers) {
      if (header.startsWith(`${name}=`)) {
        parts.push(header.split(';')[0] as string);
        break;
      }
    }
  }
  return parts.join('; ');
}

export interface LoginResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
  readonly cookies: string[];
  readonly accessToken: string;
  readonly refreshToken: string;
}

/** Logs a demo user in and returns the tokens that the cookies carry. */
export async function login(
  app: FastifyInstance,
  email: string,
  password: string = DEMO.password,
  tenantId?: string,
): Promise<LoginResult> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password, ...(tenantId ? { tenantId } : {}) },
  });

  const setCookie = response.headers['set-cookie'];
  return {
    statusCode: response.statusCode,
    body: response.json() as Record<string, unknown>,
    cookies: Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [],
    accessToken: readCookie(setCookie, 'vs_access') ?? '',
    refreshToken: readCookie(setCookie, 'vs_refresh') ?? '',
  };
}

/**
 * Asset names the acceptance tests create.
 *
 * The suite drives real multipart uploads against the development database, so without a
 * teardown every run leaves fixtures behind — inflating the dashboard's totals and filling the
 * library with rows like "Test Helmet 4f2a1c".
 */
const TEST_ASSET_NAME_PREFIXES = [
  'Test Helmet ',
  'Draft ',
  'Explicit false ',
  'Licence gate ',
  'Malicious',
  'Mislabelled',
  'Wrong category',
  'No file',
  'Viewer upload',
  'Bad file',
] as const;

/**
 * Deletes the assets created by a test run. Related versions, review comments, decisions and
 * licences cascade away with them.
 *
 * Jobs are deleted explicitly, because they do not cascade: `Job.entityId` is a loose varchar
 * rather than a foreign key, so an asset's queued ingest outlives the asset. Left behind, the
 * worker picks the job up, finds no such version, and records a failure — putting permanent red
 * in the dashboard's queue telemetry for work that was simply moot.
 *
 * Audit rows are intentionally left in place: `audit_logs` is append-only by database grant, and
 * the ledger should record that the work really happened.
 */
export async function removeTestAssets(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (db) => {
    const doomed = await db.asset.findMany({
      where: {
        OR: TEST_ASSET_NAME_PREFIXES.map((prefix) => ({ name: { startsWith: prefix } })),
      },
      select: { id: true, versions: { select: { id: true } } },
    });
    if (doomed.length === 0) return 0;

    // The subjects a queued job may point at: the asset itself, or any of its versions.
    const entityIds = doomed.flatMap((asset) => [
      asset.id,
      ...asset.versions.map((version) => version.id),
    ]);

    await db.job.deleteMany({ where: { entityId: { in: entityIds } } });

    const removed = await db.asset.deleteMany({ where: { id: { in: doomed.map((a) => a.id) } } });
    return removed.count;
  });
}

/**
 * Removes the passwordless accounts the SIWE suite creates.
 *
 * `Wallet.user` is `onDelete: SetNull` deliberately — a minted licence may reference the address,
 * so the wallet outlives the account. That means deleting the user alone leaves the wallet behind,
 * and the member list keeps showing "Wallet Only" entries after every test run. Cleanup therefore
 * removes both.
 */
export async function removeWalletOnlyTestUsers(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (db) => {
    const users = await db.user.findMany({
      where: { email: { startsWith: 'wallet-only-' } },
      select: { id: true },
    });
    if (users.length === 0) return 0;

    const ids = users.map((user) => user.id);
    await db.wallet.deleteMany({ where: { userId: { in: ids } } });
    const removed = await db.user.deleteMany({ where: { id: { in: ids } } });
    return removed.count;
  });
}

/**
 * Names the suites give the workspaces they create.
 *
 * Tenants carry no test marker, so cleanup matches these prefixes rather than hard-coding ids.
 */
const TEST_TENANT_NAME_PREFIXES = ['Test ', 'SSO Workspace ', 'No Cookie Inc', 'Wrong Token Inc'];

/**
 * Removes workspaces created by the acceptance suite, with everything that cascades from them.
 *
 * Tenant creation is a first-class feature, so the suites that exercise it were leaving a
 * workspace (and its members) behind on every run — 111 of them had accumulated in the dev
 * database, inflating the platform member count and cluttering the admin console.
 *
 * `audit_logs.tenant` is `onDelete: SetNull`, so the ledger survives: rows are detached, not
 * deleted, which is the behaviour the append-only requirement wants anyway.
 *
 * Deletion happens *inside each tenant's own context* rather than through the platform role: the
 * `tenants` policy admits a row matching the current tenant, so this path needs no extra
 * privilege — the same fail-closed guarantee the rest of the system relies on.
 */
export async function removeTestTenants(): Promise<number> {
  const candidates = await withPlatform((db) =>
    db.tenant.findMany({
      where: {
        OR: TEST_TENANT_NAME_PREFIXES.map((prefix) => ({ name: { startsWith: prefix } })),
      },
      select: { id: true },
    }),
  );

  let removed = 0;
  for (const tenant of candidates) {
    try {
      await withTenant(tenant.id, (db) => db.tenant.delete({ where: { id: tenant.id } }));
      removed += 1;
    } catch {
      // A workspace the suite created but could not finish cleaning (e.g. it suspended itself)
      // must not turn a passing suite into a failing one.
      continue;
    }
  }
  return removed;
}
