/**
 * Google SSO routes (FR-2.2).
 *
 *   GET  /api/v1/auth/google/start      redirect to Google's consent screen
 *   GET  /api/v1/auth/google/callback   exchange the code, then either sign in or
 *                                       park the identity for onboarding
 *   POST /api/v1/auth/google/complete   create a workspace for a first-time user
 *   GET  /api/v1/auth/providers         which login methods this deployment offers
 *
 * `state` is verified against a SameSite=Lax, httpOnly cookie before the code is
 * exchanged, so a cross-site login-CSRF cannot complete the flow.
 */
import { registerSchema, type AuthResponse, type SessionUser } from '@void-space/types';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { ApiEnv } from '../../env';
import {
  OAUTH_STATE_COOKIE,
  ONBOARDING_COOKIE,
  clearOnboardingCookie,
  cookieSecurity,
  setAccessCookie,
  setOnboardingCookie,
  setRefreshCookie,
} from '../../lib/cookies';
import { parseDurationSeconds } from '../../lib/duration';
import { UnauthenticatedError } from '../../lib/errors';
import { parseBody, requestContext } from '../../lib/http';
import { createGoogleSsoService, type OnboardingIdentity } from './google';
import { buildAuthService, type AuthService, type AuthenticatedResult } from './service';

const ONBOARDING_TTL_SECONDS = 30 * 60;

export interface GoogleRoutesOptions {
  readonly env: ApiEnv;
}

export async function googleRoutes(
  app: FastifyInstance,
  options: GoogleRoutesOptions,
): Promise<void> {
  const { env } = options;
  const secure = cookieSecurity(env);
  const accessMaxAgeSeconds = parseDurationSeconds(env.JWT_ACCESS_TTL, 900);
  const refreshMaxAgeSeconds = parseDurationSeconds(env.JWT_REFRESH_TTL, 604_800);

  // Same service instance wiring as password login: one TTL policy, one signer.
  const auth: AuthService = buildAuthService(app, env);
  const google = createGoogleSsoService({ env, auth });

  function completeAuth(reply: FastifyReply, result: AuthenticatedResult): AuthResponse {
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
    clearOnboardingCookie(reply, secure);
    return { user: result.session as SessionUser, accessTokenExpiresIn: accessMaxAgeSeconds };
  }

  app.get('/google/start', async (_request, reply) => {
    const { url, state } = google.startUrl();
    reply.setCookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: 600,
    });
    // Redirect the browser straight to Google.
    return reply.redirect(url, 302);
  });

  app.get('/google/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string };

    if (query.error) {
      throw new UnauthenticatedError(`Google sign-in was cancelled (${query.error})`, 'GOOGLE_CANCELLED');
    }
    if (!query.code || !query.state) {
      throw new UnauthenticatedError('Missing code or state from Google', 'GOOGLE_BAD_CALLBACK');
    }

    const expectedState = request.cookies[OAUTH_STATE_COOKIE];
    if (!expectedState || expectedState !== query.state) {
      // Login-CSRF attempt, or a stale/replayed callback.
      throw new UnauthenticatedError('OAuth state mismatch', 'GOOGLE_STATE_MISMATCH');
    }
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/api/v1/auth', secure, httpOnly: true });

    const result = await google.exchangeCode(query.code, requestContext(request));

    // No membership yet → FR-2.2's "prompt for tenant selection/creation".
    if ('googleId' in result) {
      const token = app.signOnboardingToken(result);
      setOnboardingCookie(reply, token, {
        secure,
        sameSite: 'lax',
        maxAgeSeconds: ONBOARDING_TTL_SECONDS,
      });
      return reply.status(200).send({
        requiresOnboarding: true,
        email: result.email,
        fullName: result.fullName,
        options: ['create_workspace', 'accept_invitation'],
      });
    }

    return reply.status(200).send(completeAuth(reply, result));
  });

  app.post('/google/complete', async (request, reply) => {
    const identity = app.verifyOnboardingToken(request.cookies[ONBOARDING_COOKIE]);
    if (!identity) {
      throw new UnauthenticatedError(
        'Your Google sign-in has expired; please start again',
        'ONBOARDING_EXPIRED',
      );
    }

    // The same shape as self-service signup minus the password (FR-1.1 via SSO).
    const input = parseBody(
      registerSchema.omit({ email: true, password: true, fullName: true }),
      request.body,
    );

    const result = await google.completeOnboarding(identity, input, requestContext(request));
    return reply.status(201).send(completeAuth(reply, result));
  });

  /** Small helper the web app calls to decide whether to show the Google button. */
  app.get('/providers', async (_request, reply) => {
    return reply.status(200).send({
      password: true,
      google: google.isConfigured(),
      wallet: env.SIWE_ENABLED,
      googleClientId: google.isConfigured() ? env.GOOGLE_CLIENT_ID : null,
    });
  });
}

export const googleOnboardingSchema = z.object({
  organizationName: z.string().min(2).max(120),
  organizationSlug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
});

export type { OnboardingIdentity };
