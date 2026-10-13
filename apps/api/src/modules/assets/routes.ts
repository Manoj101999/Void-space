/**
 * Asset routes (SRS §6.4, FR-3.x, FR-4.x).
 *
 *   POST   /api/v1/assets                streamed upload (FR-3.1)
 *   GET    /api/v1/assets                library, filtered + paginated (FR-3.5)
 *   GET    /api/v1/assets/:id            full detail (FR-3.4)
 *   PATCH  /api/v1/assets/:id            edit metadata (FR-3.2)
 *   POST   /api/v1/assets/:id/versions   upload a new version (FR-3.4)
 *   POST   /api/v1/assets/:id/submit     move into the review queue (FR-3.3)
 *   DELETE /api/v1/assets/:id            delete an unpublished asset (FR-3.6)
 *
 * Uploads are `multipart/form-data` with the metadata fields sent *before* the file
 * part, so the request can be validated before 200 MB is streamed to disk.
 */
import {
  assetListQuerySchema,
  createAssetMetadataSchema,
  resubmitAssetSchema,
  updateAssetMetadataSchema,
  type AssetListQuery,
} from '@void-space/types';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { ApiEnv } from '../../env';
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors';
import { parseBody, parseParams, parseQuery } from '../../lib/http';
import { JobProducer } from '../../lib/jobs';
import { StagingStorage, newVersionId, type StagedFile } from '../../lib/storage';
import { createAssetService, type AssetService } from './service';

const idParams = z.object({ id: z.string().uuid() });

export interface AssetRoutesOptions {
  readonly env: ApiEnv;
  /** Shared producer, so every module enqueues through one connection. */
  readonly producer: JobProducer;
}

export async function assetRoutes(app: FastifyInstance, options: AssetRoutesOptions): Promise<void> {
  const { env, producer } = options;
  const storage = new StagingStorage({ stagingDir: env.STAGING_DIR });
  const assets: AssetService = createAssetService({ storage, producer });

  /**
   * Streams one upload: text fields first, then the file part. Returns the staged file
   * plus the raw field values, which are validated only after the file has landed (so a
   * metadata error can never leave a half-written file behind).
   */
  async function readUpload(
    request: FastifyRequest,
    tenantId: string,
  ): Promise<{ versionId: string; staged: StagedFile; fields: Record<string, string> }> {
    const versionId = newVersionId();
    const fields: Record<string, string> = {};
    let staged: StagedFile | null = null;

    for await (const part of request.parts()) {
      if (part.type === 'field') {
        fields[part.fieldname] = String(part.value);
        continue;
      }

      if (staged) {
        // Drain any further file part so the request stream completes cleanly.
        part.file.resume();
        continue;
      }

      staged = await storage.stage({
        tenantId,
        versionId,
        originalName: part.filename,
        declaredMime: part.mimetype,
        source: part.file,
      });
    }

    if (!staged) {
      throw new ValidationError(
        'No file part was found. Send multipart/form-data with the metadata fields first and the file last.',
        { expectedField: 'file' },
      );
    }

    return { versionId, staged, fields };
  }

  /** Turns collected text fields into the shape the Zod schemas expect. */
  function metadataFromFields(fields: Record<string, string>): unknown {
    const tags = fields['tags'];
    return {
      name: fields['name'],
      category: fields['category'],
      ...(tags
        ? {
            tags: tags
              .split(',')
              .map((tag) => tag.trim())
              .filter((tag) => tag.length > 0),
          }
        : {}),
      ...(fields['sourceTool'] ? { sourceTool: fields['sourceTool'] } : {}),
      ...(fields['sourceLicense'] ? { sourceLicense: fields['sourceLicense'] } : {}),
      ...(fields['sourceAttribution'] ? { sourceAttribution: fields['sourceAttribution'] } : {}),
      ...(fields['sourceUrl'] ? { sourceUrl: fields['sourceUrl'] } : {}),
      ...(fields['submitForReview'] !== undefined
        ? { submitForReview: fields['submitForReview'] }
        : {}),
    };
  }

  // ------------------------------------------------------------------ create asset
  app.post(
    '/assets',
    { preHandler: app.requirePermission('asset:upload-own') },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const { versionId, staged, fields } = await readUpload(request, principal.tenantId);
      const metadata = parseBody(createAssetMetadataSchema, metadataFromFields(fields));

      const asset = await assets.create(principal, { metadata, file: staged, versionId });
      request.log.info(
        { assetId: asset.id, bytes: staged.sizeBytes, status: asset.status },
        'asset uploaded',
      );
      return reply.status(201).send({ asset });
    },
  );

  // -------------------------------------------------------------------- list assets
  app.get(
    '/assets',
    { preHandler: app.requirePermission('catalog:view') },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const query = parseQuery(assetListQuerySchema, request.query);
      // FR-3.5 — a Creator browses their own library; reviewers and admins see the whole
      // tenant; the Viewer role is narrowed to published assets inside the service. The
      // narrowing for a Viewer must happen there, not by pinning `creatorId` to a principal
      // who has never uploaded anything — that would empty the catalogue entirely.
      const scoped: AssetListQuery =
        principal.readOnly || principal.permissions.includes('review:decide')
          ? query
          : { ...query, creatorId: principal.userId };

      return reply.status(200).send(await assets.list(principal, scoped));
    },
  );

  // ------------------------------------------------------------------ asset detail
  app.get(
    '/assets/:id',
    { preHandler: app.requirePermission('catalog:view') },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const { id } = parseParams(idParams, request.params);
      const asset = await assets.detail(principal, id);

      // Read scope: unpublished work is visible to its creator and to reviewers only.
      // A missing asset and a forbidden one answer identically, so the API cannot be
      // used to enumerate another workspace's assets.
      const mayReview = principal.permissions.includes('review:decide');
      const owns = asset.creator?.id === principal.userId;
      const isPublished = asset.status === 'published';

      if (!isPublished && !mayReview && !owns) throw new NotFoundError('Asset');
      if (principal.readOnly && !isPublished) throw new NotFoundError('Asset');

      return reply.status(200).send({ asset });
    },
  );

  // ----------------------------------------------------------------- edit metadata
  app.patch(
    '/assets/:id',
    { preHandler: app.requirePermission('asset:upload-own') },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const { id } = parseParams(idParams, request.params);
      const input = parseBody(updateAssetMetadataSchema, request.body);
      return reply.status(200).send({ asset: await assets.updateMetadata(principal, id, input) });
    },
  );

  // -------------------------------------------------------------------- new version
  app.post(
    '/assets/:id/versions',
    { preHandler: app.requirePermission('asset:upload-own') },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const { id } = parseParams(idParams, request.params);
      const { versionId, staged, fields } = await readUpload(request, principal.tenantId);
      const metadata =
        Object.keys(fields).length > 0
          ? parseBody(resubmitAssetSchema, metadataFromFields(fields))
          : undefined;

      const asset = await assets.addVersion(principal, id, { file: staged, versionId, metadata });
      return reply.status(201).send({ asset });
    },
  );

  // ------------------------------------------------------------------------ submit
  app.post(
    '/assets/:id/submit',
    { preHandler: app.requirePermission('asset:upload-own') },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const { id } = parseParams(idParams, request.params);
      return reply.status(200).send({ asset: await assets.submit(principal, id) });
    },
  );

  // ------------------------------------------------------------------------ delete
  app.delete(
    '/assets/:id',
    { preHandler: app.requirePermission('asset:delete-own-unpublished') },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const { id } = parseParams(idParams, request.params);
      await assets.remove(principal, id);
      return reply.status(204).send();
    },
  );
}
