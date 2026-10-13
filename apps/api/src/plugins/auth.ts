/**
 * Authentication & authorization plugin (SRS §3.6, §3.7, FR-2.3–2.5).
 *
 * Two deliberate choices worth understanding:
 *
 * 1. **The principal is re-hydrated from the database on every request.** The JWT
 *    supplies identity (user + tenant), but roles and permissions are read fresh
 *    from `user_roles`. That is what makes FR-2.7 and FR-1.5 take effect
 *    immediately: a role change, a removed membership or a suspended tenant stops
 *    working on the very next request instead of when the token expires.
 * 2. **The permission set in the token is advisory only.** The authoritative
 *    matrix lives in @void-space/types (`ROLE_PERMISSIONS`), so a stale token can
 *    never widen access.
 */
import cookie from '@fastify/cookie';
// Side-effect import: loads @fastify/jwt's ambient declarations, which is what
// augments FastifyInstance with `app.jwt` and makes the augmentation below legal.
import '@fastify/jwt';
import { withTenant } from '@void-space/db';
import {
  READ_ONLY_API_ROLES,
  ROLE_PERMISSIONS,
  type AuthPrincipal,
  type Permission,
  type Role,
} from '@void-space/types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { ACCESS_COOKIE } from '../lib/cookies';
import { ForbiddenError, UnauthenticatedError } from '../lib/errors';

export interface AccessTokenPayload {
  readonly sub: string;
  readonly tid: string;
  readonly roles: readonly Role[];
  readonly perms: readonly Permission[];
  /** Authentication method that produced the token (amr = auth-method reference). */
  readonly amr: 'password' | 'google' | 'invite' | 'apikey';
  /** API key id, present when amr === 'apikey'. */
  readonly kid?: string;
  readonly typ: 'access';
}

/**
 * FR-2.2 — a first-time SSO user's verified Google identity, held for 30 minutes
 * while they choose a workspace. It is deliberately *not* an access token: it has
 * no tenant and carries no permissions.
 */
export interface OnboardingTokenPayload {
  readonly email: string;
  readonly fullName: string;
  readonly googleId: string;
  readonly typ: 'onboarding';
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: AuthPrincipal;
  }
  interface FastifyInstance {
    /** Resolves the caller; throws 401 when absent/invalid. */
    authenticate: (request: FastifyRequest) => Promise<void>;
    /** preHandler factory enforcing one §3.6 permission. */
    requirePermission: (permission: Permission) => (request: FastifyRequest) => Promise<void>;
    /** Signs a short-lived access token with the configured TTL (FR-2.3). */
    signAccessToken: (payload: AccessTokenPayload) => string;
    /**
     * FR-2.2 — a 30-minute proof-of-Google-identity carried in an httpOnly cookie
     * while a first-time SSO user decides how to join the platform.
     */
    signOnboardingToken: (identity: { email: string; fullName: string; googleId: string }) => string;
    verifyOnboardingToken: (
      token: string | undefined,
    ) => { email: string; fullName: string; googleId: string } | null;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessTokenPayload | OnboardingTokenPayload;
    user: AccessTokenPayload;
  }
}

/** Union of every permission granted by the caller's roles in the active tenant. */
export function permissionsForRoles(roles: readonly Role[]): Permission[] {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) granted.add(permission);
  }
  return [...granted];
}

/** Viewer-only memberships are limited to idempotent requests (§3.6). */
export function isReadOnly(roles: readonly Role[]): boolean {
  return roles.length > 0 && roles.every((role) => READ_ONLY_API_ROLES.includes(role));
}

function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    const value = header.slice(7).trim();
    if (value.length > 0) return value;
  }

  const cookieValue = request.cookies[ACCESS_COOKIE];
  return typeof cookieValue === 'string' && cookieValue.length > 0 ? cookieValue : null;
}

/**
 * Reads the caller's current tenant, account state and membership.
 *
 * All three live in one tenant-scoped transaction, so RLS applies exactly as it
 * does for business queries.
 */
export async function hydratePrincipal(payload: AccessTokenPayload): Promise<AuthPrincipal> {
  return withTenant(payload.tid, async (db) => {
    const [tenant, user, memberships] = await Promise.all([
      db.tenant.findUnique({
        where: { id: payload.tid },
        select: { id: true, name: true, slug: true, status: true },
      }),
      db.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, fullName: true, status: true },
      }),
      db.userRole.findMany({
        where: { userId: payload.sub },
        select: { role: { select: { name: true } } },
      }),
    ]);

    if (!tenant) {
      throw new UnauthenticatedError('Workspace no longer exists', 'TENANT_NOT_FOUND');
    }
    if (tenant.status === 'suspended') {
      // FR-1.5: suspension must block API access immediately.
      throw new ForbiddenError('This workspace has been suspended', 'TENANT_SUSPENDED');
    }
    if (!user) {
      throw new UnauthenticatedError('Account no longer exists', 'ACCOUNT_NOT_FOUND');
    }
    if (user.status !== 'active') {
      throw new UnauthenticatedError('Account is not active', 'ACCOUNT_INACTIVE');
    }

    const roles = memberships.map((membership) => membership.role.name as Role);
    if (roles.length === 0) {
      throw new ForbiddenError('No role in this workspace', 'NO_MEMBERSHIP');
    }

    return {
      userId: user.id,
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      email: user.email,
      fullName: user.fullName,
      roles,
      permissions: permissionsForRoles(roles),
      authMethod: payload.amr === 'apikey' ? 'apikey' : 'jwt',
      apiKeyId: payload.kid,
      isSuperAdmin: roles.includes('SuperAdmin'),
      readOnly: isReadOnly(roles),
    } satisfies AuthPrincipal;
  });
}

/** Throws unless the principal holds the permission (FR-2.4). */
export function assertPermission(
  principal: AuthPrincipal,
  permission: Permission,
  method: string,
): void {
  // §3.6 — the Viewer role's REST access is read-only, whatever the route allows.
  if (principal.readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
    throw new ForbiddenError('This token is read-only', 'READ_ONLY_TOKEN');
  }

  if (!principal.permissions.includes(permission)) {
    throw new ForbiddenError(`Missing permission: ${permission}`, 'INSUFFICIENT_PERMISSION', {
      required: permission,
      granted: principal.permissions,
    });
  }
}

export interface AuthPluginOptions {
  readonly accessTtl: string;
}

export const authPlugin = fp<AuthPluginOptions>(
  async (app: FastifyInstance, options: AuthPluginOptions) => {
    // @fastify/cookie is a prerequisite for cookie-borne tokens. It decorates the
    // *request* (`request.cookies`), not the instance — checking the instance
    // would always report false and register the plugin twice.
    if (!app.hasRequestDecorator('cookies')) {
      await app.register(cookie);
    }

    app.decorateRequest('principal', undefined);

    app.decorate('signAccessToken', (payload: AccessTokenPayload) =>
      app.jwt.sign(payload, { expiresIn: options.accessTtl }),
    );

    // --- FR-2.2 onboarding identity -----------------------------------------
    app.decorate(
      'signOnboardingToken',
      (identity: { email: string; fullName: string; googleId: string }) =>
        app.jwt.sign(
          { ...identity, typ: 'onboarding' as const },
          { expiresIn: '30m' },
        ),
    );

    app.decorate(
      'verifyOnboardingToken',
      (token: string | undefined): { email: string; fullName: string; googleId: string } | null => {
        if (!token) return null;
        try {
          const payload = app.jwt.verify<{ typ?: string; email?: string; fullName?: string; googleId?: string }>(
            token,
          );
          if (payload.typ !== 'onboarding' || !payload.email || !payload.googleId) return null;
          return {
            email: payload.email,
            fullName: payload.fullName ?? payload.email,
            googleId: payload.googleId,
          };
        } catch {
          // Expired or tampered: the caller restarts the SSO flow.
          return null;
        }
      },
    );

    app.decorate('authenticate', async (request: FastifyRequest) => {
      const token = extractToken(request);
      if (!token) {
        throw new UnauthenticatedError('Authentication required', 'NO_TOKEN');
      }

      try {
        const payload = app.jwt.verify<AccessTokenPayload>(token);
        if (payload.typ !== 'access') {
          throw new UnauthenticatedError('Wrong token type', 'TOKEN_INVALID');
        }
        request.principal = await hydratePrincipal(payload);
      } catch (error) {
        // Our own errors (suspended tenant, missing role, …) pass through as-is.
        if (error instanceof UnauthenticatedError || error instanceof ForbiddenError) throw error;
        throw new UnauthenticatedError('Invalid or expired token', 'TOKEN_INVALID');
      }
    });

    app.decorate(
      'requirePermission',
      (permission: Permission) =>
        async (request: FastifyRequest): Promise<void> => {
          await app.authenticate(request);
          const principal = request.principal;
          if (!principal) throw new UnauthenticatedError();
          assertPermission(principal, permission, request.method);
        },
    );
  },
  { name: 'void-space-auth' },
);

