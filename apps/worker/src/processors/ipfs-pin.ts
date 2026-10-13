/**
 * `ipfs-pin` processor (SRS §3.8, FR-8.1–FR-8.4).
 *
 * Reads the staged upload, adds it to the local Kubo node with pinning enabled, records
 * the CID against the version and removes the staged copy. The CID is the
 * tamper-evident fingerprint the licence contract anchors on (§3.9), so it is written
 * inside the tenant transaction together with the audit row.
 */
import { recordAudit, withTenant } from '@void-space/db';
import { UnrecoverableError, type Job } from 'bullmq';
import type { Logger } from 'pino';

import { createIpfsClient, type IpfsClient } from '../lib/ipfs';
import {
  attemptOf,
  createJobContext,
  isRecordNotFound,
  isTerminalFailure,
  type JobPayload,
} from '../lib/job-tracking';
import { removeStagedFile } from '../lib/staging';
import { requestThumbnail } from '../lib/thumbnail';

export interface IpfsPinDeps {
  readonly ipfsApiUrl: string;
  readonly logger: Logger;
  readonly ipfs?: IpfsClient;
}

export function createIpfsPinProcessor(deps: IpfsPinDeps) {
  const ipfs = deps.ipfs ?? createIpfsClient({ apiUrl: deps.ipfsApiUrl });

  return async function processIpfsPin(job: Job<JobPayload>): Promise<Record<string, unknown>> {
    const ctx = createJobContext({
      jobId: String(job.id),
      tenantId: String(job.data.tenantId ?? job.data['tenantId'] ?? ''),
      queue: 'ipfs-pin',
      payload: job.data,
      attempt: attemptOf(job),
      maxAttempts: job.opts.attempts ?? 1,
    });

    const { versionId, stagingPath } = job.data as {
      versionId?: string;
      stagingPath?: string;
    };
    if (!versionId) throw new Error('ipfs-pin job is missing versionId');

    await ctx.markActive();

    try {
      const version = await withTenant(ctx.tenantId, (db) =>
        db.assetVersion.findUnique({
          where: { id: versionId },
          select: {
            id: true,
            assetId: true,
            stagingPath: true,
            format: true,
            sizeBytes: true,
            versionNumber: true,
            pinStatus: true,
            ipfsCid: true,
          },
        }),
      );
      if (!version) {
        // The version is gone, so this job can never succeed: an asset deleted while its ingest
        // was still queued takes its versions with it. Marking it unrecoverable stops BullMQ from
        // spending the retry policy on work that is already moot, and the operator sees one
        // attempt rather than three failures for something that needs no attention.
        throw new UnrecoverableError(
          `AssetVersion ${versionId} no longer exists (tenant ${ctx.tenantId}) — the asset was removed while its ingest was queued`,
        );
      }

      // Idempotent: a retry after a crash mid-write must not re-add the content.
      if (version.ipfsCid && version.pinStatus === 'pinned') {
        await ctx.succeed({ cid: version.ipfsCid, skipped: true });
        // Self-healing as well as idempotent: a version pinned before its preview was ever
        // rendered (the render crashed, or it predates ingest-time rendering) gets one here, and
        // `requestThumbnail` skips instantly when the file is already on disk. After `succeed`,
        // for the same reason as below — a preview must never be able to fail a pin.
        requestThumbnail({ cid: version.ipfsCid, format: version.format, logger: deps.logger });
        return { cid: version.ipfsCid, skipped: true };
      }

      const path = stagingPath ?? version.stagingPath;
      if (!path) {
        throw new Error(
          'No staged file is associated with this version — the upload may have been cleaned up',
        );
      }

      await withTenant(ctx.tenantId, (db) =>
        db.assetVersion.update({ where: { id: versionId }, data: { pinStatus: 'pinning' } }),
      );

      const started = Date.now();
      const { cid, sizeBytes } = await ipfs.add({
        filePath: path,
        fileName: `${version.assetId}-v${version.versionNumber}${version.format}`,
      });

      await withTenant(ctx.tenantId, async (db) => {
        await db.assetVersion.update({
          where: { id: versionId },
          data: {
            ipfsCid: cid,
            pinStatus: 'pinned',
            // The CID now identifies the content; the staged copy is redundant.
            stagingPath: null,
          },
        });

        await recordAudit(
          {
            action: 'ipfs.pinned',
            entityType: 'asset',
            entityId: version.assetId,
            actorLabel: 'worker:ipfs-pin',
            afterState: {
              versionId,
              versionNumber: version.versionNumber,
              cid,
              sizeBytes,
              durationMs: Date.now() - started,
            },
          },
          db,
        );
      });

      // The preview is drawn here, before the staged copy goes away, because it may be drawn from
      // that copy: the file has just been read once to be added to IPFS, it is content-addressed by
      // the CID that now exists, and fetching it back through the gateway at this exact moment is
      // both a second transfer and a race with the node that wrote it moments ago. `requestThumbnail`
      // reports whether it took the file — if it did, the child releases it when the browser has
      // finished reading; if it did not, the copy is redundant now exactly as before.
      //
      // Still fire-and-forget: a detached child is spawned and this returns without waiting, so a
      // browser that hangs or never starts cannot hold the pin job open or spend its retry policy.
      const previewOwnsStagedFile = requestThumbnail({
        cid,
        format: version.format,
        sourcePath: path,
        logger: deps.logger,
      });

      if (!previewOwnsStagedFile) await removeStagedFile(path);

      await ctx.succeed({ cid, durationMs: Date.now() - started });
      deps.logger.info(
        { versionId, cid, bytes: sizeBytes },
        'asset version pinned to IPFS',
      );

      return { cid };
    } catch (error) {
      // A missing row from any write in this processor means the same thing as the lookup above:
      // the version was deleted while its ingest was in flight. The pin itself may well have
      // succeeded — the content is on IPFS, and an unreferenced pin is harmless because content
      // is addressed by its hash — but there is nowhere left to record the CID. So this is an
      // obsolete job, not a platform failure, and it is reported as one.
      const failure = isRecordNotFound(error)
        ? new UnrecoverableError(
            `AssetVersion ${versionId} was deleted while its ingest was in flight (tenant ${ctx.tenantId})`,
          )
        : error;

      // Terminal when the policy is spent *or* the error is unrecoverable — see
      // isTerminalFailure, which also keeps the row out of a permanent "will retry".
      const terminal = isTerminalFailure(failure, ctx);
      await ctx.fail(failure, terminal);

      if (terminal) {
        // FR-8.5 — a version that cannot be pinned is visibly failed rather than silently
        // pending, so the Creator can re-upload it. A version that no longer exists has nothing
        // to mark, which is why this update is allowed to miss.
        await withTenant(ctx.tenantId, (db) =>
          db.assetVersion.update({ where: { id: versionId }, data: { pinStatus: 'failed' } }),
        ).catch(() => undefined);
        deps.logger.error({ err: failure, versionId }, 'ipfs-pin failed permanently');
      } else {
        deps.logger.warn({ err: failure, versionId }, 'ipfs-pin failed — will retry');
      }
      throw failure;
    }
  };
}
