/**
 * CLI entry point for `pnpm db:sync-catalog`.
 *
 * Rebuilds the §6.1 public catalog projection from the tenant tables. The projection is written
 * during publish, so this exists for the cases where a rebuild is the honest answer rather than a
 * hand-written UPDATE:
 *
 *   - the projection was introduced after assets were already published (the first run);
 *   - a business rule changed what "publicly listed" means;
 *   - someone edited the table and the marketplace no longer matches what the licences say.
 *
 * Because it reads `assets`, it runs one tenant context per workspace — the same path the platform
 * uses everywhere else, rather than a privileged bulk read.
 */
import { loadRootEnv } from './env';

loadRootEnv();

const { platformPrisma, prisma, withTenant, syncPublicCatalogEntry, removePublicCatalogEntry } =
  await import('./index');

async function sync(): Promise<void> {
  const tenants = await platformPrisma.tenant.findMany({ select: { id: true, name: true } });

  let written = 0;
  let skipped = 0;
  const stale: string[] = [];

  for (const tenant of tenants) {
    const published = await withTenant(tenant.id, (db) =>
      db.asset.findMany({
        where: { status: 'published' },
        select: { id: true, name: true },
      }),
    );

    for (const asset of published) {
      const entry = await withTenant(tenant.id, (db) =>
        syncPublicCatalogEntry(db, { tenantId: tenant.id, assetId: asset.id }),
      );

      if (entry) {
        written += 1;
      } else {
        // Published with no active licence or no pinned content: it cannot be listed, and saying so
        // is more useful than silently leaving a stale row behind.
        stale.push(`${tenant.name} / ${asset.name}`);
        skipped += 1;
      }
    }

    // Anything in the projection that is no longer published (a takedown that ran before this
    // projection existed, for instance) must not stay on the marketplace.
    const live = new Set(published.map((asset) => asset.id));
    const projected = await prisma.publicCatalogEntry.findMany({
      where: { tenantId: tenant.id },
      select: { assetId: true, name: true },
    });

    for (const row of projected) {
      if (!live.has(row.assetId)) {
        await removePublicCatalogEntry(row.assetId);
        stale.push(`${tenant.name} / ${row.name} (unlisted)`);
      }
    }
  }

  console.log(`[sync-catalog] ${written} entries written across ${tenants.length} workspace(s)`);

  if (stale.length > 0) {
    console.log(`[sync-catalog] ${skipped} published asset(s) could not be listed:`);
    for (const line of stale) console.log(`  - ${line}`);
  }

  const total = await prisma.publicCatalogEntry.count();
  console.log(`[sync-catalog] marketplace now lists ${total} asset(s)`);
}

sync()
  .then(async () => {
    await prisma.$disconnect();
    await platformPrisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error('[sync-catalog] failed:', error);
    await prisma.$disconnect().catch(() => undefined);
    process.exitCode = 1;
  });
