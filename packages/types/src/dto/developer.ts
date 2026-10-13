import { z } from 'zod';
import { paginationQuerySchema } from './common';

/** FR-12.3: API key creation, one-time copy, and rotation. */
export const createApiKeySchema = z.object({
  label: z.string().min(2).max(80),
  /** Optional expiry; omitted means the key lives until revoked. */
  expiresInDays: z.coerce.number().int().min(1).max(3650).optional(),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

/** The raw key is returned exactly once, at creation (NFR-SEC.7). */
export interface CreatedApiKey {
  readonly id: string;
  readonly label: string;
  readonly key: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface ApiKeySummary {
  readonly id: string;
  readonly label: string;
  readonly prefix: string;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdBy: { id: string; fullName: string } | null;
}

export const apiKeyListQuerySchema = paginationQuerySchema;
export type ApiKeyListQuery = z.infer<typeof apiKeyListQuerySchema>;
