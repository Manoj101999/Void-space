/**
 * `ai-enrichment` processor (SRS FR-7.x, §3.10).
 *
 * Retry policy from §3.10: "1 automatic retry with a stricter prompt, then flagged
 * needs_manual_review". The second attempt failing is therefore *not* a job failure — it is
 * the documented escalation path, so the processor records a suggestion carrying
 * `needsManualReview` and moves the asset to `needs_manual_review` (FR-7.3) rather than
 * throwing. Only infrastructure errors (DB down, unknown version) fail the job.
 */
import { recordAudit, withTenant } from '@void-space/db';
import { UnrecoverableError, type Job } from 'bullmq';
import type { Logger } from 'pino';

import { selectEnricher, type EnrichmentInput, type Enricher } from '../lib/enricher';
import {
  attemptOf,
  createJobContext,
  isRecordNotFound,
  isTerminalFailure,
  type JobPayload,
} from '../lib/job-tracking';

export interface AiEnrichmentDeps {
  readonly logger: Logger;
  readonly apiKey: string | undefined;
  readonly model: string;
  readonly timeoutMs: number;
  /** Injected in tests to run the pipeline without the network. */
  readonly enricher?: Enricher;
}

export function createAiEnrichmentProcessor(deps: AiEnrichmentDeps) {
  const enricher =
    deps.enricher ??
    selectEnricher({ apiKey: deps.apiKey, model: deps.model, timeoutMs: deps.timeoutMs });

  return async function processAiEnrichment(
    job: Job<JobPayload>,
  ): Promise<Record<string, unknown>> {
    const tenantId = String(job.data['tenantId'] ?? '');
    const ctx = createJobContext({
      jobId: String(job.id),
      tenantId,
      queue: 'ai-enrichment',
      payload: job.data,
      attempt: attemptOf(job),
      maxAttempts: job.opts.attempts ?? 1,
    });

    const versionId = job.data.versionId ?? null;

    /**
     * The asset the suggestion hangs off, once the lookup has resolved it.
     *
     * Declared before `markActive` so that nothing but the `try` sits between marking the job
     * active and handling its failure — see the structural test in `test/processor-structure`.
     */
    let assetId: string | null = null;

    await ctx.markActive();

    try {
      if (!versionId) throw new UnrecoverableError('ai-enrichment job is missing versionId');

      const context = await withTenant(tenantId, async (db) => {
        const version = await db.assetVersion.findFirst({
          where: { id: versionId },
          include: { asset: { select: { id: true, name: true, category: true, tags: true } } },
        });
        if (!version) {
          // Gone for good, so retrying cannot help: an asset deleted while its ingest was queued
          // takes its versions with it.
          throw new UnrecoverableError(
            `AssetVersion ${versionId} no longer exists (tenant ${tenantId}) — the asset was removed while its ingest was queued`,
          );
        }

        const settings = await db.tenantSettings.findUnique({
          where: { tenantId },
          select: { defaultPolycountBudget: true },
        });

        return {
          assetId: version.asset.id,
          name: version.asset.name,
          category: version.asset.category,
          creatorTags: version.asset.tags,
          format: version.format,
          sizeBytes: Number(version.sizeBytes),
          sourceTool: version.sourceTool,
          mesh: {
            polycount: version.polycount,
            vertices: version.vertices,
            materials: version.materials,
            animations: version.animations,
            textures: version.textures,
          },
          polycountBudget: settings?.defaultPolycountBudget ?? null,
        };
      });
      assetId = context.assetId;

      // §3.10 — attempt 2 is the stricter prompt.
      const outcome = await enricher.enrich({
        ...context,
        strict: ctx.attempt > 1,
      } satisfies EnrichmentInput);

      await withTenant(tenantId, async (db) => {
        // FR-7.4 — suggestions are stored *beside* Creator metadata, never merged into it.
        const suggestion = {
          suggestedTags: outcome.result.tags,
          suggestedDescription: outcome.result.description,
          qualityFlags: outcome.result.qualityFlags,
          confidence: outcome.result.confidence,
          modelVersion: outcome.modelVersion,
          promptVersion: outcome.promptVersion,
          latencyMs: outcome.latencyMs,
          needsManualReview: false,
          rawResponse: outcome.rawResponse as never,
        };

        await db.aISuggestion.upsert({
          where: { assetVersionId: versionId },
          create: { tenantId, assetVersionId: versionId, ...suggestion },
          update: suggestion,
        });

        await recordAudit(
          {
            action: 'ai.enrichment_completed',
            entityType: 'asset',
            entityId: context.assetId,
            actorLabel: 'worker:ai-enrichment',
            afterState: {
              versionId,
              modelVersion: outcome.modelVersion,
              promptVersion: outcome.promptVersion,
              confidence: outcome.result.confidence,
              tags: outcome.result.tags,
              qualityFlags: outcome.result.qualityFlags,
              latencyMs: outcome.latencyMs,
              attempt: ctx.attempt,
            },
          },
          db,
        );
      });

      await ctx.succeed({
        modelVersion: outcome.modelVersion,
        confidence: outcome.result.confidence,
        tagCount: outcome.result.tags.length,
      });

      deps.logger.info(
        { versionId, model: outcome.modelVersion, confidence: outcome.result.confidence },
        'asset enriched',
      );

      return { tags: outcome.result.tags, confidence: outcome.result.confidence };
    } catch (error) {
      // A missing row anywhere in this processor means the asset was deleted while its ingest was
      // in flight — the same obsolete-subject case as the lookup above, arriving later.
      const failure = isRecordNotFound(error)
        ? new UnrecoverableError(
            `AssetVersion ${versionId} was deleted while its ingest was in flight (tenant ${tenantId})`,
          )
        : error;

      // Terminal when the policy is spent *or* the error is unrecoverable — see
      // isTerminalFailure, which also keeps the row out of a permanent "will retry".
      const terminal = isTerminalFailure(failure, ctx);
      await ctx.fail(failure, terminal);

      if (!terminal) {
        deps.logger.warn(
          { err: failure, versionId, attempt: ctx.attempt },
          'enrichment failed — retrying with a stricter prompt',
        );
        throw failure;
      }

      // Escalation is the SRS's fallback for geometry the model cannot classify: it records a
      // `needs_manual_review` suggestion *against the asset*. With the asset gone there is nothing
      // to escalate against and no reviewer who could act, so the job ends here rather than
      // failing on a foreign key. The attempt is still recorded as failed and terminal, which is
      // what the dashboard needs to show.
      if (assetId === null || versionId === null || isRecordNotFound(error)) {
        deps.logger.error(
          { err: failure, versionId },
          'ai-enrichment ended — the asset no longer exists, so there is nothing to escalate',
        );
        throw failure;
      }

      await escalateToHuman(deps, { tenantId, versionId, assetId, error: failure, enricher });
      await ctx.succeed({ needsManualReview: true });
      return { needsManualReview: true };
    }
  };
}

/**
 * FR-7.3 — the documented escalation when the model cannot produce valid output even under
 * the stricter prompt: flag the asset for manual classification instead of retrying forever.
 */
async function escalateToHuman(
  deps: AiEnrichmentDeps,
  params: {
    readonly tenantId: string;
    readonly versionId: string;
    readonly assetId: string;
    readonly error: unknown;
    readonly enricher: Enricher;
  },
): Promise<void> {
  const message = params.error instanceof Error ? params.error.message : String(params.error);

  await withTenant(params.tenantId, async (db) => {
    const fallback = {
      suggestedTags: [],
      suggestedDescription:
        'Automatic classification did not produce a valid result. A reviewer must classify this asset manually.',
      qualityFlags: ['enrichment-failed'],
      confidence: 0,
      modelVersion: params.enricher.modelVersion,
      promptVersion: 'v1-strict',
      needsManualReview: true,
      rawResponse: { error: message } as never,
    };

    await db.aISuggestion.upsert({
      where: { assetVersionId: params.versionId },
      create: { tenantId: params.tenantId, assetVersionId: params.versionId, ...fallback },
      update: fallback,
    });

    // The asset leaves the normal queue for manual attention.
    await db.asset.update({
      where: { id: params.assetId },
      data: { status: 'needs_manual_review' },
    });

    await recordAudit(
      {
        action: 'ai.enrichment_failed',
        entityType: 'asset',
        entityId: params.assetId,
        actorLabel: 'worker:ai-enrichment',
        afterState: { versionId: params.versionId, needsManualReview: true, error: message },
      },
      db,
    );
  });

  deps.logger.error(
    { err: params.error, versionId: params.versionId },
    'enrichment failed permanently — flagged for manual review',
  );
}
