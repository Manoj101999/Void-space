/**
 * `chain-license` processor (SRS §3.9, FR-9.1–FR-9.6, FR-10.1).
 *
 * The publish pipeline, in order:
 *
 *   1. build the ERC-721 metadata document for the licence and pin it to IPFS (FR-9.4);
 *   2. `mintLicense(assetId, ipfsCid, licenseTermsHash, recipient)` on the local chain;
 *   3. record the `License` row with the real tx hash, block and gas (FR-9.6);
 *   4. flip the asset to `published` and stamp `publishedAt`;
 *   5. enqueue `xr-publish` so the EoN push happens independently (FR-10.1).
 *
 * The asset only becomes `published` at step 4, which is the point: nothing is advertised as
 * live until a transaction receipt exists.
 */
import { recordAudit, removePublicCatalogEntry, syncPublicCatalogEntry, withTenant } from '@void-space/db';
import { licenseMetadataDocumentSchema, type LicenseMetadataDocument } from '@void-space/types';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';

import { createChainClient, type ChainClient } from '../lib/chain';
import { createIpfsClient, type IpfsClient } from '../lib/ipfs';
import {
  attemptOf,
  createJobContext,
  isTerminalFailure,
  type JobPayload,
} from '../lib/job-tracking';
import type { WorkerProducer } from '../lib/producer';

export interface ChainLicenseDeps {
  readonly logger: Logger;
  readonly rpcUrl: string;
  readonly contractAddress: string;
  readonly privateKey: string;
  readonly ipfsApiUrl: string;
  readonly chain?: ChainClient;
  readonly ipfs?: IpfsClient;
  /** Needed to queue the follow-up EoN push and notification after a mint. */
  readonly producer: WorkerProducer;
}

interface ChainLicensePayload extends JobPayload {
  readonly assetId?: string;
  readonly assetVersionId?: string;
  readonly ipfsCid?: string;
  readonly licenseType?: string;
  readonly licenseTerms?: string | null;
  readonly licenseTermsHash?: string;
  readonly recipientAddress?: string | null;
  readonly publishToXr?: boolean;
  readonly approvingAssessorName?: string;
  readonly approvingDecidedAt?: string;
  readonly action?: 'revoke';
  readonly reason?: string;
}

export function createChainLicenseProcessor(deps: ChainLicenseDeps) {
  const chain = deps.chain ?? createChainClient({
    rpcUrl: deps.rpcUrl,
    contractAddress: deps.contractAddress,
    privateKey: deps.privateKey,
  });
  const ipfs = deps.ipfs ?? createIpfsClient({ apiUrl: deps.ipfsApiUrl });

  return async function processChainLicense(job: Job<ChainLicensePayload>): Promise<Record<string, unknown>> {
    const tenantId = String(job.data.tenantId ?? '');
    const ctx = createJobContext({
      jobId: String(job.id),
      tenantId,
      queue: 'chain-license',
      payload: job.data,
      attempt: attemptOf(job),
      maxAttempts: job.opts.attempts ?? 1,
    });

    const assetId = job.data.assetId;
    if (!assetId) throw new Error('chain-license job is missing assetId');

    await ctx.markActive();

    try {
      if (job.data.action === 'revoke') {
        const result = await revoke(chain, tenantId, assetId, job.data.reason ?? 'unspecified');
        await ctx.succeed(result);
        return result;
      }

      const result = await publish(deps, chain, ipfs, tenantId, job.data as Required<ChainLicensePayload>);
      await ctx.succeed(result);
      return result;
    } catch (error) {
      // Terminal when the policy is spent *or* the error is unrecoverable — see
      // isTerminalFailure, which also keeps the row out of a permanent "will retry".
      const terminal = isTerminalFailure(error, ctx);
      await ctx.fail(error, terminal);

      if (terminal) {
        await withTenant(tenantId, (db) =>
          recordAudit(
            {
              action: 'chain.transaction_failed',
              entityType: 'asset',
              entityId: assetId,
              actorLabel: 'worker:chain-license',
              afterState: { error: error instanceof Error ? error.message : String(error) },
            },
            db,
          ),
        ).catch(() => undefined);
      }

      deps.logger[terminal ? 'error' : 'warn'](
        { err: error, assetId, attempt: ctx.attempt },
        terminal ? 'mint failed permanently' : 'mint failed — will retry',
      );
      throw error;
    }
  };
}

type PublishPayload = ChainLicensePayload & {
  /** Required for the publish path; the intersection removes the optional `?`. */
  readonly assetId: string;
  readonly assetVersionId: string;
  readonly ipfsCid: string;
  readonly licenseType: string;
  readonly licenseTermsHash: string;
};

/** Steps 1–5: metadata pin, mint, record, publish the asset, queue the XR push. */
async function publish(
  deps: ChainLicenseDeps,
  chain: ChainClient,
  ipfs: IpfsClient,
  tenantId: string,
  payload: PublishPayload,
): Promise<Record<string, unknown>> {
  const context = await withTenant(tenantId, async (db) => {
    const asset = await db.asset.findFirst({
      where: { id: payload.assetId },
      include: { currentVersion: true, creator: { select: { fullName: true, email: true } } },
    });
    if (!asset) throw new Error(`Asset ${payload.assetId} not found in tenant ${tenantId}`);

    const suggestion = asset.currentVersion
      ? await db.aISuggestion.findFirst({ where: { assetVersionId: asset.currentVersion.id } })
      : null;

    return {
      name: asset.name,
      category: asset.category,
      tags: asset.tags,
      status: asset.status,
      description: suggestion?.acceptedDescription ?? suggestion?.suggestedDescription ?? undefined,
      creatorName: asset.creator?.fullName ?? null,
    };
  });

  // Idempotency, in two places because the failure it guards against happens in two
  // places: a duplicate *database* row is cheap to avoid, a duplicate *token* is not.
  const existingRow = await withTenant(tenantId, (db) =>
    db.license.findFirst({
      where: { assetId: payload.assetId, status: 'active' },
      select: { tokenId: true },
    }),
  );
  if (existingRow) {
    deps.logger.info(
      { assetId: payload.assetId, tokenId: existingRow.tokenId.toString() },
      'licence already recorded — publishing only',
    );
    await markPublished(deps.producer, chain, tenantId, payload, existingRow.tokenId);
    return { tokenId: existingRow.tokenId.toString(), skipped: true };
  }

  // A previous attempt may have minted and then crashed before writing the row. Ask the
  // chain, which is the only authority on whether a mint happened. Only *valid* tokens are
  // reported, so a revoked licence never makes a republish adopt itself.
  const onChainToken = await chain.findTokenForAsset(payload.assetId);
  if (onChainToken) {
    deps.logger.warn(
      { assetId: payload.assetId, tokenId: onChainToken.toString() },
      'token already exists on chain without a live database row — adopting it instead of minting again',
    );
    await withTenant(tenantId, async (db) => {
      // `upsert`, not `create`: adoption is an idempotent repair of a half-written mint, and a
      // retry after the row lands must reconcile the existing row rather than fail the job with
      // a unique-constraint violation on (tenantId, tokenId).
      await db.license.upsert({
        where: { tenantId_tokenId: { tenantId, tokenId: onChainToken } },
        create: {
          tenantId,
          tokenId: onChainToken,
          assetId: payload.assetId,
          assetVersionId: payload.assetVersionId,
          approverId: null,
          contractAddress: chain.contractAddress,
          // Deliberately null, not a sentinel: we genuinely did not observe the transaction, and a
          // `tx_hash` holding anything but a hash is a lie that every consumer (explorer links,
          // hash validation, diffing against the chain) would have to special-case. The adoption is
          // recorded in the audit ledger instead, where it can be explained.
          txHash: null,
          licenseTermsHash: payload.licenseTermsHash,
          licenseType: payload.licenseType,
          licenseTerms: payload.licenseTerms ?? null,
          recipientAddress: payload.recipientAddress ?? null,
          ipfsMetadataCid: null,
          status: 'active',
        },
        update: {
          assetId: payload.assetId,
          assetVersionId: payload.assetVersionId,
          licenseTermsHash: payload.licenseTermsHash,
          licenseType: payload.licenseType,
          licenseTerms: payload.licenseTerms ?? null,
          recipientAddress: payload.recipientAddress ?? null,
          status: 'active',
        },
      });

      await recordAudit(
        {
          action: 'chain.license_adopted',
          entityType: 'license',
          entityId: onChainToken.toString(),
          actorLabel: 'worker:chain-license',
          afterState: {
            assetId: payload.assetId,
            tokenId: onChainToken.toString(),
            reason: 'token present on chain without a database row',
            txHash: null,
          },
        },
        db,
      );
    });
    await markPublished(deps.producer, chain, tenantId, payload, onChainToken);
    return { tokenId: onChainToken.toString(), adopted: true };
  }

  // 1. The licence document that backs `tokenURI` (FR-9.4). Written to IPFS so the CID in
  //    the token cannot be swapped for different terms later.
  const tokenIdPreview = (await chain.totalMinted()) + 1n;
  const document: LicenseMetadataDocument = licenseMetadataDocumentSchema.parse({
    name: `${context.name} — ${payload.licenseType} licence`,
    description: context.description,
    assetId: payload.assetId,
    assetName: context.name,
    ipfsCid: payload.ipfsCid,
    licenseType: payload.licenseType,
    licenseTermsHash: payload.licenseTermsHash,
    approvingAssessor: {
      userId: '00000000-0000-4000-8000-000000000000',
      reference: payload.approvingAssessorName ?? 'platform publisher',
      decidedAt: payload.approvingDecidedAt ?? new Date().toISOString(),
    },
    mintedAt: new Date().toISOString(),
    tokenId: tokenIdPreview.toString(),
    contractAddress: chain.contractAddress,
    licenseTerms: payload.licenseTerms ?? undefined,
  });

  const metadataPath = await writeTempJson(document);
  const metadata = await ipfs.add({ filePath: metadataPath, fileName: `licence-${payload.assetId}.json` });

  // 2. Mint.
  const minted = await chain.mint({
    assetId: payload.assetId,
    ipfsCid: payload.ipfsCid,
    licenseTermsHash: payload.licenseTermsHash as `0x${string}`,
    recipient: payload.recipientAddress ?? undefined,
  });

  // 3. Record what actually happened on chain.
  //
  // `(tenantId, tokenId)` is unique, and the contract's token counter starts at 1. The demo
  // seed fabricates a couple of licence rows so the UI has something to render before any
  // real mint — so the first genuine mint can land on a token id the seed already used. When
  // that happens the on-chain transaction is the truth and the fabricated row is replaced,
  // with a warning so the substitution is never invisible.
  const record = {
    assetId: payload.assetId,
    assetVersionId: payload.assetVersionId,
    approverId: null,
    contractAddress: chain.contractAddress,
    txHash: minted.txHash,
    blockNumber: minted.blockNumber,
    gasUsed: minted.gasUsed,
    licenseTermsHash: payload.licenseTermsHash,
    // FR-9.1/§3.9.2 — the terms themselves plus their hash travel with the licence, so the
    // registry can be audited without re-deriving anything.
    licenseType: payload.licenseType,
    licenseTerms: payload.licenseTerms ?? null,
    recipientAddress: payload.recipientAddress ?? null,
    ipfsMetadataCid: metadata.cid,
    status: 'active' as const,
  };

  await withTenant(tenantId, async (db) => {
    const existingRow = await db.license.findFirst({
      where: { tenantId, tokenId: minted.tokenId },
      select: { id: true, txHash: true },
    });

    if (existingRow) {
      deps.logger.warn(
        { tokenId: minted.tokenId.toString(), previousTx: existingRow.txHash },
        'token id was already present (demo seed row) — replacing it with the on-chain record',
      );
      await db.license.update({ where: { id: existingRow.id }, data: record });
      return;
    }

    await db.license.create({ data: { tenantId, tokenId: minted.tokenId, ...record } });
  });

  // The token's metadata pointer must be set by the publisher (the contract allows it only
  // for the publisher role), so this is a second, cheap transaction.
  await chain.setMetadataCid(minted.tokenId, metadata.cid).catch((error: unknown) => {
    deps.logger.warn({ err: error, tokenId: minted.tokenId.toString() }, 'could not set token metadata CID');
  });

  // 4. Publish the asset.
  await markPublished(deps.producer, chain, tenantId, payload, minted.tokenId, {
    txHash: minted.txHash,
    blockNumber: minted.blockNumber,
    gasUsed: minted.gasUsed,
  }, context.name);

  return {
    tokenId: minted.tokenId.toString(),
    txHash: minted.txHash,
    blockNumber: minted.blockNumber.toString(),
    metadataCid: metadata.cid,
  };
}

/** Flips the asset to `published` and queues the EoN push. */
async function markPublished(
  producer: WorkerProducer,
  chain: ChainClient,
  tenantId: string,
  payload: PublishPayload,
  tokenId: bigint,
  receipt?: { txHash: string; blockNumber: bigint; gasUsed: bigint },
  assetName?: string,
): Promise<void> {
  const jobId = crypto.randomUUID();

  await withTenant(tenantId, async (db) => {
    const asset = await db.asset.findFirst({
      where: { id: payload.assetId },
      select: { name: true, status: true, creatorId: true },
    });

    await db.asset.update({
      where: { id: payload.assetId },
      data: { status: 'published', publishedAt: new Date() },
    });

    await recordAudit(
      {
        action: 'asset.published',
        entityType: 'asset',
        entityId: payload.assetId,
        actorLabel: 'worker:chain-license',
        beforeState: { status: asset?.status ?? 'approved' },
        afterState: {
          status: 'published',
          tokenId: tokenId.toString(),
          contractAddress: chain.contractAddress,
          ipfsCid: payload.ipfsCid,
        },
        txHash: receipt?.txHash,
        blockNumber: receipt?.blockNumber,
        gasUsed: receipt?.gasUsed,
      },
      db,
    );

    // §6.1 — the marketplace is an anonymous read model, so the projection is written here, at the
    // only moment an asset can genuinely be listed: after a receipt exists. A takedown deletes it.
    await syncPublicCatalogEntry(db, { tenantId, assetId: payload.assetId });

    if (payload.publishToXr !== false) {
      const xrPayload = {
        tenantId,
        assetId: payload.assetId,
        tokenId: tokenId.toString(),
        ipfsCid: payload.ipfsCid,
      };

      await db.job.create({
        data: {
          id: jobId,
          tenantId,
          queue: 'xr_publish',
          status: 'queued',
          entityType: 'asset',
          entityId: payload.assetId,
          payload: xrPayload as never,
          maxAttempts: 3,
        },
      });

      // Queue it for real: writing the row alone left the job invisible to the worker.
      await producer.enqueue({
        id: jobId,
        queue: 'xr-publish',
        payload: xrPayload,
        maxAttempts: 3,
      });
    }

    if (asset) {
      const notifyId = crypto.randomUUID();
      const notifyPayload = {
        tenantId,
        event: 'asset.published',
        recipientIds: [asset.creatorId],
        title: `"${assetName ?? asset.name}" is live`,
        body: `Licence token #${tokenId.toString()} minted.`,
        metadata: { assetId: payload.assetId, tokenId: tokenId.toString() },
      };

      await db.job.create({
        data: {
          id: notifyId,
          tenantId,
          queue: 'notify',
          status: 'queued',
          entityType: 'asset',
          entityId: payload.assetId,
          payload: notifyPayload as never,
          maxAttempts: 2,
        },
      });

      await producer.enqueue({
        id: notifyId,
        queue: 'notify',
        payload: notifyPayload,
        maxAttempts: 2,
      });
    }
  });
}

/** Revokes the on-chain licence for an asset (FR-9.5). */
async function revoke(
  chain: ChainClient,
  tenantId: string,
  assetId: string,
  reason: string,
): Promise<Record<string, unknown>> {
  const license = await withTenant(tenantId, (db) =>
    db.license.findFirst({
      where: { assetId, status: 'revoked' },
      orderBy: { mintedAt: 'desc' },
      select: { id: true, tokenId: true },
    }),
  );
  if (!license) throw new Error(`No revoked licence row found for asset ${assetId}`);

  const result = await chain.revoke(license.tokenId, reason.slice(0, 200));

  await withTenant(tenantId, (db) =>
    db.license.update({ where: { id: license.id }, data: { revokedTxHash: result.txHash } }),
  );

  // §6.1/FR-9.5 — a takedown removes the asset from the marketplace. The token is not burned and
  // the licence row keeps its history; only the public listing goes away.
  await removePublicCatalogEntry(assetId);

  return { tokenId: license.tokenId.toString(), txHash: result.txHash, revoked: true };
}

/** Writes a temporary JSON file so the IPFS client can stream it like any other content. */
async function writeTempJson(document: unknown): Promise<string> {
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'void-space-licence-'));
  const path = join(dir, 'licence.json');
  await writeFile(path, JSON.stringify(document, null, 2), 'utf8');
  return path;
}
