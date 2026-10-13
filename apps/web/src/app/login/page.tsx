/**
 * Sign-in route (server component).
 *
 * Two decisions live here, both of which belong on the server:
 *
 *  1. **Already signed in?** Then there is nothing to ask for. This used to be a client-side
 *     `useEffect` that called `/auth/me` and redirected after paint, which flashed the form at
 *     people who were already authenticated.
 *  2. **Where to land afterwards** (`?next=`). Validated by `safeNextPath` before it ever reaches
 *     the form, so a crafted link cannot turn sign-in into an open redirect.
 *
 * The form itself stays a client component: it owns input state and posts credentials.
 */
import { redirect } from 'next/navigation';

import { getServerSession, safeNextPath } from '../../lib/server-session';
import { LoginForm } from './login-form';

export const metadata = {
  title: 'Sign in — VOID·SPACE',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const next = safeNextPath(searchParams.next);
  const { session } = await getServerSession();

  if (session) redirect(next);

  return <LoginForm next={next} />;
}
