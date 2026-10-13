/**
 * Public catalog projection (§6.1 "Public Catalog", FR-5.2, FR-5.3).
 *
 * The marketplace is read by anonymous visitors and must list published assets from *every*
 * workspace, while §5.3 keeps the platform role out of tenant tables. `PublicCatalogEntry` bridges
 * that gap as an explicit projection — see the model's comment in schema.prisma for why that beat
 * the alternatives.
 *
 * The projection is written at publish time (after the mint confirms, so a transaction hash always
 * exists) and **deleted** at takedown. Nothing else in the platform reads it, so it can be rebuilt
 * from the tenant tables at any time — `pnpm db:sync-catalog` does exactly that.
 */
import { PUBLIC_CATALOG_SORTS, type PublicCatalogSort } from '@void-space/types';
import type { Prisma } from '../generated/client';

import { prisma } from './client';
import type { TenantClient } from './tenant';

/**
 * Re-exported so consumers of this package get the sort list from one import. The definition lives in
 * `@void-space/types` because the API validator, the storefront and the console all need it, and a
 * second copy is a second thing to forget to update.
 */
export { PUBLIC_CATALOG_SORTS };
export type { PublicCatalogSort };

/** The shape the marketplace renders. Deliberately narrower than the tenant-side asset view. */
export interface PublicCatalogItem {
  readonly assetId: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string;
  readonly tags: readonly string[];
  readonly tenantName: string;
  readonly format: string;
  readonly sizeBytes: string;
  readonly polycount: number | null;
  readonly vertices: number | null;
  readonly materials: number | null;
  readonly textures: number | null;
  readonly animations: number | null;
  readonly ipfsCid: string;
  readonly licenseType: string;
  readonly licenseTerms: string | null;
  readonly tokenId: string | null;
  readonly contractAddress: string | null;
  readonly txHash: string | null;
  readonly licenseMetadataCid: string | null;
  readonly xrManifestRef: string | null;
  readonly sourceLicense: string | null;
  readonly sourceAttribution: string | null;
  readonly sourceUrl: string | null;
  readonly publishedAt: string;
}

type PublicCatalogRow = Prisma.PublicCatalogEntryGetPayload<Record<string, never>>;

/**
 * `BigInt` does not survive `JSON.stringify`, and an on-chain token id is an identifier rather than
 * arithmetic, so it is serialised as a string for the same reason the rest of the platform does it.
 */
export function toPublicCatalogItem(row: PublicCatalogRow): PublicCatalogItem {
  return {
    assetId: row.assetId,
    name: row.name,
    description: row.description,
    category: row.category,
    tags: [...row.tags],
    tenantName: row.tenantName,
    format: row.format,
    sizeBytes: row.sizeBytes.toString(),
    polycount: row.polycount,
    vertices: row.vertices,
    materials: row.materials,
    textures: row.textures,
    animations: row.animations,
    ipfsCid: row.ipfsCid,
    licenseType: row.licenseType,
    licenseTerms: row.licenseTerms,
    tokenId: row.tokenId === null ? null : row.tokenId.toString(),
    contractAddress: row.contractAddress,
    txHash: row.txHash,
    licenseMetadataCid: row.licenseMetadataCid,
    xrManifestRef: row.xrManifestRef,
    sourceLicense: row.sourceLicense,
    sourceAttribution: row.sourceAttribution,
    sourceUrl: row.sourceUrl,
    publishedAt: row.publishedAt.toISOString(),
  };
}

/**
 * Builds or refreshes the public entry for an asset.
 *
 * Must be called with tenant context, because it reads the tenant-side rows to build the
 * projection. Returns null when the asset is not in a publishable shape (not published, no content
 * address, or no active licence) — listing such an asset would advertise something a visitor cannot
 * actually fetch, so the caller gets null rather than a half-entry.
 */
export async function syncPublicCatalogEntry(
  db: TenantClient,
  params: { readonly tenantId: string; readonly assetId: string },
): Promise<PublicCatalogItem | null> {
  const asset = await db.asset.findUnique({
    where: { id: params.assetId },
    select: {
      id: true,
      name: true,
      description: true,
      category: true,
      tags: true,
      status: true,
      publishedAt: true,
      xrManifestRef: true,
      currentVersion: {
        select: {
          ipfsCid: true,
          format: true,
          sizeBytes: true,
          polycount: true,
          vertices: true,
          materials: true,
          textures: true,
          animations: true,
          sourceLicense: true,
          sourceAttribution: true,
          sourceUrl: true,
        },
      },
      licenses: {
        where: { status: 'active' },
        orderBy: { mintedAt: 'desc' },
        take: 1,
        select: {
          tokenId: true,
          contractAddress: true,
          txHash: true,
          ipfsMetadataCid: true,
          licenseType: true,
          licenseTerms: true,
          mintedAt: true,
        },
      },
    },
  });

  if (!asset) return null;

  const version = asset.currentVersion;
  const license = asset.licenses[0];
  if (asset.status !== 'published' || !version?.ipfsCid || !license) return null;

  const tenant = await db.tenant.findUnique({
    where: { id: params.tenantId },
    select: { name: true },
  });

  const data = {
    tenantId: params.tenantId,
    tenantName: tenant?.name ?? 'Unknown workspace',
    name: asset.name,
    description: asset.description,
    category: asset.category,
    tags: [...asset.tags],
    format: version.format,
    sizeBytes: version.sizeBytes,
    polycount: version.polycount,
    vertices: version.vertices,
    materials: version.materials,
    textures: version.textures,
    animations: version.animations,
    ipfsCid: version.ipfsCid,
    licenseType: license.licenseType,
    licenseTerms: license.licenseTerms,
    tokenId: license.tokenId,
    contractAddress: license.contractAddress,
    txHash: license.txHash,
    licenseMetadataCid: license.ipfsMetadataCid,
    xrManifestRef: asset.xrManifestRef,
    sourceLicense: version.sourceLicense,
    sourceAttribution: version.sourceAttribution,
    sourceUrl: version.sourceUrl,
    publishedAt: asset.publishedAt ?? license.mintedAt,
  } satisfies Omit<Prisma.PublicCatalogEntryUncheckedCreateInput, 'assetId'>;

  // `public_catalog_entries` carries no tenant policy (it is public by design), so the runtime role
  // may write it from inside the same transaction that read the tenant-scoped rows.
  const row = await db.publicCatalogEntry.upsert({
    where: { assetId: params.assetId },
    create: { assetId: params.assetId, ...data },
    update: data,
  });

  return toPublicCatalogItem(row);
}

/** Removes an asset from the marketplace (takedown). The on-chain token is untouched. */
export async function removePublicCatalogEntry(assetId: string): Promise<number> {
  const result = await prisma.publicCatalogEntry.deleteMany({ where: { assetId } });
  return result.count;
}

/** Maps a validated sort to the Prisma order, defaulting to freshest-first. */
function orderFor(sort: PublicCatalogSort | undefined): Prisma.PublicCatalogEntryOrderByWithRelationInput {
  switch (sort) {
    case 'oldest':
      return { publishedAt: 'asc' };
    case 'triangles-desc':
      return { polycount: 'desc' };
    case 'size-desc':
      return { sizeBytes: 'desc' };
    case 'name':
      return { name: 'asc' };
    case 'newest':
    default:
      // Freshest first is the right default: a catalogue that opens on its oldest asset looks
      // abandoned regardless of how much is in it.
      return { publishedAt: 'desc' };
  }
}

/** Anonymous browse. No tenant context: these rows are public by construction. */
export async function listPublicCatalog(params?: {
  readonly category?: string | undefined;
  readonly search?: string | undefined;
  readonly tag?: string | undefined;
  readonly licenseType?: string | undefined;
  readonly sort?: PublicCatalogSort | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}): Promise<{ readonly total: number; readonly items: PublicCatalogItem[] }> {
  const where: Prisma.PublicCatalogEntryWhereInput = {};

  if (params?.category && params.category !== 'all') where.category = params.category;
  if (params?.licenseType) where.licenseType = params.licenseType;
  if (params?.tag) where.tags = { has: params.tag };

  const term = params?.search?.trim();
  if (term) {
    where.OR = [
      { name: { contains: term, mode: 'insensitive' } },
      { description: { contains: term, mode: 'insensitive' } },
      { category: { contains: term, mode: 'insensitive' } },
      { tags: { has: term.toLowerCase() } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.publicCatalogEntry.count({ where }),
    prisma.publicCatalogEntry.findMany({
      where,
      orderBy: orderFor(params?.sort),
      take: params?.limit ?? 24,
      skip: params?.offset ?? 0,
    }),
  ]);

  return { total, items: rows.map(toPublicCatalogItem) };
}

/** One marketplace entry, by the asset id used in its URL. */
export async function getPublicCatalogEntry(assetId: string): Promise<PublicCatalogItem | null> {
  const row = await prisma.publicCatalogEntry.findUnique({ where: { assetId } });
  return row ? toPublicCatalogItem(row) : null;
}

/**
 * Facet counts for the marketplace filter rail, computed over the whole catalog rather than the
 * current page — a filter that hides most categories because they are on page 2 is not a filter.
 */
export async function publicCatalogFacets(): Promise<{
  readonly total: number;
  readonly categories: readonly { value: string; count: number }[];
  readonly licenseTypes: readonly { value: string; count: number }[];
  readonly tags: readonly { value: string; count: number }[];
  readonly polygons: number;
  readonly bytes: string;
}> {
  const rows = await prisma.publicCatalogEntry.findMany({
    select: { category: true, tags: true, licenseType: true, sizeBytes: true, polycount: true },
  });

  const categories = new Map<string, number>();
  const licenseTypes = new Map<string, number>();
  const tags = new Map<string, number>();
  let bytes = 0n;
  let polygons = 0;

  for (const row of rows) {
    categories.set(row.category, (categories.get(row.category) ?? 0) + 1);
    licenseTypes.set(row.licenseType, (licenseTypes.get(row.licenseType) ?? 0) + 1);
    for (const tag of row.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    bytes += row.sizeBytes;
    polygons += row.polycount ?? 0;
  }

  const byCount = (a: { value: string; count: number }, b: { value: string; count: number }) =>
    b.count - a.count || a.value.localeCompare(b.value);

  const rank = (source: Map<string, number>, limit?: number) => {
    const sorted = [...source.entries()].map(([value, count]) => ({ value, count })).sort(byCount);
    return limit === undefined ? sorted : sorted.slice(0, limit);
  };

  return {
    total: rows.length,
    categories: rank(categories),
    licenseTypes: rank(licenseTypes),
    tags: rank(tags, 30),
    polygons,
    bytes: bytes.toString(),
  };
}
