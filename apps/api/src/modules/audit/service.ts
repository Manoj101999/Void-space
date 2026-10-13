/**
 * Audit log read model (SRS FR-13.1, FR-13.2).
 *
 * The log is append-only at the *database permission* level (packages/db
 * prisma/sql/rls.sql revokes UPDATE/DELETE from the runtime role), so this module
 * deliberately exposes no write path: rows are created by the domain services via
 * `recordAudit` inside the same transaction as the change they describe.
 */
import { withTenant } from '@void-space/db';
import type { AuditLogEntry, AuditQuery, AuthPrincipal, Paginated } from '@void-space/types';
import type { Prisma } from '@void-space/db';

export interface AuditService {
  query(
    principal: AuthPrincipal,
    query: AuditQuery,
  ): Promise<Paginated<AuditLogEntry> & { actions: string[]; actors: { id: string; label: string }[] }>;
}

export function createAuditService(): AuditService {
  async function query(
    principal: AuthPrincipal,
    input: AuditQuery,
  ): Promise<
    Paginated<AuditLogEntry> & { actions: string[]; actors: { id: string; label: string }[] }
  > {
    const where: Prisma.AuditLogWhereInput = {
      tenantId: principal.tenantId,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      ...(input.action ? { action: input.action } : {}),
      ...(input.entityType ? { entityType: input.entityType } : {}),
      ...(input.entityId ? { entityId: input.entityId } : {}),
      ...(input.from || input.to
        ? {
            createdAt: {
              ...(input.from ? { gte: new Date(input.from) } : {}),
              ...(input.to ? { lte: new Date(input.to) } : {}),
            },
          }
        : {}),
    };

    return withTenant(principal.tenantId, async (db) => {
      const [total, rows, actionGroups, actorGroups] = await Promise.all([
        db.auditLog.count({ where }),
        db.auditLog.findMany({
          where,
          orderBy: { [input.sort === 'updatedAt' ? 'createdAt' : input.sort]: input.order },
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        // Filter facets for the UI (FR-13.2); bounded to what this tenant can see.
        db.auditLog.groupBy({ by: ['action'], where: { tenantId: principal.tenantId } }),
        db.auditLog.groupBy({
          by: ['actorId', 'actorLabel'],
          where: { tenantId: principal.tenantId, actorId: { not: null } },
        }),
      ]);

      return {
        items: rows.map(
          (row): AuditLogEntry => ({
            id: row.id,
            tenantId: row.tenantId,
            actorId: row.actorId,
            actorLabel: row.actorLabel,
            action: row.action,
            entityType: row.entityType,
            entityId: row.entityId,
            beforeState: row.beforeState,
            afterState: row.afterState,
            txHash: row.txHash,
            blockNumber: row.blockNumber?.toString() ?? null,
            gasUsed: row.gasUsed?.toString() ?? null,
            createdAt: row.createdAt.toISOString(),
          }),
        ),
        page: input.page,
        pageSize: input.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / input.pageSize)),
        actions: actionGroups.map((group) => group.action).sort(),
        actors: actorGroups
          .filter((group): group is { actorId: string; actorLabel: string | null } =>
            Boolean(group.actorId),
          )
          .map((group) => ({ id: group.actorId, label: group.actorLabel ?? group.actorId }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      };
    });
  }

  return { query };
}
