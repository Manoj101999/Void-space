/**
 * Third-party tools & importers (SRS §4.6, §6.4; FR-6.1–FR-6.4).
 *
 *   POST /api/v1/tools/sketchfab/search    FR-6.1  search by licence + polycount
 *   POST /api/v1/tools/poly-pizza/search   FR-6.2  search by keyword + triangles
 *   POST /api/v1/tools/blender/optimize    FR-6.3  enqueue a headless conversion
 *   POST /api/v1/tools/meshy/generate      FR-6.4  submit a text-to-3D task
 *   POST /api/v1/tools/import              UC-09   stage a search result as a draft asset
 *   GET  /api/v1/tools/integrations        which adapters are live, and which are offline
 *
 * The two search paths and `/tools/blender/optimize` are the ones SRS §6.4 names, so their paths are
 * fixed by the specification; the rest follow the same shape.
 *
 * Every route requires `asset:upload-own`, which is the §3.6 permission for "bring content in". A
 * Viewer or a Developer cannot reach them, and that is correct: sourcing content is a Creator act.
 *
 * ## Why the search routes answer 200 with an empty list rather than 503
 *
 * An unconfigured vendor is not a failure of *this* API. A 503 would make a client show "something
 * went wrong", which is false and unactionable; a 200 carrying `offline: true` and a sentence lets
 * the UI say "Sketchfab is not configured — set SKETCHFAB_API_TOKEN", which is true and actionable.
 * The distinction is the same one `IntegrationStatus` exists to make.
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  blenderOptimizeSchema,
  importExternalAssetSchema,
  meshyGenerateSchema,
  polyPizzaSearchSchema,
  QUEUE_POLICIES,
  sketchfabSearchSchema,
  type AssetExtension,
  type ImportExternalAssetInput,
  type SourceTool,
} from '@void-space/types';
import { withTenant } from '@void-space/db';
import type { FastifyInstance } from 'fastify';

import type { ApiEnv } from '../../env';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../../lib/errors';
import { parseBody } from '../../lib/http';
import type { JobProducer } from '../../lib/jobs';
import {
  StagingStorage,
  extensionOf,
  isAllowedExtension,
  newVersionId,
  sanitizeFileName,
} from '../../lib/storage';
import { createAssetService, type AssetService } from '../assets/service';
import { createToolsService, type ToolsService } from './service';

export interface ToolsRoutesOptions {
  readonly env: ApiEnv;
  readonly producer: JobProducer;
  /** Injected in tests; production builds its own from the environment. */
  readonly service?: ToolsService;
  readonly fetchImpl?: typeof fetch;
}

/** FR-6.x — every tools route needs the right to bring content into the tenant. */
const UPLOAD = 'asset:upload-own';

/**
 * The download hosts each source may name (UC-09).
 *
 * This route makes the server fetch a URL the *caller* chose, which is the shape of a
 * server-side request forgery. Without a check, `downloadUrl` could name
 * `http://169.254.169.254/latest/meta-data/…` (cloud instance credentials), a Compose sibling such
 * as `http://postgres:5432`, or this API's own admin routes — and the response would be streamed
 * into staging as an "asset", which is a read primitive even if nobody ever downloads it.
 *
 * The `source` enum is closed, so this list is closed with it: a URL is fetched only when its host
 * *is* the vendor that `source` names, or a subdomain of it. The leading dot in the comparison is
 * what makes that safe — `evil-sketchfab.com` does not end with `.sketchfab.com`. Adding a vendor
 * means adding a row here, which is the intent: a new vendor is a decision about who we fetch from.
 */
const SOURCE_DOWNLOAD_HOSTS: Readonly<Record<ImportExternalAssetInput['source'], readonly string[]>> = {
  sketchfab: ['sketchfab.com'],
  'poly-pizza': ['poly.pizza'],
};

/** The vendor, as it is recorded on the version for provenance (NFR-COMP.1). */
const SOURCE_TOOL: Readonly<Record<ImportExternalAssetInput['source'], SourceTool>> = {
  sketchfab: 'Sketchfab',
  'poly-pizza': 'Poly Pizza',
};

/**
 * Content types the vendors serve, mapped to the extension `StagingStorage.stage` validates.
 *
 * `application/octet-stream` is deliberately absent: it is what a server sends when it does not know
 * either, so mapping it would be picking an extension at random. When it is all we have, the URL is
 * the remaining evidence, and if that is inconclusive too the import fails with a message that says
 * so rather than guessing.
 */
const EXTENSION_BY_MIME: Readonly<Record<string, AssetExtension>> = {
  'model/gltf-binary': '.glb',
  'model/gltf+json': '.gltf',
  'model/obj': '.obj',
  'model/fbx': '.fbx',
  'model/stl': '.stl',
  'application/x-blender': '.blend',
};

/** Rejects anything that is not this vendor over https, and returns the parsed URL. */
function assertVendorUrl(source: ImportExternalAssetInput['source'], raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('downloadUrl is not a valid URL', { downloadUrl: raw });
  }

  if (url.protocol !== 'https:') {
    throw new ValidationError('downloadUrl must be https', { protocol: url.protocol });
  }

  const host = url.hostname.toLowerCase();
  const allowed = SOURCE_DOWNLOAD_HOSTS[source].some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
  if (!allowed) {
    throw new ValidationError(
      `downloadUrl must be on ${SOURCE_DOWNLOAD_HOSTS[source].join(' or ')} for a ${source} import`,
      { host, allowed: SOURCE_DOWNLOAD_HOSTS[source] },
    );
  }

  return url;
}

/**
 * A filename `stage()` will accept, derived from the two things the vendor tells us.
 *
 * The URL wins over the content type because it is what the vendor *named* the file, and a served
 * `Content-Type` is often the useless `application/octet-stream`. The asset's own name has no
 * extension, so it is the stem in both cases.
 */
function importFileName(name: string, url: URL, contentType: string | null): string {
  const stem = sanitizeFileName(name);

  const fromUrl = extensionOf(url.pathname);
  if (isAllowedExtension(fromUrl)) return `${stem}${fromUrl}`;

  const mime = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  const fromMime = EXTENSION_BY_MIME[mime];
  if (fromMime) return `${stem}${fromMime}`;

  throw new ValidationError(
    `Cannot tell what format this download is (Content-Type "${mime || 'none'}", URL has no ` +
      'recognised extension). Import it by uploading the file instead.',
    { contentType: mime || null, path: url.pathname },
  );
}


export async function toolsRoutes(
  app: FastifyInstance,
  options: ToolsRoutesOptions,
): Promise<void> {
  const { env, producer } = options;
  const tools =
    options.service ??
    createToolsService({
      sketchfabToken: env.SKETCHFAB_API_TOKEN,
      polyPizzaToken: env.POLY_PIZZA_API_KEY,
      meshyKey: env.MESHY_API_KEY,
      // A configured runner URL is the whole difference between a real conversion and a labelled
      // simulation — see the processor. Reported here so an operator is never left guessing.
      blenderConfigured: Boolean(env.BLENDER_RUNNER_URL),
      eonConfigured: Boolean(env.EON_API_URL && env.EON_API_KEY),
      claudeConfigured: Boolean(env.ANTHROPIC_API_KEY),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });

  // UC-09 imports land through the same staging and asset services an upload uses, rather than a
  // second path that creates rows itself. That is what makes an imported file indistinguishable from
  // an uploaded one downstream — it is pinned, enriched, reviewed and licensed by the same workers,
  // and it has a staged file for the pin job to read because `stage()` wrote one.
  const storage = new StagingStorage({ stagingDir: env.STAGING_DIR });
  const assets: AssetService = createAssetService({ storage, producer });
  const doFetch = options.fetchImpl ?? fetch;

  // ------------------------------------------------------------------- status
  app.get(
    '/tools/integrations',
    { preHandler: app.requirePermission(UPLOAD) },
    async (_request, reply) => reply.status(200).send(tools.integrationStatus()),
  );

  // ------------------------------------------------------- FR-6.1 / FR-6.2 search
  app.post(
    '/tools/sketchfab/search',
    { preHandler: app.requirePermission(UPLOAD) },
    async (request, reply) => {
      const query = parseBody(sketchfabSearchSchema, request.body);
      return reply.status(200).send(await tools.searchSketchfab(query));
    },
  );

  app.post(
    '/tools/poly-pizza/search',
    { preHandler: app.requirePermission(UPLOAD) },
    async (request, reply) => {
      const query = parseBody(polyPizzaSearchSchema, request.body);
      return reply.status(200).send(await tools.searchPolyPizza(query));
    },
  );

  // ------------------------------------------------------- FR-6.4 Meshy submit
  app.post(
    '/tools/meshy/generate',
    { preHandler: app.requirePermission(UPLOAD) },
    async (request, reply) => {
      const input = parseBody(meshyGenerateSchema, request.body);
      return reply.status(200).send(await tools.generateMeshy(input));
    },
  );

  // --------------------------------------------------- UC-09 import a search result
  //
  // The step between "found it on Sketchfab" and "it is a draft in my library". The two search
  // routes return vendor metadata; this turns one of those results into a real asset, with the
  // attribution NFR-COMP.1 requires, by fetching the vendor's download URL.
  //
  // It lands as a **draft**, not as `pending`. A Creator chose the file without seeing it rendered,
  // decimated or measured here, and pushing it straight into the review queue would present an
  // unexamined third-party file as one they vouched for. `submit` is a separate, deliberate act.
  app.post(
    '/tools/import',
    { preHandler: app.requirePermission(UPLOAD) },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const input = parseBody(importExternalAssetSchema, request.body);
      const url = assertVendorUrl(input.source, input.downloadUrl);

      const versionId = newVersionId();

      let response: Response;
      try {
        response = await doFetch(url, { redirect: 'follow' });
      } catch (error) {
        // The vendor is a dependency we do not control; unreachable is 503 and says so, rather than
        // a 500 that reads like a bug in this service.
        throw new ServiceUnavailableError(
          `${SOURCE_TOOL[input.source]} could not be reached: ${(error as Error).message}`,
          'VENDOR_UNREACHABLE',
        );
      }

      if (!response.ok || !response.body) {
        throw new ServiceUnavailableError(
          `${SOURCE_TOOL[input.source]} refused the download with HTTP ${response.status}`,
          'VENDOR_DOWNLOAD_FAILED',
          // The status travels in `details`, not the message: a 5xx message is never exposed, so a
          // client that needs to know *why* reads this rather than the sentence above.
          { status: response.status },
        );
      }

      // Throws a ValidationError naming what it saw when the format cannot be determined, before
      // anything is written to disk.
      const fileName = importFileName(input.name, url, response.headers.get('content-type'));

      let staged;
      try {
        staged = await storage.stage({
          tenantId: principal.tenantId,
          versionId,
          originalName: fileName,
          declaredMime: response.headers.get('content-type') ?? undefined,
          source: Readable.fromWeb(response.body as never),
        });
      } catch (error) {
        // A partial or oversized download is not a version: drop the directory `stage()` created so
        // a failed import leaves nothing behind for the pin worker to trip over.
        await storage.removeVersionDirectory(principal.tenantId, versionId);
        throw error;
      }

      const created = await assets.create(principal, {
        versionId,
        file: staged,
        metadata: {
          name: input.name,
          category: input.category,
          tags: input.tags,
          sourceTool: SOURCE_TOOL[input.source],
          submitForReview: false,
          ...(input.license ? { sourceLicense: input.license } : {}),
          ...(input.attribution ? { sourceAttribution: input.attribution } : {}),
          // The vendor's own page for the model, when the caller supplied it. Kept separate from
          // `downloadUrl`, which is a CDN URL that will rot.
          ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        },
      });

      request.log.info(
        { assetId: created.id, source: input.source, bytes: staged.sizeBytes },
        'external asset imported',
      );

      // The same envelope `POST /assets` returns, so a client that can handle an upload can handle
      // an import without a second code path.
      return reply.status(201).send({ asset: created });
    },
  );

  // ----------------------------------------------------- FR-6.3 Blender enqueue
  app.post(
    '/tools/blender/optimize',
    { preHandler: app.requirePermission(UPLOAD) },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const input = parseBody(blenderOptimizeSchema, request.body);

      const planned = await withTenant(principal.tenantId, async (db) => {
        const version = await db.assetVersion.findFirst({
          where: { id: input.assetVersionId, tenantId: principal.tenantId },
          include: { asset: { select: { id: true, creatorId: true, status: true } } },
        });
        if (!version) throw new NotFoundError('Asset version');

        // Sourcing is a Creator act, but optimizing *someone else's* asset is not — the same rule
        // the delete and version-upload paths already apply.
        if (
          version.asset.creatorId !== principal.userId &&
          !principal.permissions.includes('review:decide')
        ) {
          throw new ForbiddenError('You can only optimize your own assets', 'NOT_ASSET_OWNER');
        }

        // A version being converted must still be changeable. Once a licence exists, the bytes are
        // the ones the terms hash covers (FR-9.4), so a derivative of a published version would
        // either break that guarantee or be a change nobody can make afterwards.
        if (!['draft', 'revision', 'rejected', 'pending'].includes(version.asset.status)) {
          throw new ConflictError(
            `Only an unpublished asset can be optimized (this one is "${version.asset.status}")`,
            'ASSET_NOT_MUTABLE',
            { status: version.asset.status },
          );
        }

        // `stagingPath` is what the processor copies into the shared Blender volume. Without it
        // there are no bytes to convert, and the only honest outcome would be a labelled
        // simulation — which the processor can decide, but a Creator should not have to discover.
        if (!version.stagingPath) {
          throw new ConflictError(
            'This version has no staged file to convert',
            'VERSION_NOT_STAGED',
            { format: version.format },
          );
        }

        const jobId = randomUUID();
        const maxAttempts = QUEUE_POLICIES['blender-optimize'].attempts;
        const payload = {
          tenantId: principal.tenantId,
          assetId: version.asset.id,
          assetVersionId: version.id,
          stagedPath: version.stagingPath,
          ...(input.polycountBudget !== undefined
            ? { polycountBudget: input.polycountBudget }
            : {}),
        };

        await db.job.create({
          data: {
            id: jobId,
            tenantId: principal.tenantId,
            queue: 'blender_optimize',
            status: 'queued',
            entityType: 'assetVersion',
            entityId: version.id,
            payload: payload as never,
            maxAttempts,
          },
        });

        return { jobId, assetId: version.asset.id, versionId: version.id, payload, maxAttempts };
      });

      const outcome = await producer.enqueue({
        id: planned.jobId,
        queue: 'blender-optimize',
        tenantId: principal.tenantId,
        entityType: 'assetVersion',
        entityId: planned.versionId,
        payload: planned.payload,
        maxAttempts: planned.maxAttempts,
      });

      if (!outcome.enqueued) {
        // The row exists and now says `failed`, so the console shows a failed job rather than one
        // that is quietly never going to run.
        await withTenant(principal.tenantId, (db) =>
          db.job.update({
            where: { id: planned.jobId },
            data: {
              status: 'failed',
              error: outcome.error ?? 'queue unreachable',
              finishedAt: new Date(),
            },
          }),
        );
      }

      // 202: the request was accepted and the work is asynchronous (§3.10). The caller polls
      // `GET /jobs/:id` (FR-6.5) — which is what that endpoint exists for.
      return reply.status(202).send({
        jobId: planned.jobId,
        assetId: planned.assetId,
        assetVersionId: planned.versionId,
        enqueued: outcome.enqueued,
      });
    },
  );
}
