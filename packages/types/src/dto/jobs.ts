import { z } from 'zod';

/**
 * Asynchronous job status (SRS FR-6.5, §3.10).
 *
 *   GET /api/v1/jobs/:id   the state of one long-running operation
 *
 * Every queue in §3.10 is mirrored into a Postgres `jobs` row whose id *is* the BullMQ jobId,
 * so a caller that was handed an id by an enqueue response can poll this endpoint without
 * needing Redis access. The publish endpoint returns `chainLicenseJobId` for exactly this
 * reason: minting is asynchronous, and the UI shows the job rather than a premature claim of
 * having published.
 *
 * `payload` is deliberately **not** part of this view. It carries the internal job envelope
 * (tenant id, entity ids, file paths) which is nobody's business over the wire, and a polling
 * client needs the *state*, not the input.
 */
export const jobStatusSchema = z.enum(['queued', 'active', 'completed', 'failed', 'delayed']);
export type JobStatusName = z.infer<typeof jobStatusSchema>;

export const jobIdParamsSchema = z.object({ id: z.string().uuid() });
export type JobIdParams = z.infer<typeof jobIdParamsSchema>;

export interface JobStatusView {
  readonly id: string;
  /** Queue name in §3.10 vocabulary, e.g. `chain-license`. */
  readonly queue: string;
  readonly status: JobStatusName;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly error: string | null;
  readonly result: Record<string, unknown> | null;
  /** True while the job has not reached a terminal state, so a client knows to keep polling. */
  readonly inProgress: boolean;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
