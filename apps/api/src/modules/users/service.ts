/**
 * Tenant user & role administration (SRS FR-1.2, FR-1.3, §3.6, FR-2.7).
 *
 * Every mutation runs under `withTenant`, so RLS guarantees a TenantAdmin can only
 * ever touch their own workspace's users. Two further guards come from the §3.6
 * matrix rather than from RLS:
 *
 * - only a SuperAdmin may grant or revoke the platform-level SuperAdmin role;
 * - a workspace must always keep at least one administrator, so a mistaken role
 *   change cannot leave the tenant unadministrable.
 *
 * Role changes also revoke the affected user's refresh tokens (FR-2.7), so a
 * demotion takes effect on their next refresh instead of when their token expires.
 */
import { recordAudit, withTenant, type Prisma } from '@void-space/db';
import { ROLE_PERMISSIONS, type AuthPrincipal, type Role, type TenantUserSummary } from '@void-space/types';

import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors';
import { generateInviteToken, revokeSessionsForUser } from '../auth/sessions';

type TenantDb = Prisma.TransactionClient;

const INVITE_TTL_SECONDS = 7 * 24 * 3600;
/** Roles that may administer a workspace (§3.6 "Manage tenant users & roles"). */
const ADMIN_ROLES: readonly Role[] = ['TenantAdmin', 'SuperAdmin'];

const membershipSelect = {
  id: true,
  email: true,
  fullName: true,
  status: true,
  createdAt: true,
  lastLoginAt: true,
  roles: { select: { role: { select: { name: true } } } },
} satisfies Prisma.UserSelect;

type MembershipRow = Prisma.UserGetPayload<{ select: typeof membershipSelect }>;

function toSummary(row: MembershipRow): TenantUserSummary {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    roles: row.roles.map((membership) => membership.role.name).sort(),
    status: row.status as TenantUserSummary['status'],
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
  };
}

export interface UsersService {
  list(principal: AuthPrincipal): Promise<TenantUserSummary[]>;
  invite(
    principal: AuthPrincipal,
    input: { email: string; fullName: string; role: Role },
  ): Promise<{ id: string; email: string; role: Role; expiresAt: string; token: string }>;
  listInvites(principal: AuthPrincipal): Promise<
    { id: string; email: string; role: Role; expiresAt: string; acceptedAt: string | null }[]
  >;
  setRole(
    principal: AuthPrincipal,
    userId: string,
    role: Role,
  ): Promise<{ user: TenantUserSummary; sessionsRevoked: number }>;
  setStatus(
    principal: AuthPrincipal,
    userId: string,
    status: 'active' | 'suspended',
  ): Promise<{ user: TenantUserSummary; sessionsRevoked: number }>;
  remove(principal: AuthPrincipal, userId: string): Promise<{ sessionsRevoked: number }>;
  /** The role catalogue, for the invite dialog and role editor (§3.6). */
  roles(): Promise<{ name: Role; permissions: string[] }[]>;
}

export function createUsersService(): UsersService {
  /** Counts administrators so we never leave a workspace without one. */
  async function countAdministrators(db: TenantDb, tenantId: string, excludeUserId?: string) {
    return db.user.count({
      where: {
        tenantId,
        roles: { some: { role: { name: { in: [...ADMIN_ROLES] } } } },
        status: 'active',
        ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
      },
    });
  }

  async function loadUser(db: TenantDb, tenantId: string, userId: string): Promise<MembershipRow> {
    const row = await db.user.findFirst({
      where: { id: userId, tenantId },
      select: membershipSelect,
    });
    if (!row) throw new NotFoundError('User');
    return row;
  }

  /** §3.6 — granting or revoking the platform role is SuperAdmin-only. */
  function assertMayAssignRole(principal: AuthPrincipal, role: Role): void {
    if (role === 'SuperAdmin' && !principal.isSuperAdmin) {
      throw new ForbiddenError(
        'Only a SuperAdmin can grant the SuperAdmin role',
        'ROLE_ESCALATION_BLOCKED',
      );
    }
  }

  function assertMayModify(principal: AuthPrincipal, target: MembershipRow): void {
    const targetRoles = target.roles.map((membership) => membership.role.name as Role);
    if (targetRoles.includes('SuperAdmin') && !principal.isSuperAdmin) {
      throw new ForbiddenError(
        'Only a SuperAdmin can modify a SuperAdmin',
        'ROLE_ESCALATION_BLOCKED',
      );
    }
  }

  async function list(principal: AuthPrincipal): Promise<TenantUserSummary[]> {
    const rows = await withTenant(principal.tenantId, (db) =>
      db.user.findMany({
        where: { tenantId: principal.tenantId },
        select: membershipSelect,
        orderBy: [{ fullName: 'asc' }],
      }),
    );
    return rows.map(toSummary);
  }

  async function invite(
    principal: AuthPrincipal,
    input: { email: string; fullName: string; role: Role },
  ): Promise<{ id: string; email: string; role: Role; expiresAt: string; token: string }> {
    assertMayAssignRole(principal, input.role);

    const { token, tokenHash } = generateInviteToken(principal.tenantId);
    const expiresAt = new Date(Date.now() + INVITE_TTL_SECONDS * 1000);
    const actorLabel = `${principal.fullName} <${principal.email}>`;

    const created = await withTenant(principal.tenantId, async (db) => {
      // Already a member? Re-inviting would create a second identity for one email.
      const existing = await db.user.findFirst({
        where: { tenantId: principal.tenantId, email: input.email },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictError(
          'That email already belongs to a member of this workspace',
          'ALREADY_A_MEMBER',
        );
      }

      // Supersede any pending invitation for this address.
      const pending = await db.invite.findFirst({
        where: { tenantId: principal.tenantId, email: input.email, acceptedAt: null },
        select: { id: true },
      });
      if (pending) await db.invite.delete({ where: { id: pending.id } });

      const row = await db.invite.create({
        data: {
          tenantId: principal.tenantId,
          email: input.email,
          role: input.role,
          tokenHash,
          invitedById: principal.userId,
          expiresAt,
        },
        select: { id: true, email: true, role: true, expiresAt: true },
      });

      await recordAudit(
        {
          action: 'tenant.user_invited',
          entityType: 'invite',
          entityId: row.id,
          actorId: principal.userId,
          actorLabel,
          afterState: { email: row.email, role: row.role, expiresAt: expiresAt.toISOString() },
        },
        db,
      );

      return row;
    });

    return {
      id: created.id,
      email: created.email,
      role: created.role as Role,
      expiresAt: created.expiresAt.toISOString(),
      // Email delivery (§3.9, Resend) is not configured in this stack, so the raw
      // token is returned exactly once for the admin to hand over out-of-band.
      token,
    };
  }

  async function listInvites(principal: AuthPrincipal) {
    const rows = await withTenant(principal.tenantId, (db) =>
      db.invite.findMany({
        where: { tenantId: principal.tenantId },
        select: { id: true, email: true, role: true, expiresAt: true, acceptedAt: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );

    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role as Role,
      expiresAt: row.expiresAt.toISOString(),
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
    }));
  }

  /**
   * FR-1.3 — change a member's role. Replaces the membership rows so a user holds
   * exactly one role per tenant (§3.6 assigns "a role per user per tenant"), then
   * revokes their sessions (FR-2.7).
   */
  async function setRole(
    principal: AuthPrincipal,
    userId: string,
    role: Role,
  ): Promise<{ user: TenantUserSummary; sessionsRevoked: number }> {
    assertMayAssignRole(principal, role);
    const actorLabel = `${principal.fullName} <${principal.email}>`;

    return withTenant(principal.tenantId, async (db) => {
      const target = await loadUser(db, principal.tenantId, userId);
      assertMayModify(principal, target);

      const before = target.roles.map((membership) => membership.role.name as Role);
      if (before.length === 1 && before[0] === role) {
        throw new ConflictError('The user already holds that role', 'ROLE_UNCHANGED');
      }

      const wasAdmin = before.some((existing) => ADMIN_ROLES.includes(existing));
      if (wasAdmin && !ADMIN_ROLES.includes(role)) {
        const remaining = await countAdministrators(db, principal.tenantId, userId);
        if (remaining === 0) {
          throw new ConflictError('A workspace must keep at least one administrator', 'LAST_ADMIN');
        }
      }

      const roleRow = await db.role.findUnique({ where: { name: role }, select: { id: true } });
      if (!roleRow) throw new NotFoundError('Role');

      await db.userRole.deleteMany({ where: { tenantId: principal.tenantId, userId } });
      await db.userRole.create({
        data: { tenantId: principal.tenantId, userId, roleId: roleRow.id },
      });

      // FR-2.7 — a role change invalidates every refresh token for that user.
      const sessionsRevoked = await revokeSessionsForUser(db, {
        tenantId: principal.tenantId,
        userId,
        reason: 'role_changed',
      });

      const updated = await loadUser(db, principal.tenantId, userId);

      await recordAudit(
        {
          action: 'tenant.user_role_changed',
          entityType: 'user',
          entityId: userId,
          actorId: principal.userId,
          actorLabel,
          beforeState: { roles: before },
          afterState: { roles: [role], sessionsRevoked },
        },
        db,
      );

      return { user: toSummary(updated), sessionsRevoked };
    });
  }

  /** Deactivating a member takes effect immediately and kills their sessions. */
  async function setStatus(
    principal: AuthPrincipal,
    userId: string,
    status: 'active' | 'suspended',
  ): Promise<{ user: TenantUserSummary; sessionsRevoked: number }> {
    const actorLabel = `${principal.fullName} <${principal.email}>`;

    return withTenant(principal.tenantId, async (db) => {
      const target = await loadUser(db, principal.tenantId, userId);
      assertMayModify(principal, target);

      if (target.status === status) {
        throw new ConflictError(`The user is already ${status}`, 'STATUS_UNCHANGED');
      }

      const targetRoles = target.roles.map((membership) => membership.role.name as Role);
      if (status === 'suspended' && targetRoles.some((role) => ADMIN_ROLES.includes(role))) {
        const remaining = await countAdministrators(db, principal.tenantId, userId);
        if (remaining === 0) {
          throw new ConflictError(
            'A workspace must keep at least one active administrator',
            'LAST_ADMIN',
          );
        }
      }

      await db.user.update({ where: { id: userId }, data: { status } });

      const sessionsRevoked =
        status === 'suspended'
          ? await revokeSessionsForUser(db, {
              tenantId: principal.tenantId,
              userId,
              reason: 'user_suspended',
            })
          : 0;

      const updated = await loadUser(db, principal.tenantId, userId);

      await recordAudit(
        {
          action: status === 'suspended' ? 'tenant.user_removed' : 'tenant.user_reinstated',
          entityType: 'user',
          entityId: userId,
          actorId: principal.userId,
          actorLabel,
          beforeState: { status: target.status },
          afterState: { status, sessionsRevoked },
        },
        db,
      );

      return { user: toSummary(updated), sessionsRevoked };
    });
  }

  /**
   * FR-1.3 — remove a member from the tenant.
   *
   * Implemented as a *soft* removal (membership rows deleted, account suspended,
   * sessions revoked) rather than a row delete: the user is referenced by assets,
   * versions, review decisions and audit rows, and FR-13.1 requires that history to
   * survive. Re-inviting the same address restores them (see acceptInvite).
   */
  async function remove(
    principal: AuthPrincipal,
    userId: string,
  ): Promise<{ sessionsRevoked: number }> {
    if (userId === principal.userId) {
      throw new ConflictError('You cannot remove your own membership', 'CANNOT_REMOVE_SELF');
    }

    const actorLabel = `${principal.fullName} <${principal.email}>`;

    return withTenant(principal.tenantId, async (db) => {
      const target = await loadUser(db, principal.tenantId, userId);
      assertMayModify(principal, target);

      const targetRoles = target.roles.map((membership) => membership.role.name as Role);
      if (targetRoles.some((role) => ADMIN_ROLES.includes(role))) {
        const remaining = await countAdministrators(db, principal.tenantId, userId);
        if (remaining === 0) {
          throw new ConflictError('A workspace must keep at least one administrator', 'LAST_ADMIN');
        }
      }

      await db.userRole.deleteMany({ where: { tenantId: principal.tenantId, userId } });
      await db.user.update({ where: { id: userId }, data: { status: 'suspended' } });

      const sessionsRevoked = await revokeSessionsForUser(db, {
        tenantId: principal.tenantId,
        userId,
        reason: 'removed_from_tenant',
      });

      await recordAudit(
        {
          action: 'tenant.user_removed',
          entityType: 'user',
          entityId: userId,
          actorId: principal.userId,
          actorLabel,
          beforeState: { roles: targetRoles, status: target.status },
          afterState: { roles: [], status: 'suspended', sessionsRevoked },
        },
        db,
      );

      return { sessionsRevoked };
    });
  }

  /** The static role catalogue from §3.6, exposed so the UI can render it. */
  async function roles(): Promise<{ name: Role; permissions: string[] }[]> {
    return (Object.keys(ROLE_PERMISSIONS) as Role[]).map((name) => ({
      name,
      permissions: [...ROLE_PERMISSIONS[name]],
    }));
  }

  return { list, invite, listInvites, setRole, setStatus, remove, roles };
}
