/**
 * Automated schema audit for tenant isolation (SRS NFR-SEC.5, Appendix A:
 * "RLS policy present on every tenant table").
 *
 * Reads PostgreSQL's own catalogues, so it fails if a future migration forgets to
 * protect a new table.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { platformPrisma, prisma } from '../src/client';

/** §5.3 — every table listed there except Tenant and Role is tenant-scoped. */
const TENANT_SCOPED_TABLES = [
  'users',
  'user_roles',
  'wallets',
  'invites',
  'tenant_settings',
  'webhooks',
  'assets',
  'asset_versions',
  'ai_suggestions',
  'review_decisions',
  'review_comments',
  'licenses',
  'api_keys',
  'notifications',
  'audit_logs',
  'jobs',
] as const;

interface RlsRow {
  table_name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  policy_count: bigint;
}

interface PrivilegeRow {
  role_name: string;
  table_name: string;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
}

const RLS_QUERY = `SELECT c.relname AS table_name,
        c.relrowsecurity AS rls_enabled,
        c.relforcerowsecurity AS rls_forced,
        (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'`;

function privilegeQuery(tableNames: string): string {
  return `SELECT r.rolname AS role_name,
                 t.relname AS table_name,
                 has_table_privilege(r.rolname, t.oid, 'SELECT') AS can_select,
                 has_table_privilege(r.rolname, t.oid, 'INSERT') AS can_insert,
                 has_table_privilege(r.rolname, t.oid, 'UPDATE') AS can_update,
                 has_table_privilege(r.rolname, t.oid, 'DELETE') AS can_delete
            FROM pg_roles r
            CROSS JOIN pg_class t
            JOIN pg_namespace n ON n.oid = t.relnamespace
           WHERE r.rolname = 'void_platform'
             AND n.nspname = 'public'
             AND t.relname IN (${tableNames})`;
}

describe('RLS schema audit (NFR-SEC.5)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
    await platformPrisma.$disconnect();
  });

  it('enables and forces RLS with a policy on every tenant-scoped table', async () => {
    const rows = await prisma.$queryRawUnsafe<RlsRow[]>(RLS_QUERY);
    const byTable = new Map(rows.map((row) => [row.table_name, row]));

    for (const table of TENANT_SCOPED_TABLES) {
      const row = byTable.get(table);
      expect(row, `table ${table} is missing from the database`).toBeDefined();
      expect(row?.rls_enabled, `${table}: RLS not enabled`).toBe(true);
      expect(row?.rls_forced, `${table}: RLS not forced (owner would bypass)`).toBe(true);
      expect(Number(row?.policy_count), `${table}: no policy defined`).toBeGreaterThan(0);
    }
  });

  it('protects the tenants table itself while leaving roles policy-free', async () => {
    const rows = await prisma.$queryRawUnsafe<RlsRow[]>(RLS_QUERY);
    const tenants = rows.find((row) => row.table_name === 'tenants');
    const roles = rows.find((row) => row.table_name === 'roles');

    expect(tenants?.rls_enabled).toBe(true);
    expect(Number(tenants?.policy_count)).toBeGreaterThan(0);

    // `roles` is a fixed, platform-defined lookup table with no tenant data (§5.3).
    expect(Number(roles?.policy_count)).toBe(0);
  });

  it('denies the platform role any access to asset, review, licence and audit data', async () => {
    const rows = await prisma.$queryRawUnsafe<PrivilegeRow[]>(
      privilegeQuery(
        `'assets','asset_versions','ai_suggestions','review_decisions','review_comments',
          'licenses','api_keys','notifications','jobs','audit_logs'`,
      ),
    );

    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) {
      expect(
        row.can_select || row.can_insert || row.can_update || row.can_delete,
        `void_platform must have no privileges on ${row.table_name}`,
      ).toBe(false);
    }
  });

  it('gives the platform role exactly its administrative surface (§3.5, §5.3)', async () => {
    const rows = await prisma.$queryRawUnsafe<PrivilegeRow[]>(
      privilegeQuery(`'tenants','roles','users','user_roles','wallets','invites'`),
    );

    expect(rows.length).toBe(6);
    for (const row of rows) {
      expect(row.can_select, `void_platform needs SELECT on ${row.table_name}`).toBe(true);
    }
  });

  it('makes the audit log append-only for the runtime role (FR-13.3)', async () => {
    const [row] = await prisma.$queryRawUnsafe<
      { can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }[]
    >(
      `SELECT has_table_privilege('void_app', 'audit_logs', 'SELECT') AS can_select,
              has_table_privilege('void_app', 'audit_logs', 'INSERT') AS can_insert,
              has_table_privilege('void_app', 'audit_logs', 'UPDATE') AS can_update,
              has_table_privilege('void_app', 'audit_logs', 'DELETE') AS can_delete`,
    );

    expect(row?.can_select).toBe(true);
    expect(row?.can_insert).toBe(true);
    expect(row?.can_update, 'void_app must not be able to rewrite history').toBe(false);
    expect(row?.can_delete, 'void_app must not be able to erase history').toBe(false);
  });

  it('runs the application as a non-superuser that cannot bypass RLS', async () => {
    const [row] = await prisma.$queryRawUnsafe<
      { is_superuser: boolean; bypass_rls: boolean; role_name: string }[]
    >(
      `SELECT current_user AS role_name,
              current_setting('is_superuser') = 'on' AS is_superuser,
              r.rolbypassrls AS bypass_rls
         FROM pg_roles r WHERE r.rolname = current_user`,
    );

    expect(row?.role_name).toBe('void_app');
    expect(row?.is_superuser).toBe(false);
    expect(row?.bypass_rls).toBe(false);
  });
});
