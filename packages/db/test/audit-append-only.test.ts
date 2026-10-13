/**
 * Audit-log behaviour: append-only enforcement and tenant scoping
 * (SRS FR-13.1–13.3, §4.13, traceability case TC-AUDIT-001).
 *
 * The table is append-only at the *database-permission* level, so these tests
 * assert that PostgreSQL itself refuses the mutation — not merely that the
 * application avoids it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { recordAudit, recordStatusChange } from '../src/audit';
import { platformPrisma, prisma } from '../src/client';
import { withPlatform, withTenant } from '../src/tenant';

describe('audit log (FR-13.3)', () => {
  let tenantId: string;
  let actorId: string;
  let assetId: string;

  beforeAll(async () => {
    const tenant = await withPlatform((db) =>
      db.tenant.findUnique({ where: { slug: 'aurora-industrial' }, select: { id: true } }),
    );
    if (!tenant) throw new Error('[test] demo tenant missing — run `pnpm db:seed` first');
    tenantId = tenant.id;

    const [user, asset] = await withTenant(tenantId, async (db) => [
      await db.user.findFirst({ where: { email: 'creator@aurora.dev' }, select: { id: true } }),
      await db.asset.findFirst({ select: { id: true } }),
    ]);
    actorId = user?.id ?? '';
    assetId = asset?.id ?? '';
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await platformPrisma.$disconnect();
  });

  it('appends an entry with before/after state and an actor', async () => {
    const row = await withTenant(tenantId, (db) =>
      recordStatusChange(
        {
          action: 'asset.status_changed',
          entityType: 'asset',
          entityId: assetId,
          from: 'pending',
          to: 'approved',
          actorId,
          actorLabel: 'Ravi Menon',
          requestId: 'test-request-id',
        },
        db,
      ),
    );

    expect(row.id).toBeTruthy();

    const stored = await withTenant(tenantId, (db) =>
      db.auditLog.findUnique({ where: { id: row.id } }),
    );
    expect(stored?.action).toBe('asset.status_changed');
    expect(stored?.beforeState).toEqual({ status: 'pending' });
    expect(stored?.afterState).toEqual({ status: 'approved' });
    expect(stored?.actorLabel).toBe('Ravi Menon');
    expect(stored?.requestId).toBe('test-request-id');
  });

  it('persists chain metadata for verifiability (FR-9.6)', async () => {
    const row = await withTenant(tenantId, (db) =>
      recordAudit(
        {
          action: 'chain.license_minted',
          entityType: 'license',
          entityId: assetId,
          actorId,
          actorLabel: 'managed-signer',
          txHash: `0x${'ab'.repeat(32)}`,
          blockNumber: 1234n,
          gasUsed: 98_765n,
          ipfsCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
        },
        db,
      ),
    );

    const stored = await withTenant(tenantId, (db) =>
      db.auditLog.findUnique({ where: { id: row.id } }),
    );
    expect(stored?.txHash).toBe(`0x${'ab'.repeat(32)}`);
    expect(stored?.blockNumber).toBe(1234n);
    expect(stored?.gasUsed).toBe(98_765n);
  });

  it('refuses to update an existing entry (append-only)', async () => {
    const row = await withTenant(tenantId, (db) =>
      recordAudit({ action: 'asset.created', entityType: 'asset', entityId: assetId }, db),
    );

    await expect(
      withTenant(tenantId, (db) =>
        db.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } }),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses to delete an existing entry (append-only)', async () => {
    const row = await withTenant(tenantId, (db) =>
      recordAudit({ action: 'asset.created', entityType: 'asset', entityId: assetId }, db),
    );

    await expect(
      withTenant(tenantId, (db) => db.auditLog.delete({ where: { id: row.id } })),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses bulk deletes as well, so history cannot be swept away', async () => {
    await expect(
      withTenant(tenantId, (db) => db.auditLog.deleteMany({ where: {} })),
    ).rejects.toThrow(/permission denied/i);
  });
});
