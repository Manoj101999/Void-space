/**
 * Prisma client instances (SRS §3.5, §5.3).
 *
 * Two pools exist, deliberately:
 *
 *  - `prisma`         connects as `void_app` (DATABASE_URL). Row-Level Security
 *                     applies to every tenant-scoped table, so this client may
 *                     ONLY be used inside `withTenant(...)`.
 *  - `platformPrisma` connects as `void_platform` (PLATFORM_DATABASE_URL). It has
 *                     BYPASSRLS but table privileges only on tenants, roles,
 *                     users, user_roles, wallets and invites — never on asset,
 *                     review, licence, job, notification or audit data (§5.3).
 *                     Use it exclusively through `withPlatform(...)`, which is
 *                     intended for identity resolution at login, workspace
 *                     listing and SuperAdmin tenant administration.
 */
import { PrismaClient } from '../generated/client';

const globalForPrisma = globalThis as unknown as {
  __voidSpacePrisma?: PrismaClient;
  __voidSpacePlatformPrisma?: PrismaClient;
};

function buildClient(url: string | undefined, label: string): PrismaClient {
  if (!url) {
    throw new Error(
      `[db] ${label} is not set. Copy .env.example to .env (see SRS §9.4) and re-run.`,
    );
  }
  return new PrismaClient({
    datasources: { db: { url } },
    log:
      process.env.PRISMA_LOG_QUERIES === 'true'
        ? [{ emit: 'stdout', level: 'query' }, { emit: 'stdout', level: 'warn' }]
        : [{ emit: 'stdout', level: 'warn' }, { emit: 'stdout', level: 'error' }],
  });
}

/** Runtime client: subject to RLS. Use inside `withTenant(...)` only. */
export const prisma: PrismaClient =
  globalForPrisma.__voidSpacePrisma ?? buildClient(process.env.DATABASE_URL, 'DATABASE_URL');

/** Administrative client: BYPASSRLS, narrow privileges. Use inside `withPlatform(...)`. */
export const platformPrisma: PrismaClient =
  globalForPrisma.__voidSpacePlatformPrisma ??
  buildClient(process.env.PLATFORM_DATABASE_URL, 'PLATFORM_DATABASE_URL');

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__voidSpacePrisma = prisma;
  globalForPrisma.__voidSpacePlatformPrisma = platformPrisma;
}

export interface DatabaseRoleInfo {
  readonly currentUser: string;
  readonly isSuperuser: boolean;
  readonly bypassRls: boolean;
}

/**
 * Reads the connected role's identity and RLS attributes.
 *
 * The API and worker call this at boot and refuse to start if the runtime
 * connection can bypass RLS — a mis-set DATABASE_URL would otherwise silently
 * disable tenant isolation (FR-1.6, NFR-SEC.5).
 */
export async function inspectDatabaseRole(client: PrismaClient = prisma): Promise<DatabaseRoleInfo> {
  const [row] = await client.$queryRawUnsafe<
    { current_user: string; is_superuser: boolean; bypass_rls: boolean }[]
  >(
    `SELECT current_user AS current_user,
            current_setting('is_superuser') = 'on' AS is_superuser,
            r.rolbypassrls AS bypass_rls
       FROM pg_roles r
      WHERE r.rolname = current_user`,
  );
  return {
    currentUser: row?.current_user ?? 'unknown',
    isSuperuser: row?.is_superuser ?? false,
    bypassRls: row?.bypass_rls ?? false,
  };
}

/** Throws unless the given client connects as a non-privileged, RLS-subject role. */
export async function assertRlsEnforced(client: PrismaClient = prisma): Promise<DatabaseRoleInfo> {
  const info = await inspectDatabaseRole(client);
  if (info.isSuperuser || info.bypassRls) {
    throw new Error(
      `[db] refusing to start: role "${info.currentUser}" is superuser=${info.isSuperuser} ` +
        `bypassRls=${info.bypassRls}. The runtime must connect as void_app so Row-Level ` +
        'Security protects tenant data (NFR-SEC.5). Check DATABASE_URL.',
    );
  }
  return info;
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([prisma.$disconnect(), platformPrisma.$disconnect()]);
}
