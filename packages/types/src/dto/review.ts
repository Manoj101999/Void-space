import { z } from 'zod';
import { REVIEW_DECISIONS, commentRequiredFor } from '../assets';
import { booleanishSchema, paginationQuerySchema } from './common';

/**
 * FR-4.2: transition an asset to approved / rejected / revision with a required
 * comment for rejected/revision and an optional comment for approved.
 */
export const reviewDecisionSchema = z
  .object({
    decision: z.enum(REVIEW_DECISIONS),
    comment: z.string().max(2000).optional(),
    /** Version the decision applies to; defaults to the asset's current version. */
    assetVersionId: z.string().uuid().optional(),
    /** FR-7.5: one-click accept of the AI-suggested tags/description. */
    acceptAiTags: booleanishSchema.default(false),
    acceptAiDescription: booleanishSchema.default(false),
  })
  .superRefine((value, ctx) => {
    if (commentRequiredFor(value.decision) && !value.comment?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['comment'],
        message: `A comment is required when the decision is '${value.decision}'`,
      });
    }
  });
export type ReviewDecisionInput = z.infer<typeof reviewDecisionSchema>;

/** FR-4.6: threaded comment on an asset's review history. */
export const createCommentSchema = z.object({
  body: z.string().min(1).max(2000),
  parentId: z.string().uuid().nullable().optional(),
});
export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export const reviewQueueQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['pending', 'needs_manual_review']).default('pending'),
  category: z.string().max(60).optional(),
  q: z.string().max(120).optional(),
});
export type ReviewQueueQuery = z.infer<typeof reviewQueueQuerySchema>;

/** §6.1: Assessor dashboard KPIs. */
export interface ReviewQueueStats {
  readonly awaitingReview: number;
  readonly approvedTotal: number;
  readonly rejectedTotal: number;
  readonly revisionTotal: number;
  /** Mean hours between submission and decision. */
  readonly averageReviewHours: number | null;
}

/** §6.1: Creator dashboard KPIs. */
export interface CreatorStats {
  readonly myAssets: number;
  readonly approved: number;
  readonly pending: number;
  readonly needsManualReview: number;
  readonly published: number;
}

/** §6.1: TenantAdmin dashboard KPIs. */
export interface TenantAdminStats {
  readonly tenantUsers: number;
  readonly activeApiKeys: number;
  readonly licensesMinted: number;
  readonly assetsTotal: number;
  readonly storageBytes: number;
}
