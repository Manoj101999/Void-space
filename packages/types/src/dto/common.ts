import { z } from 'zod';

/**
 * Boolean that survives both JSON and form encodings.
 *
 * `z.coerce.boolean()` uses `Boolean(value)`, so the *string* `"false"` — which is what a
 * `multipart/form-data` field or a query string always carries — coerces to `true`. That
 * silently inverted `submitForReview: false` into a submission during development. This
 * schema parses the common textual spellings explicitly.
 */
export const booleanishSchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((value) => value === true || value === 'true' || value === '1' || value === 'yes');

/** Pagination + list conventions shared by every collection endpoint. */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
  sort: z.enum(['createdAt', 'updatedAt', 'name']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Paginated<T> {
  readonly items: T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

/** UUID path params are validated before they ever reach SQL. */
export const uuidParamSchema = z.string().uuid();
export const idParamsSchema = z.object({ id: uuidParamSchema });
export type IdParams = z.infer<typeof idParamsSchema>;

/** Standard error envelope returned by the API error handler (see apps/api/src/app.ts). */
export const apiErrorSchema = z.object({
  statusCode: z.number().int(),
  error: z.string(),
  /** Stable, machine-readable discriminator (e.g. INSUFFICIENT_PERMISSION). */
  code: z.string(),
  /** Safe to show to an end user; never an internal stack or SQL fragment. */
  message: z.string(),
  details: z.unknown().optional(),
  /** Correlation id (pino request id) — surfaced for support (§3.2 observability). */
  requestId: z.string(),
  timestamp: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  uptimeSeconds: z.number(),
  dependencies: z.record(
    z.object({ status: z.enum(['up', 'down', 'disabled']), detail: z.string().optional() }),
  ),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const jobStatusResponseSchema = z.object({
  id: z.string(),
  queue: z.string(),
  status: z.enum(['queued', 'active', 'completed', 'failed', 'delayed']),
  attempts: z.number().int(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type JobStatusResponse = z.infer<typeof jobStatusResponseSchema>;
