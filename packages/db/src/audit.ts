/**
 * Append-only audit trail helper (SRS §4.13, FR-13.1–13.3, §5.1 AuditLog).
 *
 * Every state-changing action — authentication, role changes, asset status
 * transitions, chain transactions, publish/revocation — goes through here, so
 * the compliance trail can always reconstruct who did what, when, and with what
 * before/after state (NFR-COMP.3).
 *
 * The table is append-only at the database-permission level: the runtime role
 * has no UPDATE/DELETE grant on `audit_logs` (see prisma/sql/rls.sql).
 */
import type { Prisma } from '../generated/client';
import { currentTenantId, tenantDb, type TenantClient } from './tenant';

export interface AuditEventInput {
  /** One of AUDIT_ACTIONS in @void-space/types (kept as string for forward compatibility). */
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly actorId?: string | null;
  /** Human-readable actor reference; survives user deletion, and carries the
   *  Assessor reference for chain events (§3.9.2). */
  readonly actorLabel?: string | null;
  readonly beforeState?: unknown;
  readonly afterState?: unknown;
  /** FR-9.6 — chain interactions persist tx hash, block number and gas used. */
  readonly txHash?: string | null;
  readonly blockNumber?: bigint | null;
  readonly gasUsed?: bigint | null;
  readonly ipfsCid?: string | null;
  readonly requestId?: string | null;
}

export interface AuditLogRow {
  readonly id: string;
  readonly createdAt: Date;
}

function asJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return value as Prisma.InputJsonValue;
}

/**
 * Writes one audit entry inside the current tenant context.
 *
 * Pass an explicit `db` when you are already inside a transaction and the audit
 * row must commit or roll back atomically with the state change it describes.
 */
export async function recordAudit(
  input: AuditEventInput,
  db: TenantClient = tenantDb(),
): Promise<AuditLogRow> {
  return db.auditLog.create({
    data: {
      tenantId: currentTenantId(),
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      beforeState: asJson(input.beforeState),
      afterState: asJson(input.afterState),
      txHash: input.txHash ?? null,
      blockNumber: input.blockNumber ?? null,
      gasUsed: input.gasUsed ?? null,
      ipfsCid: input.ipfsCid ?? null,
      requestId: input.requestId ?? null,
    },
    select: { id: true, createdAt: true },
  });
}

/** Convenience wrapper for status transitions (FR-13.1 before/after state). */
export async function recordStatusChange(
  params: {
    readonly action: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly from: string;
    readonly to: string;
    readonly actorId?: string | null;
    readonly actorLabel?: string | null;
    readonly requestId?: string | null;
  },
  db: TenantClient = tenantDb(),
): Promise<AuditLogRow> {
  return recordAudit(
    {
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      actorId: params.actorId,
      actorLabel: params.actorLabel,
      beforeState: { status: params.from },
      afterState: { status: params.to },
      requestId: params.requestId,
    },
    db,
  );
}
