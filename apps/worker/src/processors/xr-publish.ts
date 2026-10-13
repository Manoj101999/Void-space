/**
 * `xr-publish` processor (SRS FR-10.1–FR-10.3, §3.9.4).
 *
 * Pushes a licensed, published asset into the EoN Reality training platform and records the
 * returned module reference. EoN Reality is an external SaaS that is **not** part of the
 * local stack (§4.10 out of scope items are explicit that no such integration exists
 * offline), so the processor supports two modes:
 *
 *   - `EON_API_URL` + `EON_API_KEY` set → POST the manifest for real;
 *   - unset (the default) → the documented *simulated* push: a deterministic manifest is
 *     written, `manifestUrl`/`xrManifestRef` are recorded, and the audit row is marked
 *     `simulated: true` so nobody mistakes it for a live integration (§3.9.4 requires the
 *     simulation to be visible, not hidden).
 */
import { recordAudit, withTenant } from '@void-space/db';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';

import {
  attemptOf,
  createJobContext,
  isTerminalFailure,
  type JobPayload,
} from '../lib/job-tracking';

export interface XrPublishDeps {
  readonly logger: Logger;
  readonly apiUrl: string | undefined;
  readonly apiKey: string | undefined;
  /** Base URL the module is reachable at, e.g. https://localhost/eon */
  readonly publicBaseUrl: string;
  readonly fetchImpl?: typeof fetch;
}

interface XrPublishPayload extends JobPayload {
  readonly assetId?: string;
  readonly tokenId?: string;
  readonly ipfsCid?: string;
}

export function createXrPublishProcessor(deps: XrPublishDeps) {
  const doFetch = deps.fetchImpl ?? fetch;

  return async function processXrPublish(job: Job<XrPublishPayload>): Promise<Record<string, unknown>> {
    const tenantId = String(job.data.tenantId ?? '');
    const ctx = createJobContext({
      jobId: String(job.id),
      tenantId,
      queue: 'xr-publish',
      payload: job.data,
      attempt: attemptOf(job),
      maxAttempts: job.opts.attempts ?? 1,
    });

    const assetId = job.data.assetId;
    if (!assetId) throw new Error('xr-publish job is missing assetId');

    await ctx.markActive();

    try {
      const asset = await withTenant(tenantId, (db) =>
        db.asset.findFirst({
          where: { id: assetId },
          include: {
            currentVersion: { include: { aiSuggestion: true } },
            licenses: { where: { status: 'active' }, take: 1 },
          },
        }),
      );
      if (!asset) throw new Error(`Asset ${assetId} not found in tenant ${tenantId}`);

      const moduleRef = `EON-${asset.id.slice(0, 8).toUpperCase()}-V${asset.currentVersion?.versionNumber ?? 1}`;
      const manifest = {
        moduleRef,
        assetId: asset.id,
        name: asset.name,
        category: asset.category,
        tags: asset.tags,
        ipfsCid: asset.currentVersion?.ipfsCid ?? job.data.ipfsCid ?? null,
        polycount: asset.currentVersion?.polycount ?? null,
        format: asset.currentVersion?.format ?? null,
        licence: asset.licenses[0]
          ? {
              tokenId: asset.licenses[0].tokenId.toString(),
              contractAddress: asset.licenses[0].contractAddress,
              txHash: asset.licenses[0].txHash,
            }
          : null,
        publishedAt: new Date().toISOString(),
      };

      let simulated = true;
      let moduleUrl: string;

      if (deps.apiUrl && deps.apiKey) {
        const response = await doFetch(`${deps.apiUrl.replace(/\/$/, '')}/modules`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.apiKey}` },
          body: JSON.stringify(manifest),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          throw new Error(`EoN Reality returned HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
        }
        const body = (await response.json()) as { moduleUrl?: string; moduleRef?: string };
        moduleUrl = body.moduleUrl ?? `${deps.publicBaseUrl}/${body.moduleRef ?? moduleRef}`;
        simulated = false;
      } else {
        moduleUrl = `${deps.publicBaseUrl}/${moduleRef}`;
      }

      await withTenant(tenantId, async (db) => {
        await db.asset.update({
          where: { id: assetId },
          data: { manifestUrl: moduleUrl, xrManifestRef: moduleRef },
        });

        await recordAudit(
          {
            action: 'xr.published',
            entityType: 'asset',
            entityId: assetId,
            actorLabel: 'worker:xr-publish',
            afterState: { moduleRef, moduleUrl, simulated, manifest },
          },
          db,
        );
      });

      deps.logger.info({ assetId, moduleRef, simulated }, 'asset pushed to EoN Reality');
      await ctx.succeed({ moduleRef, moduleUrl, simulated });
      return { moduleRef, moduleUrl, simulated };
    } catch (error) {
      // Terminal when the policy is spent *or* the error is unrecoverable — see
      // isTerminalFailure, which also keeps the row out of a permanent "will retry".
      const terminal = isTerminalFailure(error, ctx);
      await ctx.fail(error, terminal);
      deps.logger.warn({ err: error, assetId, terminal }, 'EoN publish failed');
      throw error;
    }
  };
}
