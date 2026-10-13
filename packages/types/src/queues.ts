/**
 * Asynchronous job contracts (SRS §3.10).
 *
 * Every non-trivial or externally-dependent operation is a BullMQ job so the
 * API stays fast and degrades gracefully (NFR-REL.1). Retry policies here are
 * transcribed from the §3.10 table and consumed by both api (producer) and
 * worker (consumer) so they can never drift.
 */

export const QUEUE_NAMES = [
  'ai-enrichment',
  'ipfs-pin',
  'blender-optimize',
  'chain-license',
  'xr-publish',
  'notify',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export interface QueuePolicy {
  readonly name: QueueName;
  /** Total attempts = 1 initial run + automatic retries (§3.10). */
  readonly attempts: number;
  readonly backoff: { readonly type: 'exponential' | 'fixed'; readonly delayMs: number };
  /** Plain-language description of the documented retry policy. */
  readonly policy: string;
  /** Concurrency default; overridable per worker via env (NFR-SCAL.2). */
  readonly defaultConcurrency: number;
}

export const QUEUE_POLICIES: Readonly<Record<QueueName, QueuePolicy>> = {
  'ai-enrichment': {
    name: 'ai-enrichment',
    attempts: 2,
    backoff: { type: 'fixed', delayMs: 2_000 },
    policy: '1 automatic retry with a stricter prompt, then flagged needs_manual_review',
    defaultConcurrency: 2,
  },
  'ipfs-pin': {
    name: 'ipfs-pin',
    attempts: 3,
    backoff: { type: 'exponential', delayMs: 2_000 },
    policy: '3 retries, exponential backoff',
    defaultConcurrency: 4,
  },
  'blender-optimize': {
    name: 'blender-optimize',
    attempts: 2,
    backoff: { type: 'exponential', delayMs: 5_000 },
    policy: '1 retry; failure surfaces in the job-status UI',
    defaultConcurrency: 1,
  },
  'chain-license': {
    name: 'chain-license',
    attempts: 3,
    backoff: { type: 'exponential', delayMs: 3_000 },
    policy:
      "3 retries, exponential backoff; failure keeps status at 'approved' (never silently 'published')",
    defaultConcurrency: 2,
  },
  'xr-publish': {
    name: 'xr-publish',
    attempts: 3,
    backoff: { type: 'exponential', delayMs: 3_000 },
    policy: '3 retries, exponential backoff',
    defaultConcurrency: 2,
  },
  notify: {
    name: 'notify',
    attempts: 2,
    backoff: { type: 'fixed', delayMs: 1_000 },
    policy: 'Best-effort, 1 retry',
    defaultConcurrency: 4,
  },
};

/** Poll-facing job states (GET /api/v1/jobs/{id}, FR-6.5). */
export const JOB_STATUSES = ['queued', 'active', 'completed', 'failed', 'delayed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Map the BullMQ native state onto the API's documented vocabulary. BullMQ's
 * `waiting`/`waiting-children`/`prioritized` all surface to clients as `queued`.
 */
export const BULLMQ_STATE_TO_JOB_STATUS: Readonly<Record<string, JobStatus>> = {
  waiting: 'queued',
  'waiting-children': 'queued',
  prioritized: 'queued',
  delayed: 'delayed',
  active: 'active',
  completed: 'completed',
  failed: 'failed',
};

export interface AiEnrichmentJobData {
  readonly tenantId: string;
  readonly assetId: string;
  readonly assetVersionId: string;
  readonly fileName: string;
  readonly category: string;
  readonly creatorTags: readonly string[];
  /** Set by the worker on the single permitted retry (FR-7.3). */
  readonly stricter?: boolean;
}

export interface IpfsPinJobData {
  readonly tenantId: string;
  readonly assetVersionId: string;
  /** Absolute path inside the worker container to the staged upload. */
  readonly stagedPath: string;
  readonly fileName: string;
  /** true when pinning a Blender-optimized derivative rather than the original. */
  readonly derivative?: boolean;
}

export interface BlenderOptimizeJobData {
  readonly tenantId: string;
  readonly assetId: string;
  readonly assetVersionId: string;
  readonly stagedPath: string;
  readonly polycountBudget?: number;
}

export interface ChainLicenseJobData {
  readonly tenantId: string;
  readonly assetId: string;
  readonly assetVersionId: string;
  readonly ipfsCid: string;
  readonly licenseTermsHash: string;
  readonly approverUserId: string;
  readonly approverRef: string;
}

export interface XrPublishJobData {
  readonly tenantId: string;
  readonly assetId: string;
  readonly assetVersionId: string;
  readonly licenseTokenId: string;
  readonly ipfsCid: string;
}

export type NotificationEventType =
  | 'asset.submitted'
  | 'asset.needs_manual_review'
  | 'asset.approved'
  | 'asset.rejected'
  | 'asset.revision'
  | 'asset.published'
  | 'asset.revoked'
  | 'job.failed';

export interface NotifyJobData {
  readonly tenantId: string;
  readonly eventType: NotificationEventType;
  readonly entityType: 'asset' | 'job';
  readonly entityId: string;
  /** Recipients resolved by the producer (Creator and/or Assessors). */
  readonly recipientUserIds: readonly string[];
  readonly payload: Record<string, unknown>;
}

/**
 * The `jobs.queue` column is a Prisma enum, so it stores the underscore spelling
 * (`chain_license`) while every other surface — the queue names above, the SRS §3.10 table,
 * the BullMQ queue itself — uses the hyphenated one. Without a conversion the API leaks a
 * database enum spelling into the UI, and the same job appears as `chain_license` in one
 * payload and `chain-license` in another.
 *
 * This is the one place the two spellings meet. Both the asset detail payload and
 * `GET /jobs/:id` (FR-6.5) read through it, so the wire format is the §3.10 vocabulary
 * everywhere and a client never has to know how the column is typed.
 */
export const JOB_QUEUE_DB_TO_NAME: Readonly<Record<string, QueueName>> = {
  ai_enrichment: 'ai-enrichment',
  ipfs_pin: 'ipfs-pin',
  blender_optimize: 'blender-optimize',
  chain_license: 'chain-license',
  xr_publish: 'xr-publish',
  notify: 'notify',
};

/**
 * Normalises a `jobs.queue` value to its §3.10 name.
 *
 * Falls back to the input rather than throwing: a queue added to the Prisma enum before this
 * map is a display bug, and a 500 on a read endpoint would be a worse one.
 */
export function queueNameFromDb(value: string): string {
  return JOB_QUEUE_DB_TO_NAME[value] ?? value;
}
