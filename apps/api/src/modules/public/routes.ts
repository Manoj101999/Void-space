/**
 * Public catalog API (SRS §6.1 "Public Catalog", FR-5.2, FR-5.3, FR-8.3).
 *
 *   GET /api/v1/public/catalog            browse published assets, anonymously
 *   GET /api/v1/public/catalog/:assetId    one entry, with its on-chain provenance
 *   GET /api/v1/public/facets              filter counts for the marketplace rail
 *   GET /api/v1/public/stats               the catalog's own totals
 *
 * **These routes do not authenticate, and that is the point.** A marketplace behind a sign-in wall
 * cannot be linked to, indexed, or shown to a buyer who is still deciding, so §6.1 lists the Public
 * Catalog as its own surface. The isolation guarantee is not weakened: the handlers read
 * `public_catalog_entries`, an explicit projection written only at publish time, never the tenant
 * tables. There is no tenant context to leak because none is established.
 *
 * Rate-limited harder than the rest of the API (below), because this is the one endpoint reachable
 * without credentials and so the only one a stranger can hammer.
 */
import {
  PUBLIC_CATALOG_SORTS,
  getPublicCatalogEntry,
  listPublicCatalog,
  publicCatalogFacets,
} from '@void-space/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { NotFoundError, ValidationError } from '../../lib/errors';

/** Query parameters are strings; every field is coerced explicitly rather than trusted. */
const browseQuerySchema = z.object({
  category: z.string().trim().max(60).optional(),
  search: z.string().trim().max(120).optional(),
  tag: z.string().trim().max(60).optional(),
  licenseType: z.string().trim().max(40).optional(),
  sort: z.enum(PUBLIC_CATALOG_SORTS).default('newest'),
  limit: z.coerce.number().int().min(1).max(60).default(24),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

const assetIdParamSchema = z.object({
  assetId: z.string().uuid('A catalog id is a UUID'),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(
      'The request could not be understood',
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** Anonymous traffic gets a tighter budget than a signed-in workspace (NFR-SEC.6). */
const PUBLIC_RATE_LIMIT = {
  max: 120,
  timeWindow: '1 minute',
} as const;

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/public/catalog',
    { config: { rateLimit: PUBLIC_RATE_LIMIT } },
    async (request: FastifyRequest) => {
      const query = parse(browseQuerySchema, request.query);
      const { total, items } = await listPublicCatalog(query);

      return {
        total,
        limit: query.limit,
        offset: query.offset,
        sort: query.sort,
        items,
      };
    },
  );

  app.get(
    '/public/facets',
    { config: { rateLimit: PUBLIC_RATE_LIMIT } },
    async () => publicCatalogFacets(),
  );

  app.get(
    '/public/catalog/:assetId',
    { config: { rateLimit: PUBLIC_RATE_LIMIT } },
    async (request: FastifyRequest) => {
      const { assetId } = parse(assetIdParamSchema, request.params);
      const entry = await getPublicCatalogEntry(assetId);

      // A delisted or never-published asset is indistinguishable from one that does not exist,
      // so the catalog cannot be used to probe for takedowns.
      if (!entry) throw new NotFoundError('Catalog entry');

      return { item: entry };
    },
  );

  app.get('/public/stats', { config: { rateLimit: PUBLIC_RATE_LIMIT } }, async () => {
    const facets = await publicCatalogFacets();

    return {
      published: facets.total,
      polygons: facets.polygons,
      bytes: facets.bytes,
      categories: facets.categories.length,
    };
  });
}
