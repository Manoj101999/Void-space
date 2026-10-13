import { z } from 'zod';
import { paginationQuerySchema } from './common';

/**
 * FR-13.1: every authentication event, role change, asset status transition,
 * chain transaction and publish/revocation is recorded with actor, timestamp and
 * before/after state.
 */
export const AUDIT_ACTIONS = [
  'auth.register',
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.token_refresh',
  'auth.apikey_issued',
  'auth.password_changed',
  'auth.wallet_linked',
  /** Implementation gap-fill: linking must be reversible from account settings (FR-2.6). */
  'auth.wallet_unlinked',
  'tenant.created',
  'tenant.suspended',
  'tenant.reinstated',
  'tenant.settings_updated',
  'tenant.user_invited',
  'tenant.user_role_changed',
  'tenant.user_removed',
  /** Added during implementation: FR-1.3 removal is reversible, so reactivation needs its own action. */
  'tenant.user_reinstated',
  'tenant.switched',
  'asset.created',
  'asset.version_created',
  'asset.submitted',
  'asset.deleted',
  'asset.status_changed',
  'asset.publish_requested',
  'asset.published',
  'asset.revoked',
  'asset.comment_created',
  'ai.enrichment_completed',
  'ai.enrichment_failed',
  'ai.suggestion_accepted',
  'ipfs.pinned',
  'ipfs.unpinned',
  'chain.license_minted',
  'chain.license_revoked',
  'chain.transaction_failed',
  'xr.published',
  'apikey.created',
  'apikey.rotated',
  'apikey.revoked',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const auditQuerySchema = paginationQuerySchema.extend({
  /** FR-13.2: filter by actor, entity and date range. */
  actorId: z.string().uuid().optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  entityType: z.string().max(60).optional(),
  entityId: z.string().max(60).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export interface AuditLogEntry {
  readonly id: string;
  readonly tenantId: string | null;
  readonly actorId: string | null;
  readonly actorLabel: string | null;
  readonly action: AuditAction | string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly beforeState: unknown;
  readonly afterState: unknown;
  /** FR-9.6: chain interactions persist tx hash / block / gas for verifiability. */
  readonly txHash: string | null;
  readonly blockNumber: string | null;
  readonly gasUsed: string | null;
  readonly createdAt: string;
}
