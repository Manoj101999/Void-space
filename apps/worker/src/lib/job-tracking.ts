/**
 * Job bookkeeping (SRS FR-11.2, FR-11.3, §3.10).
 *
 * The API mirrors every job into the `jobs` table; the worker owns its lifecycle from
 * there. Wrapping a processor in `trackJob` gives one place where `status`, `attempts`,
 * `startedAt`, `finishedAt`, `error` and `result` are kept truthful — and where a
 * terminal failure is distinguished from a retry (which is what the UI needs to say
 * "failed, will retry" versus "failed, needs attention").
 */
import { withTenant, type Prisma } from '@void-space/db';
import type { QueueName } from '@void-space/types';

export interface JobPayload {
  readonly assetId?: string;
  readonly versionId?: string;
  readonly [key: string]: unknown;
}

export interface JobContext {
  readonly jobId: string;
  readonly tenantId: string;
  /** The queue this job came from, kept for structured logging. */
  readonly queue: QueueName;
  readonly payload: JobPayload;
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Marks this attempt as active and bumps the attempt counter. */
  markActive(): Promise<void>;
  /** Records a successful outcome. */
  succeed(result: Record<string, unknown>): Promise<void>;
  /**
   * Records a failed attempt. `terminal` is true on the last attempt, which is when the
   * DB row stops saying "retrying" and the domain state is marked failed.
   */
  fail(error: unknown, terminal: boolean): Promise<void>;
}

/** The `jobs.queue` enum value for a queue name. */
export function jobQueueEnum(queue: QueueName): Prisma.JobCreateInput['queue'] {
  return queue.replace(/-/g, '_') as Prisma.JobCreateInput['queue'];
}

/**
 * Whether a Prisma error is "no record found" (P2025).
 *
 * Checked structurally rather than with `instanceof PrismaClientKnownRequestError`: this package
 * and the generated client are separate module instances under some bundlers, so an `instanceof`
 * across that boundary silently returns false and the error would escape anyway.
 *
 * Processors use this to tell "the row I was working on is gone" — an asset deleted while its
 * ingest was queued, which makes the job obsolete — from a genuine write failure.
 */
export function isRecordNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2025'
  );
}

export interface TrackJobParams {
  readonly jobId: string;
  readonly tenantId: string;
  readonly queue: QueueName;
  readonly payload: JobPayload;
  readonly attempt: number;
  readonly maxAttempts: number;
}

/**
 * Builds a tracking context for one job attempt. Every write is tenant-scoped, so a job
 * cannot touch another tenant's rows even if its payload were tampered with.
 */
export function createJobContext(params: TrackJobParams): JobContext {
  const { jobId, tenantId } = params;

  /**
   * Bookkeeping must never break the work it describes.
   *
   * The `jobs` row is a mirror for the operator's benefit; the transaction, the pin and the
   * licence are the actual work. A job row can legitimately be gone — an asset purged while its
   * ingest was still queued takes its jobs with it — and a status write failing there says
   * nothing about whether the work succeeded. So a missing row is reported and dropped rather
   * than thrown, which would otherwise convert a completed pin into a failed job.
   */
  async function update(data: Prisma.JobUpdateInput): Promise<void> {
    try {
      await withTenant(tenantId, (db) => db.job.update({ where: { id: jobId }, data }));
    } catch (error) {
      if (isRecordNotFound(error)) {
        console.warn(
          `[jobs] no row for ${jobId} (${params.queue}) — the job's subject was removed; bookkeeping skipped`,
        );
        return;
      }
      throw error;
    }
  }

  return {
    ...params,
    async markActive() {
      await update({
        status: 'active',
        attempts: params.attempt,
        startedAt: new Date(),
        error: null,
      });
    },
    async succeed(result) {
      await update({
        status: 'completed',
        result: result as Prisma.InputJsonValue,
        finishedAt: new Date(),
        error: null,
        attempts: params.attempt,
      });
    },
    async fail(error, terminal) {
      await update({
        status: terminal ? 'failed' : 'delayed',
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
        attempts: params.attempt,
        finishedAt: terminal ? new Date() : null,
      });
    },
  };
}

/** Attempt number for a BullMQ job (1-based, matching the §3.10 "1 initial run" wording). */
export function attemptOf(job: { attemptsMade: number }): number {
  return job.attemptsMade + 1;
}

/**
 * Whether a failed attempt is the last one for this job.
 *
 * Two independent reasons, and both have to be considered. The obvious one is that the retry
 * policy is exhausted. The other is that the error cannot be recovered from at all: BullMQ stops
 * retrying an `UnrecoverableError` whatever the policy says, so judging terminality by attempt
 * count alone would leave the row reading "failed, will retry" for a job BullMQ has already
 * discarded — a spinner in the dashboard that never resolves.
 *
 * Checked by name as well as `instanceof`, because this module and the processors can end up with
 * different copies of the bullmq package under some bundlers, and a cross-instance `instanceof`
 * quietly returns false.
 */
export function isTerminalFailure(
  error: unknown,
  ctx: Pick<JobContext, 'attempt' | 'maxAttempts'>,
): boolean {
  if (isUnrecoverable(error)) return true;
  return ctx.attempt >= ctx.maxAttempts;
}

function isUnrecoverable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'UnrecoverableError'
  );
}
