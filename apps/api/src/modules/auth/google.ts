/**
 * Google OAuth2 SSO (SRS FR-2.2, §3.7).
 *
 * Implemented directly against Google's OAuth2 endpoints rather than through a
 * helper library: the flow is three HTTP calls, and keeping it explicit means the
 * `state` handling and the "provision on first sign-in" branch stay visible.
 *
 * FR-2.2 requires *provisioning a new account on first sign-in and prompting for
 * tenant selection/creation*. Our users are tenant-scoped, so the parts are:
 *
 *   1. Google returns an email. If it matches existing membership(s) in one or more
 *      workspaces → sign in (or let the user choose a workspace).
 *   2. If it matches nothing, the identity is parked in a short-lived, signed
 *      `vs_onboarding` cookie and the client is asked to either create a workspace
 *      (POST /auth/google/complete) or accept an invitation (POST /auth/invite/accept).
 *
 * Graceful degradation (NFR-REL.1): with no GOOGLE_CLIENT_ID configured the routes
 * answer 503 rather than 500, and the rest of the platform is unaffected.
 */
import { randomUUID } from 'node:crypto';

import { recordAudit, withPlatform, withTenant } from '@void-space/db';

import type { ApiEnv } from '../../env';
import { ConflictError, ServiceUnavailableError, UnauthenticatedError } from '../../lib/errors';
import { slugify, type AuthService, type AuthenticatedResult } from './service';
import type { SessionRequestContext } from './sessions';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export interface GoogleProfile {
  readonly email: string;
  readonly name: string;
  readonly googleId: string;
}

export interface OnboardingIdentity {
  readonly email: string;
  readonly fullName: string;
  readonly googleId: string;
}

export interface GoogleSsoDeps {
  readonly env: ApiEnv;
  readonly auth: AuthService;
}

export interface GoogleSsoService {
  /** True when the deployment has Google credentials configured. */
  isConfigured(): boolean;
  /** The consent-screen URL plus the `state` value the caller must store. */
  startUrl(): { url: string; state: string };
  exchangeCode(code: string, context: SessionRequestContext): Promise<AuthenticatedResult | OnboardingIdentity>;
  /** Creates a workspace for a first-time SSO identity (FR-1.1 via SSO). */
  completeOnboarding(
    identity: OnboardingIdentity,
    input: { organizationName: string; organizationSlug?: string | undefined },
    context: SessionRequestContext,
  ): Promise<AuthenticatedResult>;
}

function required(env: ApiEnv): { clientId: string; clientSecret: string; redirectUri: string } {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
    throw new ServiceUnavailableError(
      'Google SSO is not configured on this deployment',
      'GOOGLE_NOT_CONFIGURED',
    );
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
  };
}

export function createGoogleSsoService(deps: GoogleSsoDeps): GoogleSsoService {
  const configured = Boolean(
    deps.env.GOOGLE_CLIENT_ID && deps.env.GOOGLE_CLIENT_SECRET && deps.env.GOOGLE_REDIRECT_URI,
  );

  function startUrl(): { url: string; state: string } {
    const { clientId, redirectUri } = required(deps.env);
    const state = randomUUID();

    const parameters = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      // Only what the platform needs: an address, a name and a stable subject id.
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
      access_type: 'online',
    });

    return { url: `${GOOGLE_AUTH_URL}?${parameters.toString()}`, state };
  }

  /** Exchanges the authorization code and reads the profile (two HTTP calls). */
  async function exchangeCode(
    code: string,
    context: SessionRequestContext,
  ): Promise<AuthenticatedResult | OnboardingIdentity> {
    const { clientId, clientSecret, redirectUri } = required(deps.env);

    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!tokenResponse.ok) {
      throw new UnauthenticatedError(
        'Google rejected the authorization code',
        'GOOGLE_CODE_REJECTED',
      );
    }
    const tokens = (await tokenResponse.json()) as { access_token?: string };
    if (!tokens.access_token) {
      throw new UnauthenticatedError('Google returned no access token', 'GOOGLE_CODE_REJECTED');
    }

    const userInfoResponse = await fetch(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!userInfoResponse.ok) {
      throw new UnauthenticatedError('Could not read the Google profile', 'GOOGLE_PROFILE_FAILED');
    }

    const profile = (await userInfoResponse.json()) as {
      email?: string;
      email_verified?: boolean;
      name?: string;
      sub?: string;
    };

    if (!profile.email || !profile.sub || profile.email_verified === false) {
      throw new UnauthenticatedError(
        'Google did not return a verified email address',
        'GOOGLE_EMAIL_UNVERIFIED',
      );
    }

    const email = profile.email.toLowerCase();
    const fullName = profile.name ?? email.split('@')[0] ?? email;

    // Existing memberships are looked up across tenants: the identity is known but
    // the workspace is not, which is precisely the platform-role use case (§5.3).
    const memberships = await withPlatform((db) =>
      db.user.findMany({
        where: { email },
        select: {
          id: true,
          tenantId: true,
          googleId: true,
          tenant: { select: { status: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );

    const active = memberships.filter((membership) => membership.tenant.status !== 'suspended');
    if (active.length === 0) {
      // FR-2.2 — provision on first sign-in: the caller now chooses or creates a
      // workspace via /auth/google/complete or accepts an invitation.
      return { email, fullName, googleId: profile.sub };
    }

    // Link the Google subject id on first SSO for an existing account.
    const target = active[0];
    if (!target) {
      throw new UnauthenticatedError('No active workspace for that account', 'NO_MEMBERSHIP');
    }
    if (!target.googleId) {
      await withTenant(target.tenantId, (db) =>
        db.user.update({ where: { id: target.id }, data: { googleId: profile.sub } }),
      );
    }

    // Signed in to the first active membership. A person in several workspaces can
    // switch afterwards (POST /auth/tenant) — the session payload lists them all,
    // so the UI can offer the same chooser as the password flow.
    return deps.auth.loginWithTenant(target.id, target.tenantId, context, 'google');
  }

  /** Creates the workspace for a brand-new SSO identity and signs them in. */
  async function completeOnboarding(
    identity: OnboardingIdentity,
    input: { organizationName: string; organizationSlug?: string | undefined },
    context: SessionRequestContext,
  ): Promise<AuthenticatedResult> {
    const slug = slugify(input.organizationSlug ?? input.organizationName);
    if (slug.length < 2) {
      throw new ConflictError('Organization name must contain letters or digits', 'INVALID_SLUG');
    }

    const taken = await withPlatform((db) => db.tenant.findUnique({ where: { slug } }));
    if (taken) throw new ConflictError('That organization URL is already taken', 'SLUG_TAKEN');

    const tenantId = randomUUID();
    const actorLabel = `${identity.fullName} <${identity.email}>`;

    const userId = await withTenant(tenantId, async (db) => {
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
          email: identity.email,
          fullName: identity.fullName,
          // No password: this account signs in with Google only.
          googleId: identity.googleId,
          status: 'active',
        },
        select: { id: true },
      });

      const role = await db.role.findUnique({
        where: { name: 'TenantAdmin' },
        select: { id: true },
      });
      if (!role) {
        throw new ServiceUnavailableError('Role catalogue is missing', 'ROLES_NOT_SEEDED');
      }
      await db.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });

      await recordAudit(
        {
          action: 'tenant.created',
          entityType: 'tenant',
          entityId: tenantId,
          actorId: user.id,
          actorLabel,
          afterState: { name: input.organizationName, slug, via: 'google_sso' },
        },
        db,
      );

      return user.id;
    });

    return deps.auth.loginWithTenant(userId, tenantId, context, 'google');
  }

  return { isConfigured: () => configured, startUrl, exchangeCode, completeOnboarding };
}
