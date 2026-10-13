/**
 * Authentication service (SRS §3.7, FR-2.1–2.5, FR-2.7).
 *
 * Identity resolution across tenants is the one place that legitimately needs the
 * platform role: a login carries an email but no tenant, and matching it must
 * happen before any tenant context exists. Everything else runs inside
 * `withTenant(...)` under RLS.
 */
import { randomUUID } from 'node:crypto';

import {
  hashPassword,
  parseApiKey,
  recordAudit,
  verifyApiKey,
  verifyPassword,
  withPlatform,
  withTenant,
} from '@void-space/db';
import { ROLE_PERMISSIONS, type AuthPrincipal, type Role, type SessionUser } from '@void-space/types';
import type { Permission } from '@void-space/types';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthenticatedError,
} from '../../lib/errors';

import {
  createSession,
  findSessionByHash,
  generateRefreshToken,
  parseInviteToken,
  parseRefreshToken,
  revokeSession,
  revokeSessionsForUser,
  type SessionRequestContext,
} from './sessions';
import { parseDurationSeconds } from '../../lib/duration';

export interface AccessTokenPayloadShape {
  readonly sub: string;
  readonly tid: string;
  readonly roles: readonly Role[];
  readonly perms: readonly Permission[];
  readonly amr: 'password' | 'google' | 'invite' | 'apikey';
  readonly kid?: string;
  readonly typ: 'access';
}

export interface AuthTokens {
  readonly accessToken: string;
  /** null when the caller authenticated with an API key (no cookie session). */
  readonly refreshToken: string | null;
  readonly accessMaxAgeSeconds: number;
  readonly refreshMaxAgeSeconds: number;
}

export interface AuthenticatedResult extends AuthTokens {
  readonly session: SessionUser;
}

export interface TenantChoice {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly roles: readonly string[];
}

export interface TenantSelectionRequired {
  readonly requiresTenantSelection: true;
  readonly tenants: readonly TenantChoice[];
}

export interface RegisterInput {
  readonly organizationName: string;
  readonly organizationSlug?: string | undefined;
  readonly fullName: string;
  readonly email: string;
  readonly password: string;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly tenantId?: string | undefined;
}

export interface InviteAcceptInput {
  readonly token: string;
  readonly fullName: string;
  readonly password: string;
}

/** One membership row for a person, resolved by email across tenants. */
export interface PersonMembership {
  readonly userId: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantSlug: string;
  readonly tenantStatus: string;
  readonly email: string;
  readonly fullName: string;
  readonly status: string;
  readonly roles: string[];
}

export interface ChangePasswordInput {
  readonly currentPassword: string;
  readonly newPassword: string;
}

export interface AuthService {
  register(input: RegisterInput, context: SessionRequestContext): Promise<AuthenticatedResult>;
  login(
    input: LoginInput,
    context: SessionRequestContext,
  ): Promise<AuthenticatedResult | TenantSelectionRequired>;
  refresh(token: string | undefined, context: SessionRequestContext): Promise<AuthenticatedResult>;
  logout(token: string | undefined): Promise<void>;
  logoutAll(principal: AuthPrincipal): Promise<number>;
  changePassword(principal: AuthPrincipal, input: ChangePasswordInput): Promise<number>;
  exchangeApiKey(apiKey: string): Promise<AuthenticatedResult>;
  /**
   * Issues a session for an identity whose authenticity was established elsewhere
   * (Google SSO, or a future SIWE verification). Kept internal to the module: it is
   * never reachable from an HTTP route without a prior verification step.
   */
  loginWithTenant(
    userId: string,
    tenantId: string,
    context: SessionRequestContext,
    method: 'google' | 'invite',
  ): Promise<AuthenticatedResult>;
  switchTenant(
    principal: AuthPrincipal,
    tenantId: string,
    context: SessionRequestContext,
  ): Promise<AuthenticatedResult>;
  acceptInvite(input: InviteAcceptInput, context: SessionRequestContext): Promise<AuthenticatedResult>;
  /** Session list for the account settings screen. */
  listSessions(principal: AuthPrincipal): Promise<
    {
      id: string;
      createdAt: string;
      lastUsedAt: string | null;
      userAgent: string | null;
      ipAddress: string | null;
      current: boolean;
    }[]
  >;
}

/** Slug helper for tenant signup (FR-1.1). */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Reads every tenant membership for an email address.
 *
 * This is the one query that legitimately needs the platform role: an identity is keyed by email
 * but scoped by tenant, so discovering which workspaces a person belongs to must happen before any
 * tenant context exists. Exported because `GET /auth/me` needs the same list — the workspace
 * switcher (FR-1.4) has to survive a page reload, and it cannot do that from memory.
 */
export async function loadMemberships(email: string): Promise<PersonMembership[]> {
  const rows = await withPlatform((db) =>
    db.user.findMany({
      where: { email },
      select: {
        id: true,
        tenantId: true,
        email: true,
        fullName: true,
        status: true,
        tenant: { select: { id: true, name: true, slug: true, status: true } },
        roles: { select: { role: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    }),
  );

  return rows.map((row) => ({
    userId: row.id,
    tenantId: row.tenantId,
    tenantName: row.tenant.name,
    tenantSlug: row.tenant.slug,
    tenantStatus: row.tenant.status,
    email: row.email,
    fullName: row.fullName,
    status: row.status,
    roles: row.roles.map((membership) => membership.role.name),
  }));
}

function permissionsFor(roles: readonly Role[]): Permission[] {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) granted.add(permission);
  }
  return [...granted];
}

export interface AuthServiceDeps {
  readonly accessTtl: string;
  readonly refreshTtl: string;
  readonly accessMaxAgeSeconds: number;
  readonly refreshMaxAgeSeconds: number;
  readonly signAccessToken: (payload: AccessTokenPayloadShape) => string;
}

/**
 * Builds the service from the app's own token signer, so password login, Google SSO
 * and SIWE all mint tokens through exactly one code path (and one TTL policy).
 */
export function buildAuthService(
  app: { signAccessToken: (payload: AccessTokenPayloadShape) => string },
  env: { readonly JWT_ACCESS_TTL: string; readonly JWT_REFRESH_TTL: string },
): AuthService {
  return createAuthService({
    accessTtl: env.JWT_ACCESS_TTL,
    refreshTtl: env.JWT_REFRESH_TTL,
    accessMaxAgeSeconds: parseDurationSeconds(env.JWT_ACCESS_TTL, 900),
    refreshMaxAgeSeconds: parseDurationSeconds(env.JWT_REFRESH_TTL, 604_800),
    signAccessToken: (payload) => app.signAccessToken(payload),
  });
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  /** Roles held in a specific tenant, read fresh from the database. */
  async function rolesInTenant(tenantId: string, userId: string): Promise<Role[]> {
    const memberships = await withTenant(tenantId, (db) =>
      db.userRole.findMany({
        where: { userId },
        select: { role: { select: { name: true } } },
      }),
    );
    return memberships.map((membership) => membership.role.name as Role);
  }

  async function buildSessionUser(params: {
    readonly email: string;
    readonly userId: string;
    readonly tenantId: string;
    readonly roles: readonly Role[];
  }): Promise<SessionUser> {
    const memberships = await loadMemberships(params.email);
    const current = memberships.find((membership) => membership.userId === params.userId);

    return {
      id: params.userId,
      email: params.email,
      fullName: current?.fullName ?? '',
      activeTenantId: params.tenantId,
      // Every workspace this person can switch to (FR-1.4).
      tenants: memberships.map((membership) => ({
        id: membership.tenantId,
        name: membership.tenantName,
        slug: membership.tenantSlug,
        roles: membership.roles,
      })),
      roles: [...params.roles],
      permissions: permissionsFor(params.roles),
    };
  }

  /** Builds an access token + the session payload for a membership. */
  async function mintAccess(params: {
    readonly tenantId: string;
    readonly userId: string;
    readonly email: string;
    readonly amr: AccessTokenPayloadShape['amr'];
    readonly apiKeyId?: string | undefined;
  }): Promise<{ accessToken: string; session: SessionUser }> {
    const roles = await rolesInTenant(params.tenantId, params.userId);
    if (roles.length === 0) {
      throw new ForbiddenError('No role in this workspace', 'NO_MEMBERSHIP');
    }

    return {
      accessToken: deps.signAccessToken({
        sub: params.userId,
        tid: params.tenantId,
        roles,
        perms: permissionsFor(roles),
        amr: params.amr,
        kid: params.apiKeyId,
        typ: 'access',
      }),
      session: await buildSessionUser({
        email: params.email,
        userId: params.userId,
        tenantId: params.tenantId,
        roles,
      }),
    };
  }

  /** Mints an access token plus a rotating refresh session for a membership. */
  async function issueSession(params: {
    readonly tenantId: string;
    readonly userId: string;
    readonly email: string;
    readonly amr: AccessTokenPayloadShape['amr'];
    readonly apiKeyId?: string | undefined;
    readonly context: SessionRequestContext;
  }): Promise<AuthenticatedResult> {
    const { accessToken, session } = await mintAccess(params);

    const { token: refreshToken, tokenHash } = generateRefreshToken(params.tenantId);
    await withTenant(params.tenantId, (db) =>
      createSession(db, {
        tenantId: params.tenantId,
        userId: params.userId,
        tokenHash,
        ttlSeconds: deps.refreshMaxAgeSeconds,
        context: params.context,
      }),
    );

    return {
      accessToken,
      refreshToken,
      accessMaxAgeSeconds: deps.accessMaxAgeSeconds,
      refreshMaxAgeSeconds: deps.refreshMaxAgeSeconds,
      session,
    };
  }

  // ------------------------------------------------------------------ register
  async function register(
    input: RegisterInput,
    context: SessionRequestContext,
  ): Promise<AuthenticatedResult> {
    const slug = slugify(input.organizationSlug ?? input.organizationName);
    if (slug.length < 2) {
      throw new ConflictError('Organization name must contain letters or digits', 'INVALID_SLUG');
    }

    const taken = await withPlatform((db) => db.tenant.findUnique({ where: { slug } }));
    if (taken) {
      throw new ConflictError('That organization URL is already taken', 'SLUG_TAKEN');
    }

    const tenantId = randomUUID();
    const passwordHash = await hashPassword(input.password);
    const actorLabel = `${input.fullName} <${input.email}>`;

    // Tenant + first TenantAdmin + settings + audit, atomically (FR-1.1, UC-01).
    // The tenant context must equal the new tenant's id for the `tenants` policy.
    const createdUserId = await withTenant(tenantId, async (db) => {
      await db.tenant.create({
        data: { id: tenantId, name: input.organizationName, slug, status: 'active' },
      });
      await db.tenantSettings.create({
        data: {
          tenantId,
          defaultPolycountBudget: 50_000,
          requiredMetadataFields: [],
          allowedCategories: [],
        },
      });

      const user = await db.user.create({
        data: {
          tenantId,
          email: input.email,
          fullName: input.fullName,
          passwordHash,
          status: 'active',
        },
        select: { id: true },
      });

      const role = await db.role.findUnique({
        where: { name: 'TenantAdmin' },
        select: { id: true },
      });
      if (!role) {
        throw new ServiceUnavailableError(
          'Role catalogue is missing — run `pnpm db:rls` and `pnpm db:seed`',
          'ROLES_NOT_SEEDED',
        );
      }

      await db.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });

      await recordAudit(
        {
          action: 'tenant.created',
          entityType: 'tenant',
          entityId: tenantId,
          actorId: user.id,
          actorLabel,
          afterState: { name: input.organizationName, slug, status: 'active' },
        },
        db,
      );
      await recordAudit(
        {
          action: 'auth.register',
          entityType: 'user',
          entityId: user.id,
          actorId: user.id,
          actorLabel,
          afterState: { email: input.email, role: 'TenantAdmin' },
        },
        db,
      );

      return user.id;
    });

    return issueSession({
      tenantId,
      userId: createdUserId,
      email: input.email,
      amr: 'password',
      context,
    });
  }

  // --------------------------------------------------------------------- login
  async function login(
    input: LoginInput,
    context: SessionRequestContext,
  ): Promise<AuthenticatedResult | TenantSelectionRequired> {
    const candidates = await withPlatform((db) =>
      db.user.findMany({
        where: { email: input.email },
        select: {
          id: true,
          tenantId: true,
          passwordHash: true,
          status: true,
          tenant: { select: { id: true, name: true, slug: true, status: true } },
          roles: { select: { role: { select: { name: true } } } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );

    if (candidates.length === 0) {
      // No tenant to attribute the attempt to, so this stays an application log
      // rather than an audit row (documented in the SDD §3.4).
      throw new UnauthenticatedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    const matching = [];
    for (const candidate of candidates) {
      if (await verifyPassword(input.password, candidate.passwordHash)) matching.push(candidate);
    }

    if (matching.length === 0) {
      const attributable = candidates[0];
      if (attributable) {
        await withTenant(attributable.tenantId, (db) =>
          recordAudit(
            {
              action: 'auth.login_failed',
              entityType: 'user',
              entityId: attributable.id,
              actorLabel: input.email,
              afterState: { reason: 'invalid_password' },
            },
            db,
          ),
        );
      }
      throw new UnauthenticatedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    const chosen =
      (input.tenantId
        ? matching.find((candidate) => candidate.tenantId === input.tenantId)
        : undefined) ?? (matching.length === 1 ? matching[0] : undefined);

    if (!chosen) {
      if (matching.length > 1) {
        // FR-1.4: the same person in several workspaces must choose one.
        return {
          requiresTenantSelection: true,
          tenants: matching.map((candidate) => ({
            id: candidate.tenant.id,
            name: candidate.tenant.name,
            slug: candidate.tenant.slug,
            roles: candidate.roles.length > 0 ? [candidate.roles[0].role.name] : [],
          })),
        };
      }
      throw new UnauthenticatedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    if (chosen.tenant.status === 'suspended') {
      throw new ForbiddenError('This workspace has been suspended', 'TENANT_SUSPENDED');
    }
    if (chosen.status !== 'active') {
      throw new ForbiddenError('Account is not active', 'ACCOUNT_INACTIVE');
    }

    await withTenant(chosen.tenantId, async (db) => {
      await db.user.update({ where: { id: chosen.id }, data: { lastLoginAt: new Date() } });
      await recordAudit(
        {
          action: 'auth.login',
          entityType: 'user',
          entityId: chosen.id,
          actorId: chosen.id,
          actorLabel: `${chosen.tenant.name} login`,
          afterState: { method: 'password', tenantId: chosen.tenantId },
        },
        db,
      );
    });

    return issueSession({
      tenantId: chosen.tenantId,
      userId: chosen.id,
      email: input.email,
      amr: 'password',
      context,
    });
  }

  // ------------------------------------------------------------------- refresh
  async function refresh(
    token: string | undefined,
    context: SessionRequestContext,
  ): Promise<AuthenticatedResult> {
    const parsed = parseRefreshToken(token);
    if (!parsed) {
      throw new UnauthenticatedError('Invalid refresh token', 'REFRESH_INVALID');
    }

    const outcome = await withTenant(parsed.tenantId, async (db) => {
      const session = await findSessionByHash(db, parsed.tokenHash);
      if (!session) return { kind: 'missing' as const };

      if (session.revokedAt) {
        // The cookie was already rotated away — treat it as a leaked token and
        // revoke the whole family for that user/tenant (§3.7).
        const revoked = await revokeSessionsForUser(db, {
          tenantId: parsed.tenantId,
          userId: session.userId,
          reason: 'refresh_token_reuse_detected',
        });
        await recordAudit(
          {
            action: 'auth.token_refresh',
            entityType: 'session',
            entityId: session.id,
            actorId: session.userId,
            actorLabel: 'reuse-detected',
            afterState: { reuseDetected: true, sessionsRevoked: revoked },
          },
          db,
        );
        return { kind: 'reuse' as const };
      }

      if (session.expiresAt.getTime() <= Date.now()) {
        return { kind: 'expired' as const };
      }

      const user = await db.user.findUnique({
        where: { id: session.userId },
        select: { id: true, email: true, status: true },
      });
      if (!user || user.status !== 'active') return { kind: 'inactive' as const };

      // Rotate: create the successor first, then revoke this one pointing at it.
      const { token: nextToken, tokenHash: nextHash } = generateRefreshToken(parsed.tenantId);
      const created = await createSession(db, {
        tenantId: parsed.tenantId,
        userId: session.userId,
        tokenHash: nextHash,
        ttlSeconds: deps.refreshMaxAgeSeconds,
        context,
      });

      await revokeSession(db, {
        sessionId: session.id,
        reason: 'rotated',
        replacedById: created.id,
      });
      await db.session.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });

      return {
        kind: 'rotated' as const,
        userId: user.id,
        email: user.email,
        refreshToken: nextToken,
      };
    });

    switch (outcome.kind) {
      case 'missing':
        throw new UnauthenticatedError('Session not found', 'REFRESH_INVALID');
      case 'reuse':
        throw new UnauthenticatedError(
          'This session was already rotated; all sessions have been revoked',
          'REFRESH_REUSE_DETECTED',
        );
      case 'expired':
        throw new UnauthenticatedError('Refresh token expired', 'REFRESH_EXPIRED');
      case 'inactive':
        throw new UnauthenticatedError('Account is not active', 'ACCOUNT_INACTIVE');
      case 'rotated': {
        const { accessToken, session } = await mintAccess({
          tenantId: parsed.tenantId,
          userId: outcome.userId,
          email: outcome.email,
          amr: 'password',
        });
        return {
          accessToken,
          refreshToken: outcome.refreshToken,
          accessMaxAgeSeconds: deps.accessMaxAgeSeconds,
          refreshMaxAgeSeconds: deps.refreshMaxAgeSeconds,
          session,
        };
      }
    }
  }

  // -------------------------------------------------------------------- logout
  async function logout(token: string | undefined): Promise<void> {
    const parsed = parseRefreshToken(token);
    if (!parsed) return; // Nothing to revoke; the caller clears the cookies anyway.

    await withTenant(parsed.tenantId, async (db) => {
      const session = await findSessionByHash(db, parsed.tokenHash);
      if (session && !session.revokedAt) {
        await revokeSession(db, { sessionId: session.id, reason: 'logout' });
        await recordAudit(
          {
            action: 'auth.logout',
            entityType: 'session',
            entityId: session.id,
            actorId: session.userId,
            afterState: { reason: 'user_logout' },
          },
          db,
        );
      }
    });
  }

  /** FR-2.7 — "sign out everywhere". */
  async function logoutAll(principal: AuthPrincipal): Promise<number> {
    return withTenant(principal.tenantId, async (db) => {
      const revoked = await revokeSessionsForUser(db, {
        tenantId: principal.tenantId,
        userId: principal.userId,
        reason: 'logout_all',
      });
      await recordAudit(
        {
          action: 'auth.logout',
          entityType: 'user',
          entityId: principal.userId,
          actorId: principal.userId,
          actorLabel: `${principal.fullName} <${principal.email}>`,
          afterState: { scope: 'all_sessions', sessionsRevoked: revoked },
        },
        db,
      );
      return revoked;
    });
  }

  /**
   * FR-2.7: changing a password invalidates every refresh token for the user in
   * that workspace, so a stolen session cannot outlive the credential change.
   */
  async function changePassword(
    principal: AuthPrincipal,
    input: { currentPassword: string; newPassword: string },
  ): Promise<number> {
    const passwordHash = await hashPassword(input.newPassword);

    return withTenant(principal.tenantId, async (db) => {
      const user = await db.user.findUnique({
        where: { id: principal.userId },
        select: { id: true, passwordHash: true },
      });
      if (!user) throw new NotFoundError('User');

      const valid = await verifyPassword(input.currentPassword, user.passwordHash);
      if (!valid) {
        throw new UnauthenticatedError('Current password is incorrect', 'INVALID_CREDENTIALS');
      }

      await db.user.update({ where: { id: user.id }, data: { passwordHash } });
      const revoked = await revokeSessionsForUser(db, {
        tenantId: principal.tenantId,
        userId: user.id,
        reason: 'password_changed',
      });
      await recordAudit(
        {
          action: 'auth.password_changed',
          entityType: 'user',
          entityId: user.id,
          actorId: principal.userId,
          actorLabel: `${principal.fullName} <${principal.email}>`,
          afterState: { sessionsRevoked: revoked },
        },
        db,
      );
      return revoked;
    });
  }

  /**
   * FR-2.5 — machine-to-machine authentication. The tenant is read out of the key
   * itself (see packages/db/src/apikey.ts), so the verification query runs under
   * that tenant's RLS context rather than with platform privileges.
   */
  async function exchangeApiKey(apiKey: string): Promise<AuthenticatedResult> {
    const parsed = parseApiKey(apiKey);
    if (!parsed) {
      throw new UnauthenticatedError('Malformed API key', 'API_KEY_MALFORMED');
    }

    const match = await withTenant(parsed.tenantId, async (db) => {
      const candidates = await db.apiKey.findMany({
        where: { prefix: parsed.prefix, revokedAt: null },
        select: {
          id: true,
          userId: true,
          hashedKey: true,
          expiresAt: true,
          user: { select: { id: true, email: true, status: true } },
        },
      });

      return candidates.find((candidate) => verifyApiKey(apiKey, candidate.hashedKey)) ?? null;
    });

    if (!match) {
      throw new UnauthenticatedError('Invalid API key', 'API_KEY_INVALID');
    }
    if (match.expiresAt && match.expiresAt.getTime() <= Date.now()) {
      throw new UnauthenticatedError('API key expired', 'API_KEY_EXPIRED');
    }
    if (match.user.status !== 'active') {
      throw new ForbiddenError('Account is not active', 'ACCOUNT_INACTIVE');
    }

    await withTenant(parsed.tenantId, (db) =>
      db.apiKey.update({ where: { id: match.id }, data: { lastUsedAt: new Date() } }),
    );

    // No refresh token: an API key is exchanged for a short-lived access token only.
    const { accessToken, session } = await mintAccess({
      tenantId: parsed.tenantId,
      userId: match.userId,
      email: match.user.email,
      amr: 'apikey',
      apiKeyId: match.id,
    });

    return {
      accessToken,
      refreshToken: null,
      accessMaxAgeSeconds: deps.accessMaxAgeSeconds,
      refreshMaxAgeSeconds: deps.refreshMaxAgeSeconds,
      session,
    };
  }

  /** FR-1.4 — switching workspaces issues a new tenant-scoped session. */
  async function switchTenant(
    principal: AuthPrincipal,
    tenantId: string,
    context: SessionRequestContext,
  ): Promise<AuthenticatedResult> {
    const memberships = await loadMemberships(principal.email);
    const target = memberships.find((membership) => membership.tenantId === tenantId);

    if (!target) {
      throw new ForbiddenError('You are not a member of that workspace', 'NOT_A_MEMBER');
    }
    if (target.tenantStatus === 'suspended') {
      throw new ForbiddenError('This workspace has been suspended', 'TENANT_SUSPENDED');
    }
    if (target.status !== 'active') {
      throw new ForbiddenError('Your account is not active in that workspace', 'ACCOUNT_INACTIVE');
    }

    // A tenant switch starts a fresh session in the target tenant; the previous one
    // stays valid so the user can switch back without re-authenticating.
    const result = await issueSession({
      tenantId,
      userId: target.userId,
      email: principal.email,
      amr: 'password',
      context,
    });

    await withTenant(tenantId, (db) =>
      recordAudit(
        {
          action: 'auth.tenant_switch',
          entityType: 'user',
          entityId: target.userId,
          actorId: target.userId,
          actorLabel: `${principal.fullName} <${principal.email}>`,
          afterState: { from: principal.tenantId, to: tenantId },
        },
        db,
      ),
    );

    return result;
  }

  /**
   * FR-2.6 — accepting an invitation sets the invitee's name and password. The
   * invite token is `<tenantHex>.<secret>` like a refresh token, so the lookup can
   * happen inside the right tenant context.
   */
  async function acceptInvite(
    input: InviteAcceptInput,
    context: SessionRequestContext,
  ): Promise<AuthenticatedResult> {
    const parsed = parseInviteToken(input.token);
    if (!parsed) throw new NotFoundError('Invitation');

    const invite = await withTenant(parsed.tenantId, (db) =>
      db.invite.findUnique({
        where: { tokenHash: parsed.tokenHash },
        select: {
          id: true,
          tenantId: true,
          email: true,
          role: true,
          expiresAt: true,
          acceptedAt: true,
        },
      }),
    );

    if (!invite) throw new NotFoundError('Invitation');
    if (invite.acceptedAt) {
      throw new ConflictError('This invitation has already been accepted', 'INVITE_ALREADY_USED');
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
      throw new ConflictError('This invitation has expired', 'INVITE_EXPIRED');
    }

    const passwordHash = await hashPassword(input.password);
    const actorLabel = `${input.fullName} <${invite.email}>`;

    const createdUserId = await withTenant(invite.tenantId, async (db) => {
      // The invitee may already exist in this tenant (re-invited after leaving).
      const existing = await db.user.findUnique({
        where: { tenantId_email: { tenantId: invite.tenantId, email: invite.email } },
        select: { id: true },
      });

      const user = existing
        ? await db.user.update({
            where: { id: existing.id },
            data: { fullName: input.fullName, passwordHash, status: 'active' },
            select: { id: true },
          })
        : await db.user.create({
            data: {
              tenantId: invite.tenantId,
              email: invite.email,
              fullName: input.fullName,
              passwordHash,
              status: 'active',
            },
            select: { id: true },
          });

      const role = await db.role.findUnique({
        where: { name: invite.role },
        select: { id: true },
      });
      if (!role) {
        throw new ServiceUnavailableError('Role catalogue is missing', 'ROLES_NOT_SEEDED');
      }

      const alreadyHasRole = await db.userRole.findFirst({
        where: { tenantId: invite.tenantId, userId: user.id, roleId: role.id },
        select: { id: true },
      });
      if (!alreadyHasRole) {
        await db.userRole.create({
          data: { tenantId: invite.tenantId, userId: user.id, roleId: role.id },
        });
      }

      await db.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });

      await recordAudit(
        {
          action: 'user.invite_accepted',
          entityType: 'user',
          entityId: user.id,
          actorId: user.id,
          actorLabel,
          afterState: { email: invite.email, inviteId: invite.id, role: invite.role },
        },
        db,
      );

      return user.id;
    });

    return issueSession({
      tenantId: invite.tenantId,
      userId: createdUserId,
      email: invite.email,
      amr: 'invite',
      context,
    });
  }

  /**
   * Issues a session for an identity verified by another mechanism (FR-2.2 Google
   * SSO, FR-2.6 SIWE). The caller must have established authenticity first; this
   * function only mints tokens.
   */
  async function loginWithTenant(
    userId: string,
    tenantId: string,
    context: SessionRequestContext,
    method: 'google' | 'invite',
  ): Promise<AuthenticatedResult> {
    const outcome = await withPlatform((db) =>
      db.user.findUnique({ where: { id: userId }, select: { email: true } }),
    );
    if (!outcome) throw new NotFoundError('User');

    return issueSession({
      tenantId,
      userId,
      email: outcome.email,
      amr: method,
      context,
    });
  }

  /** Session list for account settings (FR-2.3 visibility of active sessions). */
  async function listSessions(principal: AuthPrincipal) {
    const sessions = await withTenant(principal.tenantId, (db) =>
      db.session.findMany({
        where: { tenantId: principal.tenantId, userId: principal.userId },
        select: {
          id: true,
          createdAt: true,
          lastUsedAt: true,
          userAgent: true,
          ipAddress: true,
          revokedAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );

    return sessions.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      userAgent: row.userAgent,
      ipAddress: row.ipAddress,
      current: row.revokedAt === null,
    }));
  }

  return {
    register,
    login,
    refresh,
    logout,
    logoutAll,
    changePassword,
    exchangeApiKey,
    switchTenant,
    acceptInvite,
    loginWithTenant,
    listSessions,
  };
}

