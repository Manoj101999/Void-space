/**
 * Publishing & licensing (SRS FR-9.x, §3.9, §6.5).
 *
 *   POST /api/v1/assets/:id/publish         approve -> licence mint + EoN push (asset:publish)
 *   POST /api/v1/assets/:id/license/revoke  takedown                             (asset:revoke-license)
 *   GET  /api/v1/licenses                   licence registry list                (catalog:view)
 *   GET  /api/v1/licenses/:tokenId          on-chain detail + explorer links    (catalog:view)
 *
 * Publishing is asynchronous by design (§3.10): the request records intent and enqueues
 * `chain-license`, so a slow or briefly-unreachable chain never blocks the Assessor's UI.
 * The asset stays `approved` until the worker has a transaction receipt — the UI shows the
 * job, not a lie about being published.
 */
import { createHash, randomUUID } from 'node:crypto';

import { publishAssetSchema, revokeLicenseSchema, type LicenseDetail } from '@void-space/types';
import { recordAudit, withTenant } from '@void-space/db';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import type { ApiEnv } from '../../env';
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors';
import { parseBody, parseParams } from '../../lib/http';
import type { JobProducer } from '../../lib/jobs';

const idParams = z.object({ id: z.string().uuid() });
const tokenParams = z.object({ tokenId: z.string().regex(/^\d+$/) });

export interface LicensingRoutesOptions {
  readonly env: ApiEnv;
  readonly producer: JobProducer;
}

/** Enqueues a job and mirrors it into `jobs` so the UI can poll it (FR-11.2). */
async function enqueue(
  producer: JobProducer,
  params: {
    readonly tenantId: string;
    readonly queue: 'chain-license' | 'xr-publish' | 'notify';
    readonly entityType: string;
    readonly entityId: string;
    readonly payload: Record<string, unknown>;
    readonly maxAttempts: number;
  },
): Promise<string> {
  const jobId = randomUUID();

  await withTenant(params.tenantId, (db) =>
    db.job.create({
      data: {
        id: jobId,
        tenantId: params.tenantId,
        queue: params.queue.replace(/-/g, '_') as never,
        status: 'queued',
        entityType: params.entityType,
        entityId: params.entityId,
        payload: { ...params.payload, tenantId: params.tenantId } as never,
        maxAttempts: params.maxAttempts,
      },
    }),
  );

  const outcome = await producer.enqueue({
    id: jobId,
    queue: params.queue,
    tenantId: params.tenantId,
    entityType: params.entityType,
    entityId: params.entityId,
    payload: { ...params.payload, tenantId: params.tenantId },
    maxAttempts: params.maxAttempts,
  });

  if (!outcome.enqueued) {
    await withTenant(params.tenantId, (db) =>
      db.job.update({
        where: { id: jobId },
        data: { status: 'failed', error: outcome.error ?? 'queue unreachable', finishedAt: new Date() },
      }),
    );
  }

  return jobId;
}

export async function licensingRoutes(
  app: FastifyInstance,
  options: LicensingRoutesOptions,
): Promise<void> {
  const { env, producer } = options;
  const explorerBase = env.CHAIN_EXPLORER_URL?.replace(/\/+$/, '') ?? null;

  // ------------------------------------------------------------------- publish
  app.post(
    '/assets/:id/publish',
    { preHandler: app.requirePermission('asset:publish') },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const { id } = parseParams(idParams, request.params);
      const input = parseBody(publishAssetSchema, request.body);

      const outcome = await withTenant(principal.tenantId, async (db) => {
        const asset = await db.asset.findFirst({
          where: { id, tenantId: principal.tenantId },
          include: {
            currentVersion: true,
            licenses: { where: { status: 'active' }, take: 1 },
            decisions: { orderBy: { createdAt: 'desc' }, take: 1, include: { assessor: true } },
          },
        });
        if (!asset) throw new NotFoundError('Asset');

        // FR-9.1 — only an approved asset may be published, and only once.
        if (asset.status !== 'approved') {
          throw new ConflictError(
            `Only an approved asset can be published (this one is "${asset.status}")`,
            'ASSET_NOT_APPROVED',
            { status: asset.status },
          );
        }
        if (asset.licenses.length > 0) {
          throw new ConflictError('This asset already carries an active licence', 'ALREADY_LICENSED');
        }
        if (!asset.currentVersion?.ipfsCid) {
          throw new ConflictError(
            'The current version has not been pinned to IPFS yet',
            'VERSION_NOT_PINNED',
            { pinStatus: asset.currentVersion?.pinStatus ?? 'unknown' },
          );
        }

        // §3.9.2 — the contract anchors the *terms hash*, so the terms are hashed here
        // and travel with the job rather than being re-derived later.
        const termsDocument = [
          `licenseType: ${input.licenseType}`,
          input.licenseTerms ?? '',
          `assetId: ${asset.id}`,
          `assetVersionId: ${asset.currentVersion.id}`,
          `ipfsCid: ${asset.currentVersion.ipfsCid}`,
        ].join('\n');
        const licenseTermsHash = `0x${createHash('sha256').update(termsDocument).digest('hex')}`;

        const approving = asset.decisions[0] ?? null;

        await recordAudit(
          {
            action: 'asset.publish_requested',
            entityType: 'asset',
            entityId: asset.id,
            actorId: principal.userId,
            actorLabel: `${principal.fullName} <${principal.email}>`,
            beforeState: { status: asset.status },
            afterState: {
              licenseType: input.licenseType,
              licenseTermsHash,
              ipfsCid: asset.currentVersion.ipfsCid,
              publishToXr: input.publishToXr,
            },
          },
          db,
        );

        return {
          assetName: asset.name,
          assetVersionId: asset.currentVersion.id,
          ipfsCid: asset.currentVersion.ipfsCid,
          licenseTermsHash,
          approvingAssessorId: approving?.assessorId ?? principal.userId,
          approvingAssessorName: approving?.assessor?.fullName ?? principal.fullName,
          approvingDecidedAt: (approving?.createdAt ?? new Date()).toISOString(),
        };
      });

      const chainLicenseJobId = await enqueue(producer, {
        tenantId: principal.tenantId,
        queue: 'chain-license',
        entityType: 'asset',
        entityId: id,
        maxAttempts: 3,
        payload: {
          assetId: id,
          assetVersionId: outcome.assetVersionId,
          ipfsCid: outcome.ipfsCid,
          licenseType: input.licenseType,
          licenseTerms: input.licenseTerms ?? null,
          licenseTermsHash: outcome.licenseTermsHash,
          recipientAddress: input.recipientAddress ?? null,
          publishToXr: input.publishToXr,
          requestedById: principal.userId,
          approvingAssessorName: outcome.approvingAssessorName,
          approvingDecidedAt: outcome.approvingDecidedAt,
        },
      });

      return reply.status(202).send({
        assetId: id,
        status: 'approved',
        chainLicenseJobId,
        xrPublishJobId: null,
        message: 'Minting the licence on chain; the asset publishes when the transaction confirms.',
      });
    },
  );

  // -------------------------------------------------------------------- revoke
  app.post(
    '/assets/:id/license/revoke',
    { preHandler: app.requirePermission('asset:revoke-license') },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const { id } = parseParams(idParams, request.params);
      const input = parseBody(revokeLicenseSchema, request.body);

      // The recipient is read inside the transaction and carried out of it, so the notification
      // is enqueued once the revocation has actually committed.
      const recipient = await withTenant(principal.tenantId, async (db) => {
        const license = await db.license.findFirst({
          where: { assetId: id, tenantId: principal.tenantId, status: 'active' },
          orderBy: { mintedAt: 'desc' },
        });
        if (!license) throw new NotFoundError('Active licence');

        // FR-9.5 — a takedown flags the licence; the history is never deleted.
        await db.license.update({
          where: { id: license.id },
          data: { status: 'revoked', revokedReason: input.reason, revokedAt: new Date() },
        });

        const asset = await db.asset.findFirst({
          where: { id, tenantId: principal.tenantId },
          select: { name: true, creatorId: true },
        });

        await recordAudit(
          {
            action: 'chain.license_revoked',
            entityType: 'asset',
            entityId: id,
            actorId: principal.userId,
            actorLabel: `${principal.fullName} <${principal.email}>`,
            beforeState: { licenseStatus: license.status, tokenId: license.tokenId.toString() },
            afterState: { licenseStatus: 'revoked', reason: input.reason },
          },
          db,
        );

        return asset;
      });

      // The on-chain revocation runs asynchronously; the DB flag is immediate so the UI and
      // the catalog stop offering the licence right away.
      const chainRevokeJobId = await enqueue(producer, {
        tenantId: principal.tenantId,
        queue: 'chain-license',
        entityType: 'asset',
        entityId: id,
        maxAttempts: 3,
        payload: { assetId: id, action: 'revoke', reason: input.reason },
      });

      // Notifying the Creator goes through `enqueue`, like every other job in this file. Writing
      // the `jobs` row directly and stopping there produced a row that read "queued" forever:
      // no BullMQ job existed, so the worker never picked it up and the Creator was never told
      // their licence had been pulled.
      if (recipient) {
        await enqueue(producer, {
          tenantId: principal.tenantId,
          queue: 'notify',
          entityType: 'asset',
          entityId: id,
          maxAttempts: 2,
          payload: {
            event: 'asset.revoked',
            recipientIds: [recipient.creatorId],
            title: `Licence revoked for "${recipient.name}"`,
            body: input.reason,
            metadata: { assetId: id },
          },
        });
      }

      return reply.status(202).send({
        assetId: id,
        revoked: true,
        chainLicenseJobId: chainRevokeJobId,
        message: 'Licence flagged revoked; the on-chain revocation is confirming.',
      });
    },
  );

  // -------------------------------------------------------------------- listing
  app.get(
    '/licenses',
    { preHandler: app.requirePermission('catalog:view') },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const licenses = await withTenant(principal.tenantId, (db) =>
        db.license.findMany({
          where: { tenantId: principal.tenantId },
          orderBy: { mintedAt: 'desc' },
          take: 100,
          include: { asset: { select: { id: true, name: true, status: true } } },
        }),
      );

      return reply.status(200).send({
        licenses: licenses.map((license) => toDetail(license, explorerBase)),
        total: licenses.length,
      });
    },
  );

  app.get(
    '/licenses/:tokenId',
    { preHandler: app.requirePermission('catalog:view') },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new ForbiddenError('Authentication required', 'UNAUTHENTICATED');

      const { tokenId } = parseParams(tokenParams, request.params);

      const license = await withTenant(principal.tenantId, (db) =>
        db.license.findFirst({
          where: { tenantId: principal.tenantId, tokenId: BigInt(tokenId) },
          include: { asset: { select: { id: true, name: true, status: true } } },
        }),
      );
      if (!license) throw new NotFoundError('Licence');

      return reply.status(200).send({ license: toDetail(license, explorerBase) });
    },
  );
}

interface LicenseRow {
  readonly id: string;
  readonly tokenId: bigint;
  readonly contractAddress: string;
  readonly txHash: string | null;
  readonly blockNumber: bigint | null;
  readonly gasUsed: bigint | null;
  readonly ipfsMetadataCid: string | null;
  readonly licenseTermsHash: string;
  readonly status: string;
  readonly revokedReason: string | null;
  readonly mintedAt: Date;
  readonly approverId: string | null;
  readonly asset?: { id: string; name: string; status: string } | null;
}

/** §6.5 — one shape for the licence drawer and the registry table. */
function toDetail(license: LicenseRow, explorerBase: string | null): LicenseDetail {
  return {
    tokenId: license.tokenId.toString(),
    contractAddress: license.contractAddress,
    txHash: license.txHash,
    blockNumber: license.blockNumber?.toString() ?? null,
    gasUsed: license.gasUsed?.toString() ?? null,
    ipfsCid: license.ipfsMetadataCid ?? '',
    licenseTermsHash: license.licenseTermsHash,
    status: license.status as LicenseDetail['status'],
    revokedReason: license.revokedReason,
    mintedAt: license.mintedAt.toISOString(),
    tokenUri: license.ipfsMetadataCid ? `/ipfs/${license.ipfsMetadataCid}` : null,
    approverRef: license.approverId,
    asset: license.asset ?? null,
    explorer: {
      // No local explorer ships with the stack, so a base URL configured via
      // CHAIN_EXPLORER_URL is the only case where these links exist (FR-9.6).
      txUrl: explorerBase && license.txHash ? `${explorerBase}/tx/${license.txHash}` : null,
      addressUrl: explorerBase ? `${explorerBase}/address/${license.contractAddress}` : null,
    },
  };
}
