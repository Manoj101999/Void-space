/**
 * Authentication routes (SRS FR-2.1–2.7, §3.7).
 *
 *   POST  /api/v1/auth/register       FR-1.1  create workspace + first TenantAdmin
 *   POST  /api/v1/auth/login          FR-2.1  email/password (+ FR-1.4 tenant choice)
 *   POST  /api/v1/auth/refresh        FR-2.3  rotating refresh token
 *   POST  /api/v1/auth/logout         FR-2.3  revoke the current session
 *   POST  /api/v1/auth/logout-all     FR-2.7  revoke every session for the user
 *   POST  /api/v1/auth/tenant         FR-1.4  switch active workspace
 *   POST  /api/v1/auth/token          FR-2.5  API key → short-lived bearer token
 *   GET   /api/v1/auth/me             §6.1    session for the UI shell
 *   PATCH /api/v1/auth/password       FR-2.7  change password (kills sessions)
 *   GET   /api/v1/auth/sessions       FR-2.3  list active sessions
 *   POST  /api/v1/auth/invite/accept  FR-2.6  accept an invitation
 *
 * Browser responses set the access cookie (and, where applicable, a rotated
 * refresh cookie) rather than returning tokens in the body, per §2.5.
 */
import {
  acceptInviteSchema,
  apiKeyExchangeSchema,
  changePasswordSchema,
  loginSchema,
  registerSchema,
  switchTenantSchema,
  type AuthResponse,
  type SessionUser,
} from '@void-space/types';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { ApiEnv } from '../../env';
import {
  REFRESH_COOKIE,
  clearAuthCookies,
  clearOnboardingCookie,
  cookieSecurity,
  setAccessCookie,
  setRefreshCookie,
} from '../../lib/cookies';
import { parseDurationSeconds } from '../../lib/duration';
import { parseBody, requestContext } from '../../lib/http';
import {
  buildAuthService,
  loadMemberships,
  type AuthenticatedResult,
  type TenantSelectionRequired,
} from './service';

/**
 * FR-2.1 — per-route limits on top of the global one, to blunt credential stuffing.
 *
 * Integration tests deliberately drive many auth flows from a single IP (every
 * request in `inject()` shares it), so the test environment uses limits that
 * cannot mask a functional regression. Production values are the ones above.
 */
const PROD_LIMITS = {
  login: { max: 10, timeWindow: '1 minute' },
  register: { max: 5, timeWindow: '1 hour' },
  refresh: { max: 60, timeWindow: '1 minute' },
} as const;

const TEST_LIMITS = {
  login: { max: 1000, timeWindow: '1 minute' },
  register: { max: 1000, timeWindow: '1 hour' },
  refresh: { max: 1000, timeWindow: '1 minute' },
} as const;

export interface AuthRoutesOptions {
  readonly env: ApiEnv;
}

export async function authRoutes(
  app: FastifyInstance,
  options: AuthRoutesOptions,
): Promise<void> {
  const { env } = options;
  const secure = cookieSecurity(env);
  const accessMaxAgeSeconds = parseDurationSeconds(env.JWT_ACCESS_TTL, 900);
  const refreshMaxAgeSeconds = parseDurationSeconds(env.JWT_REFRESH_TTL, 604_800);
  const limits = env.NODE_ENV === 'test' ? TEST_LIMITS : PROD_LIMITS;

  const auth = buildAuthService(app, env);

  /** Writes both cookies and shapes the JSON body (FR-2.3). */
  function completeAuth(
    reply: FastifyReply,
    result: AuthenticatedResult,
    statusCode = 200,
  ): AuthResponse {
    setAccessCookie(reply, result.accessToken, {
      secure,
      sameSite: 'lax',
      maxAgeSeconds: accessMaxAgeSeconds,
    });
    if (result.refreshToken) {
      setRefreshCookie(reply, result.refreshToken, {
        secure,
        sameSite: 'lax',
        maxAgeSeconds: refreshMaxAgeSeconds,
      });
    }
    reply.status(statusCode);
    return { user: result.session, accessTokenExpiresIn: accessMaxAgeSeconds };
  }

  function isTenantChoice(
    value: AuthenticatedResult | TenantSelectionRequired,
  ): value is TenantSelectionRequired {
    return 'requiresTenantSelection' in value;
  }

  // ------------------------------------------------------------------- register
  app.post(
    '/register',
    { config: { rateLimit: limits.register } },
    async (request, reply) => {
      const input = parseBody(registerSchema, request.body);
      const result = await auth.register(input, requestContext(request));
      return completeAuth(reply, result, 201);
    },
  );

  // ---------------------------------------------------------------------- login
  app.post('/login', { config: { rateLimit: limits.login } }, async (request, reply) => {
    const input = parseBody(loginSchema, request.body);
    const result = await auth.login(input, requestContext(request));

    if (isTenantChoice(result)) {
      // FR-1.4/FR-2.2: the client re-posts the same credentials with a tenantId.
      return reply.status(200).send(result);
    }
    return completeAuth(reply, result);
  });

  // -------------------------------------------------------------------- refresh
  app.post('/refresh', { config: { rateLimit: limits.refresh } }, async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE];
    const result = await auth.refresh(token, requestContext(request));
    return completeAuth(reply, result);
  });

  // --------------------------------------------------------------------- logout
  app.post('/logout', async (request, reply) => {
    await auth.logout(request.cookies[REFRESH_COOKIE]);
    clearAuthCookies(reply, secure);
    clearOnboardingCookie(reply, secure);
    return reply.status(204).send();
  });

  app.post('/logout-all', async (request, reply) => {
    await app.authenticate(request);
    const principal = request.principal;
    if (!principal) return reply.status(401).send({ code: 'UNAUTHENTICATED' });

    const revoked = await auth.logoutAll(principal);
    clearAuthCookies(reply, secure);
    return reply.status(200).send({ sessionsRevoked: revoked });
  });

  // -------------------------------------------------------------------- /token
  app.post('/token', { config: { rateLimit: limits.login } }, async (request, reply) => {
    const input = parseBody(apiKeyExchangeSchema, request.body);
    const result = await auth.exchangeApiKey(input.apiKey);
    // Machine-to-machine callers (FR-2.5) cannot hold cookies, so they get a
    // short-lived bearer token in the body instead.
    return reply.status(200).send({
      accessToken: result.accessToken,
      tokenType: 'Bearer',
      expiresIn: result.accessMaxAgeSeconds,
      user: result.session,
    });
  });

  // ------------------------------------------------------------- tenant switch
  app.post('/tenant', async (request, reply) => {
    await app.authenticate(request);
    const principal = request.principal;
    if (!principal) return reply.status(401).send({ code: 'UNAUTHENTICATED' });

    const input = parseBody(switchTenantSchema, request.body);
    const result = await auth.switchTenant(principal, input.tenantId, requestContext(request));
    return completeAuth(reply, result);
  });

  // ------------------------------------------------------------------------ /me
  app.get('/me', async (request, reply) => {
    await app.authenticate(request);
    const principal = request.principal;
    if (!principal) return reply.status(401).send({ code: 'UNAUTHENTICATED' });

    // The workspace list is read on every call rather than carried in the token: a membership added
    // or removed elsewhere must show up without waiting for the access token to expire (FR-1.4).
    const memberships = await loadMemberships(principal.email);

    const session: SessionUser = {
      id: principal.userId,
      email: principal.email,
      fullName: principal.fullName,
      activeTenantId: principal.tenantId,
      tenants: memberships.map((membership) => ({
        id: membership.tenantId,
        name: membership.tenantName,
        slug: membership.tenantSlug,
        roles: membership.roles,
      })),
      roles: [...principal.roles],
      permissions: [...principal.permissions],
    };

    return reply.status(200).send({
      user: session,
      tenant: { id: principal.tenantId, name: principal.tenantName, slug: principal.tenantSlug },
      authMethod: principal.authMethod,
      readOnly: principal.readOnly,
    });
  });

  // ----------------------------------------------------------- password change
  app.patch('/password', async (request, reply) => {
    await app.authenticate(request);
    const principal = request.principal;
    if (!principal) return reply.status(401).send({ code: 'UNAUTHENTICATED' });

    const input = parseBody(changePasswordSchema, request.body);
    const revoked = await auth.changePassword(principal, input);
    // FR-2.7 — the caller's own session is revoked too, so drop the cookies.
    clearAuthCookies(reply, secure);
    return reply.status(200).send({
      sessionsRevoked: revoked,
      message: 'Password updated. All sessions were signed out.',
    });
  });

  // ---------------------------------------------------------------- sessions
  app.get('/sessions', async (request, reply) => {
    await app.authenticate(request);
    const principal = request.principal;
    if (!principal) return reply.status(401).send({ code: 'UNAUTHENTICATED' });

    const sessions = await auth.listSessions(principal);
    return reply.status(200).send({ sessions });
  });

  // ------------------------------------------------------------- invite accept
  app.post('/invite/accept', { config: { rateLimit: limits.login } }, async (request, reply) => {
    const input = parseBody(acceptInviteSchema, request.body);
    const result = await auth.acceptInvite(input, requestContext(request));
    clearOnboardingCookie(reply, secure);
    return completeAuth(reply, result, 201);
  });
}
