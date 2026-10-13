/**
 * Server-side session gate (SRS §6.1).
 *
 * Why this exists: the console used to be gated in the browser. An anonymous visitor received a
 * fully rendered page whose only content was "Checking your session", and the actual redirect
 * happened later, in JavaScript, after `/auth/me` returned 401. That meant:
 *
 *   - a visible hang whenever JS was slow or blocked, and a permanent one if it never arrived;
 *   - a crawler, a screenshot tool or a raw `curl` seeing a page that says "Checking your session";
 *   - the console HTML being served at all to a caller with no cookie.
 *
 * Deciding here, on the server, turns that into an ordinary 307 to the sign-in screen with the
 * intended destination preserved.
 *
 * The distinction that matters is **no cookie** versus **stale cookie**:
 *
 *   - No `vs_access` cookie at all → definitely signed out → redirect immediately.
 *   - Cookie present but `/auth/me` returns 401 → the access token has merely expired, and only a
 *     browser can rotate the refresh cookie (FR-2.3). So we hand over to the client, which
 *     exchanges it silently; a genuinely dead session still ends at `/login`, but fifteen-minute
 *     token expiry no longer does.
 */
import { cookies, headers } from 'next/headers';

import { API_INTERNAL_URL, apiFetch } from './api';
import { ACCESS_COOKIE } from './cookies';
import type { SessionView } from './session-types';

export interface ServerSession {
  /** Present when the access token was still valid for this request. */
  readonly session: SessionView | null;
  /** Whether any session cookie was sent — drives redirect vs. client-side recovery. */
  readonly hasSessionCookie: boolean;
}

/** Reads the caller's session on the server. Never throws. */
export async function getServerSession(): Promise<ServerSession> {
  const cookieHeader = cookies().toString();
  const hasSessionCookie = cookies().get(ACCESS_COOKIE) !== undefined;

  if (!hasSessionCookie) return { session: null, hasSessionCookie: false };

  try {
    const session = await apiFetch<SessionView>('/auth/me', {
      baseUrl: `${API_INTERNAL_URL}/api/v1`,
      cookieHeader,
    });
    return { session, hasSessionCookie: true };
  } catch {
    // 401 (expired), 5xx (API still starting) or a network error all land here. The client decides;
    // a failed pre-flight must not itself log anybody out.
    return { session: null, hasSessionCookie: true };
  }
}

/**
 * The path the caller was trying to reach, so sign-in can return them there.
 *
 * Server components do not receive the pathname, and injecting it needs middleware on every
 * request. In practice `Referer` already carries it for in-app navigation — the console is only
 * ever entered by clicking a link inside the app — so this reads that and falls back to `/console`.
 */
export function intendedPath(): string {
  const referer = headers().get('referer');
  if (referer) {
    try {
      const url = new URL(referer);
      const path = `${url.pathname}${url.search}`;
      // Only same-origin, non-auth destinations: an open redirect is not worth the convenience.
      if (path.startsWith('/') && !path.startsWith('/login')) return path;
    } catch {
      // Malformed referer — fall through to the default.
    }
  }
  return '/console';
}

/**
 * Rejects a `?next=` value that could send a freshly authenticated user somewhere off-site.
 * Allows only absolute paths within this application.
 */
export function safeNextPath(value: string | string[] | undefined, fallback = '/console'): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate) return fallback;
  if (!candidate.startsWith('/')) return fallback;
  // `//evil.com` is protocol-relative and therefore off-site.
  if (candidate.startsWith('//')) return fallback;
  if (candidate.startsWith('/login')) return fallback;
  return candidate;
}
