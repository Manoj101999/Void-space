/**
 * Console layout — the authentication gate (SRS §6.1, FR-2.1).
 *
 * Every screen behind this layout is authenticated, so the check happens here, on the server, before
 * anything is rendered.
 *
 * An earlier version gated in the browser: an anonymous visitor got a full page whose only content
 * was "Checking your session", and the redirect only happened once JavaScript had booted, fetched
 * `/auth/me`, received a 401 and called `router.replace`. To anyone with a slow connection, a
 * blocked script, or a view-source that was not a browser at all, the console simply appeared to
 * hang on the word "session" — and console HTML was served to callers with no cookie at all.
 *
 * Now:
 *   - no session cookie        → 307 to `/login?next=<intended>`, carrying the destination;
 *   - cookie, `/auth/me` OK    → the session is passed down so the first paint is already complete;
 *   - cookie, `/auth/me` 401   → the access token expired. Only a browser can rotate the refresh
 *                                cookie (FR-2.3), so the shell renders and the client exchanges it.
 *                                Fifteen-minute token expiry no longer costs anyone a sign-in.
 */
import { redirect } from 'next/navigation';

import { AppShell } from '../../components/app-shell';
import { getServerSession, intendedPath } from '../../lib/server-session';

// Rendered per request: it reads cookies and the caller's session.
export const dynamic = 'force-dynamic';

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const { session, hasSessionCookie } = await getServerSession();

  if (!hasSessionCookie) {
    redirect(`/login?next=${encodeURIComponent(intendedPath())}`);
  }

  return <AppShell initialSession={session}>{children}</AppShell>;
}

