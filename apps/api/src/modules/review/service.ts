/**
 * Review workflow (SRS FR-4.x, FR-7.5, §5.1, §6.1).
 *
 * The human-in-the-loop gate. Three rules shape it:
 *
 * 1. A decision is only legal for an asset that is actually in the review path
 *    (`pending` / `needs_manual_review`) — the §5.1 transition table decides.
 * 2. AI output is never applied silently: an Assessor has to *accept* tags or the
 *    description explicitly, and the acceptance is recorded on the suggestion itself
 *    (FR-7.5) so the audit trail shows what was adopted.
 * 3. Every decision writes an immutable `ReviewDecision` row, so an asset's full review
 *    history survives later re-submissions (FR-4.2).
 */
import { recordAudit, withTenant, type Prisma } from '@void-space/db';
import {
  canTransition,
  commentRequiredFor,
  REVIEWABLE_STATUSES,
  type AssetStatus,
  type AuthPrincipal,
  type ReviewDecisionInput,
  type ReviewQueueQuery,
  type ReviewQueueStats,
} from '@void-space/types';
import { ConflictError, NotFoundError } from '../../lib/errors';
import type { JobProducer } from '../../lib/jobs';
import type { AssetDetail } from '@void-space/types';
import { createAssetService, type AssetService } from '../assets/service';
import type { StagingStorage } from '../../lib/storage';

type TenantDb = Prisma.TransactionClient;

/** Lifecycle status each review decision produces. */
const DECISION_STATUS: Record<ReviewDecisionInput['decision'], AssetStatus> = {
  approved: 'approved',
  rejected: 'rejected',
  revision: 'revision',
};

/** Notification event per decision (FR-12.2). */
const DECISION_EVENT: Record<ReviewDecisionInput['decision'], string> = {
  approved: 'review.approved',
  rejected: 'review.rejected',
  revision: 'review.revision',
};

export interface ReviewQueueItem {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly status: AssetStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly creator: { id: string; fullName: string } | null;
  readonly version: {
    readonly id: string;
    readonly versionNumber: number;
    readonly format: string;
    readonly sizeBytes: number;
    readonly polycount: number | null;
    readonly pinStatus: string;
    readonly ipfsCid: string | null;
    readonly gatewayUrl: string | null;
  } | null;
  readonly ai: {
    readonly confidence: number;
    readonly tags: readonly string[];
    readonly description: string;
    readonly qualityFlags: readonly string[];
    readonly needsManualReview: boolean;
    readonly modelVersion: string;
  } | null;
  /** Hours since submission, for the "oldest first" triage view. */
  readonly waitingHours: number | null;
}

export interface ReviewServiceDeps {
  readonly producer: JobProducer;
  readonly storage: StagingStorage;
}

export interface ReviewService {
  queue(principal: AuthPrincipal, query: ReviewQueueQuery): Promise<{
    items: ReviewQueueItem[];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  }>;
  stats(principal: AuthPrincipal): Promise<ReviewQueueStats & { oldestWaitingHours: number | null }>;
  decide(principal: AuthPrincipal, assetId: string, input: ReviewDecisionInput): Promise<AssetDetail>;
  comment(
    principal: AuthPrincipal,
    assetId: string,
    input: { body: string; parentId?: string | null | undefined },
  ): Promise<AssetDetail>;
}

export function createReviewService(deps: ReviewServiceDeps): ReviewService {
  const assets: AssetService = createAssetService({ storage: deps.storage, producer: deps.producer });

  /** Enqueues a notification without letting a queue outage fail the decision. */
  async function notify(
    db: TenantDb,
    params: {
      readonly tenantId: string;
      readonly event: string;
      readonly assetId: string;
      readonly recipients: readonly string[];
      readonly title: string;
      readonly body: string;
    },
  ): Promise<void> {
    const jobId = crypto.randomUUID();
    const payload = {
      tenantId: params.tenantId,
      event: params.event,
      recipientIds: params.recipients,
      title: params.title,
      body: params.body,
      metadata: { assetId: params.assetId },
    };

    await db.job.create({
      data: {
        id: jobId,
        tenantId: params.tenantId,
        queue: 'notify',
        status: 'queued',
        entityType: 'asset',
        entityId: params.assetId,
        payload: payload as Prisma.InputJsonValue,
        maxAttempts: 2,
      },
    });

    const outcome = await deps.producer.enqueue({
      id: jobId,
      queue: 'notify',
      tenantId: params.tenantId,
      entityType: 'asset',
      entityId: params.assetId,
      payload,
      maxAttempts: 2,
    });

    if (!outcome.enqueued) {
      await db.job.update({
        where: { id: jobId },
        data: { status: 'failed', error: outcome.error ?? 'queue unreachable', finishedAt: new Date() },
      });
    }
  }

  // -------------------------------------------------------------------- queue

  /** FR-4.1 — the Assessor's triage list, oldest submission first. */
  async function queue(principal: AuthPrincipal, query: ReviewQueueQuery): Promise<{
    items: ReviewQueueItem[];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  }> {
    return withTenant(principal.tenantId, async (db) => {
      const where: Prisma.AssetWhereInput = {
        tenantId: principal.tenantId,
        status: query.status,
        ...(query.category ? { category: query.category } : {}),
        ...(query.q
          ? {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' } },
                { tags: { has: query.q } },
              ],
            }
          : {}),
      };

      const [total, rows] = await Promise.all([
        db.asset.count({ where }),
        db.asset.findMany({
          where,
          include: {
            creator: { select: { id: true, fullName: true } },
            currentVersion: { include: { aiSuggestion: true } },
          },
          // Oldest submission first: the queue is a backlog, not a feed.
          orderBy: { updatedAt: 'asc' },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ]);

      // Submission time comes from the audit log, which is the only record of it.
      const submitted = await db.auditLog.findMany({
        where: {
          tenantId: principal.tenantId,
          action: 'asset.submitted',
          entityId: { in: rows.map((row) => row.id) },
        },
        select: { entityId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });
      const submittedAt = new Map<string, Date>();
      for (const entry of submitted) {
        if (entry.entityId && !submittedAt.has(entry.entityId)) {
          submittedAt.set(entry.entityId, entry.createdAt);
        }
      }

      const now = Date.now();
      const items: ReviewQueueItem[] = rows.map((asset) => {
        const version = asset.currentVersion;
        const suggestion = version?.aiSuggestion ?? null;
        const since = submittedAt.get(asset.id);

        return {
          id: asset.id,
          name: asset.name,
          description: asset.description,
          category: asset.category,
          tags: asset.tags,
          status: asset.status,
          createdAt: asset.createdAt.toISOString(),
          updatedAt: asset.updatedAt.toISOString(),
          creator: asset.creator,
          version: version
            ? {
                id: version.id,
                versionNumber: version.versionNumber,
                format: version.format,
                sizeBytes: Number(version.sizeBytes),
                polycount: version.polycount,
                pinStatus: version.pinStatus,
                ipfsCid: version.ipfsCid,
                gatewayUrl: version.ipfsCid ? `/ipfs/${version.ipfsCid}` : null,
              }
            : null,
          ai: suggestion
            ? {
                confidence: suggestion.confidence,
                tags: suggestion.suggestedTags,
                description: suggestion.suggestedDescription,
                qualityFlags: suggestion.qualityFlags,
                needsManualReview: suggestion.needsManualReview,
                modelVersion: suggestion.modelVersion,
              }
            : null,
          waitingHours: since ? Math.round(((now - since.getTime()) / 3_600_000) * 10) / 10 : null,
        };
      });

      return {
        items,
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      };
    });
  }

  // -------------------------------------------------------------------- stats

  /** §6.1 — Assessor KPIs, plus the age of the oldest waiting item. */
  async function stats(
    principal: AuthPrincipal,
  ): Promise<ReviewQueueStats & { oldestWaitingHours: number | null }> {
    return withTenant(principal.tenantId, async (db) => {
      const [awaiting, decisions, oldestSubmit] = await Promise.all([
        db.asset.count({
          where: { tenantId: principal.tenantId, status: { in: [...REVIEWABLE_STATUSES] } },
        }),
        db.reviewDecision.findMany({
          where: { tenantId: principal.tenantId },
          select: { decision: true, assetId: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 500,
        }),
        db.auditLog.findFirst({
          where: {
            tenantId: principal.tenantId,
            action: 'asset.submitted',
            entityId: {
              in: await withTenant(principal.tenantId, (inner) =>
                inner.asset
                  .findMany({
                    where: { status: { in: [...REVIEWABLE_STATUSES] } },
                    select: { id: true },
                    take: 500,
                  })
                  .then((rows) => rows.map((row) => row.id)),
              ),
            },
          },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
      ]);

      const tally = { approved: 0, rejected: 0, revision: 0 };
      for (const decision of decisions) {
        if (decision.decision === 'approved') tally.approved += 1;
        else if (decision.decision === 'rejected') tally.rejected += 1;
        else tally.revision += 1;
      }

      // Mean hours from submission to decision, over the decisions we can attribute.
      const submittedRows = await db.auditLog.findMany({
        where: {
          tenantId: principal.tenantId,
          action: 'asset.submitted',
          entityId: { in: [...new Set(decisions.map((d) => d.assetId))] },
        },
        select: { entityId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });
      const submitByAsset = new Map<string, Date>();
      for (const row of submittedRows) {
        if (row.entityId && !submitByAsset.has(row.entityId)) submitByAsset.set(row.entityId, row.createdAt);
      }

      const durations: number[] = [];
      for (const decision of decisions) {
        const since = submitByAsset.get(decision.assetId);
        if (since && decision.createdAt > since) {
          durations.push((decision.createdAt.getTime() - since.getTime()) / 3_600_000);
        }
      }
      const average = durations.length
        ? Math.round((durations.reduce((sum, value) => sum + value, 0) / durations.length) * 10) / 10
        : null;

      return {
        awaitingReview: awaiting,
        approvedTotal: tally.approved,
        rejectedTotal: tally.rejected,
        revisionTotal: tally.revision,
        averageReviewHours: average,
        oldestWaitingHours: oldestSubmit
          ? Math.round(((Date.now() - oldestSubmit.createdAt.getTime()) / 3_600_000) * 10) / 10
          : null,
      };
    });
  }

  // ------------------------------------------------------------------- decide

  /**
   * FR-4.2 / FR-7.5 — record a decision and move the asset through the §5.1 lifecycle.
   * The decision row is written *before* the status changes, inside one transaction, so a
   * crash can never leave an approved asset with no accountability record.
   */
  async function decide(
    principal: AuthPrincipal,
    assetId: string,
    input: ReviewDecisionInput,
  ): Promise<AssetDetail> {
    const actorLabel = `${principal.fullName} <${principal.email}>`;
    const nextStatus = DECISION_STATUS[input.decision];

    await withTenant(principal.tenantId, async (db) => {
      const asset = await db.asset.findFirst({
        where: { id: assetId, tenantId: principal.tenantId },
        include: {
          creator: { select: { id: true, fullName: true } },
          currentVersion: { include: { aiSuggestion: true } },
        },
      });
      if (!asset) throw new NotFoundError('Asset');

      if (!REVIEWABLE_STATUSES.includes(asset.status)) {
        throw new ConflictError(
          `An asset in "${asset.status}" is not awaiting review`,
          'NOT_IN_REVIEW',
          { status: asset.status, reviewable: [...REVIEWABLE_STATUSES] },
        );
      }
      if (!canTransition(asset.status, nextStatus)) {
        throw new ConflictError(
          `The lifecycle does not allow "${asset.status}" -> "${nextStatus}"`,
          'INVALID_TRANSITION',
          { from: asset.status, to: nextStatus },
        );
      }
      if (commentRequiredFor(input.decision) && !input.comment?.trim()) {
        // The Zod schema already enforces this; kept as a guard for direct callers.
        throw new ConflictError(
          `A comment is required for a '${input.decision}' decision`,
          'COMMENT_REQUIRED',
        );
      }

      const versionId = input.assetVersionId ?? asset.currentVersionId;
      if (!versionId) throw new ConflictError('The asset has no version to decide on', 'NO_VERSION');

      const suggestion = asset.currentVersion?.aiSuggestion ?? null;

      // FR-7.5 — record exactly what the Assessor adopted from the AI suggestion.
      if (suggestion && (input.acceptAiTags || input.acceptAiDescription)) {
        const acceptedTags = input.acceptAiTags
          ? [...asset.tags, ...suggestion.suggestedTags].filter(
              (tag, index, all) => all.indexOf(tag) === index,
            )
          : asset.tags;

        await db.aISuggestion.update({
          where: { assetVersionId: suggestion.assetVersionId },
          data: {
            acceptedTags: input.acceptAiTags ? suggestion.suggestedTags : suggestion.acceptedTags,
            acceptedDescription: input.acceptAiDescription
              ? suggestion.suggestedDescription
              : suggestion.acceptedDescription,
            acceptedAt: new Date(),
            acceptedById: principal.userId,
          },
        });

        if (input.acceptAiTags) {
          await db.asset.update({ where: { id: assetId }, data: { tags: acceptedTags } });
        }

        // FR-7.5 — accepting the description must actually reach the asset, otherwise the catalog
        // and marketplace have nothing to render and the acceptance is only a note on the suggestion.
        if (input.acceptAiDescription && suggestion.suggestedDescription) {
          await db.asset.update({
            where: { id: assetId },
            data: { description: suggestion.suggestedDescription.slice(0, 4000) },
          });
        }
      }

      await db.reviewDecision.create({
        data: {
          tenantId: principal.tenantId,
          assetId,
          assetVersionId: versionId,
          assessorId: principal.userId,
          decision: input.decision,
          comment: input.comment?.trim() || null,
        },
      });

      await db.asset.update({ where: { id: assetId }, data: { status: nextStatus } });

      await recordAudit(
        {
          action: 'asset.status_changed',
          entityType: 'asset',
          entityId: assetId,
          actorId: principal.userId,
          actorLabel,
          beforeState: { status: asset.status },
          afterState: {
            status: nextStatus,
            decision: input.decision,
            assetVersionId: versionId,
            comment: input.comment ?? null,
            adoptedAiTags: input.acceptAiTags ? (suggestion?.suggestedTags ?? []) : [],
            adoptedAiDescription: input.acceptAiDescription,
          },
        },
        db,
      );

      // FR-12.2 — tell the Creator what happened to their submission.
      if (asset.creator) {
        await notify(db, {
          tenantId: principal.tenantId,
          event: DECISION_EVENT[input.decision],
          assetId,
          recipients: [asset.creator.id],
          title: `"${asset.name}" was ${input.decision === 'revision' ? 'sent back for changes' : input.decision}`,
          body: input.comment ?? `Reviewed by ${principal.fullName}.`,
        });
      }
    });

    return assets.detail(principal, assetId);
  }

  // ------------------------------------------------------------------ comment

  /** FR-4.6 — a threaded comment on the asset's review history. */
  async function comment(
    principal: AuthPrincipal,
    assetId: string,
    input: { body: string; parentId?: string | null | undefined },
  ): Promise<AssetDetail> {
    const actorLabel = `${principal.fullName} <${principal.email}>`;

    await withTenant(principal.tenantId, async (db) => {
      const asset = await db.asset.findFirst({
        where: { id: assetId, tenantId: principal.tenantId },
        select: { id: true, name: true, creatorId: true },
      });
      if (!asset) throw new NotFoundError('Asset');

      if (input.parentId) {
        const parent = await db.reviewComment.findFirst({
          where: { id: input.parentId, assetId, tenantId: principal.tenantId },
          select: { id: true },
        });
        if (!parent) throw new NotFoundError('Comment');
      }

      await db.reviewComment.create({
        data: {
          tenantId: principal.tenantId,
          assetId,
          authorId: principal.userId,
          parentId: input.parentId ?? null,
          body: input.body.trim(),
        },
      });

      await recordAudit(
        {
          action: 'asset.comment_created',
          entityType: 'asset',
          entityId: assetId,
          actorId: principal.userId,
          actorLabel,
          afterState: { body: input.body.trim().slice(0, 500), parentId: input.parentId ?? null },
        },
        db,
      );

      // A comment on someone else's asset is a request for attention (FR-12.2).
      if (asset.creatorId !== principal.userId) {
        await notify(db, {
          tenantId: principal.tenantId,
          event: 'asset.comment_created',
          assetId,
          recipients: [asset.creatorId],
          title: `New comment on "${asset.name}"`,
          body: input.body.trim().slice(0, 300),
        });
      }
    });

    return assets.detail(principal, assetId);
  }

  return { queue, stats, decide, comment };
}
