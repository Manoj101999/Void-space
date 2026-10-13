/**
 * Authentication cookie handling (SRS FR-2.3, §2.5 constraint).
 *
 *   "Authentication tokens (JWT) MUST be short-lived (access token ≤ 15 minutes)
 *    with a rotating refresh token, and MUST be delivered only via httpOnly,
 *    Secure, SameSite=Lax cookies — never persisted in browser local/session
 *    storage."
 *
 * Both cookies are therefore httpOnly + Secure + SameSite=Lax and scoped to the
 * narrowest useful path: the refresh cookie is only ever sent to the auth
 * endpoints, so it never travels with ordinary API traffic.
 */
import type { FastifyReply } from 'fastify';

export const ACCESS_COOKIE = 'vs_access';
export const REFRESH_COOKIE = 'vs_refresh';
/** Short-lived proof-of-identity used by the SSO onboarding step (FR-2.2). */
export const ONBOARDING_COOKIE = 'vs_onboarding';
/** Anti-CSRF state for the Google OAuth redirect. */
export const OAUTH_STATE_COOKIE = 'vs_oauth_state';

export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export interface CookieOptions {
  readonly secure: boolean;
  readonly sameSite: 'lax' | 'strict';
  readonly maxAgeSeconds: number;
  readonly path?: string;
}

function baseOptions(options: CookieOptions): Record<string, unknown> {
  return {
    httpOnly: true,
    secure: options.secure,
    sameSite: options.sameSite,
    path: options.path ?? '/',
    maxAge: options.maxAgeSeconds,
  };
}

export function setAccessCookie(
  reply: FastifyReply,
  token: string,
  options: CookieOptions,
): void {
  reply.setCookie(ACCESS_COOKIE, token, baseOptions(options));
}

export function setRefreshCookie(
  reply: FastifyReply,
  token: string,
  options: CookieOptions,
): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    ...baseOptions(options),
    path: REFRESH_COOKIE_PATH,
  });
}

export function setOnboardingCookie(
  reply: FastifyReply,
  token: string,
  options: CookieOptions,
): void {
  reply.setCookie(ONBOARDING_COOKIE, token, {
    ...baseOptions(options),
    path: '/api/v1/auth',
  });
}

export function clearAuthCookies(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(ACCESS_COOKIE, { path: '/', secure, httpOnly: true, sameSite: 'lax' });
  reply.clearCookie(REFRESH_COOKIE, {
    path: REFRESH_COOKIE_PATH,
    secure,
    httpOnly: true,
    sameSite: 'lax',
  });
}

export function clearOnboardingCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(ONBOARDING_COOKIE, {
    path: '/api/v1/auth',
    secure,
    httpOnly: true,
    sameSite: 'lax',
  });
}

/**
 * Secure cookies are the default because FR-2.3 requires them; the escape hatch
 * exists only for a developer deliberately browsing the plain-http origin
 * (`COOKIE_SECURE=false` in .env).
 */
export function cookieSecurity(env: { COOKIE_SECURE?: boolean }): boolean {
  return env.COOKIE_SECURE ?? true;
}
