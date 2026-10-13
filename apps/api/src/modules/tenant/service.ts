/**
 * Tenant administration (SRS FR-1.1–1.5, FR-14.3, §3.5).
 *
 * Scope boundary worth stating explicitly: **tenant creation is not here.** FR-1.1
 * describes self-service signup, which is implemented in `POST /auth/register`
 * because the first TenantAdmin's session is established in the same transaction.
 * This module owns the tenant *lifecycle* afterwards.
 *
 * Platform-level operations (listing tenants, suspending one) run under the
 * dedicated platform role — the documented SuperAdmin bypass of §3.5 — and every
 * one of them writes an audit row.
 */
import { randomBytes } from 'node:crypto';

import { recordAudit, withPlatform, withTenant } from '@void-space/db';
import type { AuthPrincipal, TenantSettingsInput, TenantSummary } from '@void-space/types';

import { ForbiddenError, NotFoundError } from '../../lib/errors';
import { revokeTenantSessions } from '../auth/sessions';

export interface TenantDetail {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: 'active' | 'suspended';
  readonly suspendedReason: string | null;
  readonly createdAt: string;
  readonly settings: {
    defaultPolycountBudget: number | null;
    requiredMetadataFields: string[];
    allowedCategories: string[];
    webhookUrl: string | null;
    webhookEvents: string[];
  };
  readonly counts: { users: number; assets: number; licenses: number; pendingReview: number };
}

export interface TenantsService {
  detail(principal: AuthPrincipal): Promise<TenantDetail>;
  updateSettings(
    principal: AuthPrincipal,
    input: TenantSettingsInput,
  ): Promise<TenantDetail['settings']>;
  list(principal: AuthPrincipal): Promise<TenantSummary[]>;
  setStatus(
    principal: AuthPrincipal,
    tenantId: string,
    status: 'active' | 'suspended',
    reason?: string | undefined,
  ): Promise<{ tenant: TenantSummary; sessionsRevoked: number }>;
}

function assertSuperAdmin(principal: AuthPrincipal): void {
  if (!principal.isSuperAdmin) {
    throw new ForbiddenError(
      'Only a SuperAdmin can manage tenants',
      'INSUFFICIENT_PERMISSION',
      { required: 'tenant:manage' },
    );
  }
}

export function createTenantsService(): TenantsService {
  async function loadDetail(principal: AuthPrincipal): Promise<TenantDetail> {
    return withTenant(principal.tenantId, async (db) => {
      const [tenant, settings, webhook, users, assets, licenses, pendingReview] = await Promise.all([
        db.tenant.findUnique({
          where: { id: principal.tenantId },
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            suspendedReason: true,
            createdAt: true,
          },
        }),
        db.tenantSettings.findUnique({ where: { tenantId: principal.tenantId } }),
        db.webhook.findFirst({
          where: { tenantId: principal.tenantId, isActive: true },
          orderBy: { createdAt: 'desc' },
          select: { url: true, events: true },
        }),
        db.user.count({ where: { tenantId: principal.tenantId } }),
        db.asset.count({ where: { tenantId: principal.tenantId } }),
        db.license.count({ where: { tenantId: principal.tenantId } }),
        db.asset.count({
          // "Awaiting a human decision" per §5.1's lifecycle: the AI could not
          // classify confidently, or it has been routed for review manually.
          where: {
            tenantId: principal.tenantId,
            status: { in: ['pending', 'needs_manual_review'] },
          },
        }),
      ]);

      if (!tenant) throw new NotFoundError('Workspace');

      return {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        suspendedReason: tenant.suspendedReason,
        createdAt: tenant.createdAt.toISOString(),
        settings: {
          defaultPolycountBudget: settings?.defaultPolycountBudget ?? null,
          requiredMetadataFields: settings?.requiredMetadataFields ?? [],
          allowedCategories: settings?.allowedCategories ?? [],
          webhookUrl: webhook?.url ?? null,
          webhookEvents: webhook?.events ?? [],
        },
        counts: { users, assets, licenses, pendingReview },
      };
    });
  }

  async function detail(principal: AuthPrincipal): Promise<TenantDetail> {
    return loadDetail(principal);
  }

  /**
   * FR-14.3 — tenant-level defaults applied at upload time.
   *
   * Gated on `tenant:manage`, which the §3.6 matrix grants to SuperAdmin only
   * ("Manage tenants"). TenantAdmin holds `tenant:manage-users` — user and role
   * administration — but not workspace policy. See docs/VS-SDD-2.0-data-model.md
   * §4 for the open question this raises with FR-14.3.
   */
  async function updateSettings(
    principal: AuthPrincipal,
    input: TenantSettingsInput,
  ): Promise<TenantDetail['settings']> {
    assertSuperAdmin(principal);
    const actorLabel = `${principal.fullName} <${principal.email}>`;

    await withTenant(principal.tenantId, async (db) => {
      const before = await db.tenantSettings.findUnique({
        where: { tenantId: principal.tenantId },
      });

      const next = {
        defaultPolycountBudget:
          input.defaultPolycountBudget === undefined
            ? (before?.defaultPolycountBudget ?? null)
            : input.defaultPolycountBudget,
        requiredMetadataFields: input.requiredMetadataFields,
        allowedCategories: input.allowedCategories,
      };

      await db.tenantSettings.upsert({
        where: { tenantId: principal.tenantId },
        create: { tenantId: principal.tenantId, ...next },
        update: next,
      });

      // The webhook endpoint lives in its own table (§3.9 integration surface), so
      // it is upserted separately and only when the caller actually supplied it.
      if (input.webhookUrl !== undefined) {
        const existing = await db.webhook.findFirst({
          where: { tenantId: principal.tenantId, isActive: true },
          select: { id: true },
        });

        if (!input.webhookUrl) {
          if (existing) {
            await db.webhook.update({ where: { id: existing.id }, data: { isActive: false } });
          }
        } else if (existing) {
          await db.webhook.update({
            where: { id: existing.id },
            data: { url: input.webhookUrl, events: input.webhookEvents },
          });
        } else {
          await db.webhook.create({
            data: {
              tenantId: principal.tenantId,
              url: input.webhookUrl,
              events: input.webhookEvents,
              // Signing secret for outbound payloads (HMAC); generated once.
              secret: randomBytes(32).toString('base64url'),
            },
          });
        }
      }

      await recordAudit(
        {
          action: 'tenant.settings_updated',
          entityType: 'tenant',
          entityId: principal.tenantId,
          actorId: principal.userId,
          actorLabel,
          beforeState: before
            ? {
                defaultPolycountBudget: before.defaultPolycountBudget,
                requiredMetadataFields: before.requiredMetadataFields,
                allowedCategories: before.allowedCategories,
              }
            : null,
          afterState: next,
        },
        db,
      );
    });

    return (await loadDetail(principal)).settings;
  }

  /** FR-14.1 — platform tenant list (SuperAdmin only). */
  async function list(principal: AuthPrincipal): Promise<TenantSummary[]> {
    assertSuperAdmin(principal);

    // User counts come from the platform role. Asset and licence counts cannot: §5.3 denies the
    // platform role access to those tables, so a `_count` over them is a permission error — a
    // useful example of the boundary being real rather than aspirational.
    const rows = await withPlatform((db) =>
      db.tenant.findMany({
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          createdAt: true,
          _count: { select: { users: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );

    // So content counts are read one tenant at a time, each inside its *own* RLS context. That is
    // N queries for N workspaces, which is the honest cost of not granting the platform role a
    // cross-tenant read. This screen is a SuperAdmin console, not a hot path, and the count is
    // bounded by the number of workspaces rather than by their size.
    const counts = await Promise.all(
      rows.map((row) =>
        withTenant(row.id, async (db) => {
          const [assetCount, licenseCount] = await Promise.all([
            db.asset.count({ where: { tenantId: row.id } }),
            db.license.count({ where: { tenantId: row.id } }),
          ]);
          return { assetCount, licenseCount };
        }),
      ),
    );

    return rows.map((row, index) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      userCount: row._count.users,
      assetCount: counts[index]?.assetCount ?? 0,
      licenseCount: counts[index]?.licenseCount ?? 0,
    }));
  }

  /**
   * FR-1.5 / FR-14.1 — suspend or reinstate a workspace.
   *
   * Suspension revokes every refresh token in the tenant immediately (FR-2.7), and
   * the auth plugin already refuses requests whose tenant is suspended, so access
   * stops on the next request rather than when tokens expire.
   */
  async function setStatus(
    principal: AuthPrincipal,
    tenantId: string,
    status: 'active' | 'suspended',
    reason?: string | undefined,
  ): Promise<{ tenant: TenantSummary; sessionsRevoked: number }> {
    assertSuperAdmin(principal);
    const actorLabel = `${principal.fullName} <${principal.email}>`;

    // The tenant row itself is platform-scoped (§5.3), while the sessions and the
    // audit row are tenant-scoped, so the two halves run in their own contexts.
    const before = await withPlatform((db) =>
      db.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, name: true, slug: true, status: true, createdAt: true },
      }),
    );
    if (!before) throw new NotFoundError('Workspace');

    const sessionsRevoked = await withTenant(tenantId, (db) =>
      revokeTenantSessions(db, {
        tenantId,
        reason: status === 'suspended' ? 'tenant_suspended' : 'tenant_reinstated',
      }),
    );

    await withPlatform((db) =>
      db.tenant.update({
        where: { id: tenantId },
        data: {
          status,
          suspendedAt: status === 'suspended' ? new Date() : null,
          suspendedReason: status === 'suspended' ? (reason?.slice(0, 500) ?? null) : null,
        },
      }),
    );

    await withTenant(tenantId, (db) =>
      recordAudit(
        {
          action: status === 'suspended' ? 'tenant.suspended' : 'tenant.reinstated',
          entityType: 'tenant',
          entityId: tenantId,
          actorId: principal.userId,
          actorLabel,
          beforeState: { status: before.status },
          afterState: { status, reason: reason ?? null, sessionsRevoked },
        },
        db,
      ),
    );

    const counts = await withPlatform((db) =>
      db.tenant.findUnique({
        where: { id: tenantId },
        // Users only — see the note in list() about the platform role's limits.
        select: { _count: { select: { users: true } } },
      }),
    );

    return {
      tenant: {
        id: before.id,
        name: before.name,
        slug: before.slug,
        status,
        createdAt: before.createdAt.toISOString(),
        userCount: counts?._count.users ?? 0,
      },
      sessionsRevoked,
    };
  }

  return { detail, updateSettings, list, setStatus };
}
