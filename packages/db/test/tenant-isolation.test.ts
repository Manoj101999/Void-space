/**
 * Cross-tenant isolation, proven against a real PostgreSQL (SRS FR-1.6, §3.5,
 * NFR-SEC.5, traceability case TC-TENANT-002).
 *
 * These tests are the security regression net for the whole platform: if RLS is
 * ever disabled, mis-scoped or bypassed, they fail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { platformPrisma, prisma } from '../src/client';
import { TenantContextMissingError, tenantDb, withPlatform, withTenant } from '../src/tenant';

interface TenantFixture {
  readonly id: string;
  readonly slug: string;
  readonly assetIds: string[];
  readonly userIds: string[];
}

async function loadTenant(slug: string): Promise<TenantFixture> {
  const tenant = await withPlatform((db) => db.tenant.findUnique({ where: { slug } }));
  if (!tenant) throw new Error(`[test] tenant ${slug} not found — run \`pnpm db:seed\` first`);

  const assets = await withTenant(tenant.id, (db) => db.asset.findMany({ select: { id: true } }));
  const users = await withTenant(tenant.id, (db) => db.user.findMany({ select: { id: true } }));

  return {
    id: tenant.id,
    slug,
    assetIds: assets.map((asset) => asset.id),
    userIds: users.map((user) => user.id),
  };
}

describe('tenant isolation (RLS)', () => {
  let aurora: TenantFixture;
  let northwind: TenantFixture;

  beforeAll(async () => {
    aurora = await loadTenant('aurora-industrial');
    northwind = await loadTenant('northwind-safety');
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await platformPrisma.$disconnect();
  });

  it('seeds two tenants that both own assets (precondition)', () => {
    expect(aurora.assetIds.length).toBeGreaterThan(0);
    expect(northwind.assetIds.length).toBeGreaterThan(0);
    expect(aurora.id).not.toBe(northwind.id);
  });

  it('lists only the active tenant’s rows', async () => {
    const [auroraAssets, northwindAssets] = await Promise.all([
      withTenant(aurora.id, (db) => db.asset.findMany({ select: { id: true, tenantId: true } })),
      withTenant(northwind.id, (db) => db.asset.findMany({ select: { id: true, tenantId: true } })),
    ]);

    expect(auroraAssets.every((asset) => asset.tenantId === aurora.id)).toBe(true);
    expect(northwindAssets.every((asset) => asset.tenantId === northwind.id)).toBe(true);

    const auroraIds = new Set(auroraAssets.map((asset) => asset.id));
    const overlap = northwindAssets.filter((asset) => auroraIds.has(asset.id));
    expect(overlap).toEqual([]);
  });

  it('cannot read another tenant’s row even when its id is known (FR-1.6)', async () => {
    const foreignId = northwind.assetIds[0];
    expect(foreignId).toBeDefined();

    const leaked = await withTenant(aurora.id, (db) =>
      db.asset.findUnique({ where: { id: foreignId } }),
    );
    expect(leaked).toBeNull();
  });

  it('cannot update another tenant’s row', async () => {
    const foreignId = northwind.assetIds[0];
    const result = await withTenant(aurora.id, (db) =>
      db.asset.updateMany({ where: { id: foreignId }, data: { name: 'hijacked' } }),
    );
    expect(result.count).toBe(0);

    const untouched = await withTenant(northwind.id, (db) =>
      db.asset.findUnique({ where: { id: foreignId }, select: { name: true } }),
    );
    expect(untouched?.name).not.toBe('hijacked');
  });

  it('cannot delete another tenant’s row', async () => {
    const foreignId = northwind.assetIds[0];
    const result = await withTenant(aurora.id, (db) =>
      db.asset.deleteMany({ where: { id: foreignId } }),
    );
    expect(result.count).toBe(0);
  });

  it('rejects a write that claims another tenant’s id (WITH CHECK)', async () => {
    await expect(
      withTenant(aurora.id, (db) =>
        db.asset.create({
          data: {
            tenantId: northwind.id,
            creatorId: northwind.userIds[0] as string,
            name: 'smuggled asset',
            category: 'Prop',
          },
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('cannot read another tenant’s users or audit trail', async () => {
    const foreignUserId = northwind.userIds[0];
    const user = await withTenant(aurora.id, (db) =>
      db.user.findUnique({ where: { id: foreignUserId } }),
    );
    expect(user).toBeNull();

    const audit = await withTenant(aurora.id, (db) =>
      db.auditLog.findMany({ select: { tenantId: true } }),
    );
    expect(audit.every((entry) => entry.tenantId === aurora.id)).toBe(true);
  });

  it('fails closed when tenant context is missing entirely', async () => {
    // Even a hand-written query that reaches around the query builder must be
    // rejected — no rows are ever returned without an established tenant context.
    //
    // Two failure modes are possible and both are correct:
    //   * 42704 unrecognized configuration parameter — first use in this session
    //   * 22P02  invalid input syntax for type uuid: "" — PostgreSQL keeps the GUC
    //     as an empty placeholder after a *local* set_config transaction ends, so
    //     the policy's ::uuid cast fails instead.
    await expect(prisma.$queryRawUnsafe('SELECT count(*) FROM assets')).rejects.toThrow(
      /current_tenant_id|unrecognized configuration parameter|invalid input syntax for type uuid/i,
    );
  });

  it('does not leak tenant context to the next use of the pooled connection', async () => {
    await withTenant(aurora.id, (db) => db.asset.count());

    // The setting was transaction-local (set_config(..., is_local => true)), so a
    // subsequent unwrapped query must fail again rather than inherit the tenant.
    await expect(prisma.$queryRawUnsafe('SELECT count(*) FROM assets')).rejects.toThrow();
  });

  it('rejects a non-UUID tenant id before touching the database', async () => {
    await expect(withTenant("' OR 1=1 --", (db) => db.asset.count())).rejects.toThrow(/UUID/);
  });

  it('exposes tenant helpers only inside a tenant context', () => {
    expect(() => tenantDb()).toThrow(TenantContextMissingError);
  });
});
