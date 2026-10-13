'use client';

/**
 * Session context (SRS §6.1).
 *
 * The UI shell needs the caller's workspace, roles and permissions on every page, and the API is the
 * only authority for them (`GET /auth/me`). Roles and permissions are re-read server-side on every
 * request, so the client never caches them beyond the query's stale window — a demotion shows up as
 * a 403 and a re-render, not as a stale menu.
 *
 * `initialSession` arrives from the console layout, which has already validated the session on the
 * server. Seeding the query with it means the first paint is complete: no spinner, no second
 * round-trip, and no window in which the shell knows less than the server did.
 */
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect } from 'react';

import type { Permission, Role } from '@void-space/types';

import { apiFetch, refreshSession } from './api';
import type { Membership, SessionTenant, SessionView } from './session-types';

export type { Membership, SessionTenant, SessionView };

interface LoginResult {
  readonly user?: {
    readonly email: string;
    readonly activeTenantId: string;
    readonly tenants: readonly Membership[];
  };
  readonly requiresTenantSelection?: boolean;
  readonly tenants?: readonly Membership[];
}

interface SessionContextValue {
  readonly session: SessionView | undefined;
  readonly memberships: readonly Membership[];
  readonly isLoading: boolean;
  readonly error: unknown;
  can(permission: Permission): boolean;
  hasRole(role: Role): boolean;
  signOut(): Promise<void>;
  switchTenant(tenantId: string): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Memberships are read straight from `/auth/me` (FR-1.4) — they used to live only in module memory,
 * which meant the workspace switcher emptied itself on every page reload. The module variable now
 * covers just the seconds between a switch and the refetch that confirms it.
 */
let optimisticMemberships: readonly Membership[] | null = null;

export function SessionProvider({
  children,
  initialSession,
}: {
  children: React.ReactNode;
  initialSession?: SessionView | null;
}) {
  const router = useRouter();

  const query = useQuery<SessionView>({
    queryKey: ['session'],
    queryFn: () => apiFetch<SessionView>('/auth/me'),
    retry: false,
    ...(initialSession ? { initialData: initialSession } : {}),
  });

  /**
   * An unauthenticated visitor is sent to the sign-in screen rather than shown a broken shell.
   *
   * This is the *expired token* path only — a visitor with no cookie never reaches this component,
   * because the server layout has already redirected them. Retrying once through the refresh cookie
   * first is what keeps a fifteen-minute access token from ending the session (FR-2.3); if the
   * refresh also fails, the session really is over.
   */
  useEffect(() => {
    const status = (query.error as { status?: number } | null)?.status;
    if (status !== 401) return;

    let cancelled = false;
    void refreshSession().then((refreshed) => {
      if (cancelled) return;
      if (refreshed) void query.refetch();
      else router.replace('/login?next=%2Fconsole');
    });

    return () => {
      cancelled = true;
    };
  }, [query, router]);

  const memberships = optimisticMemberships ?? query.data?.user.tenants ?? [];

  const value: SessionContextValue = {
    session: query.data,
    memberships,
    isLoading: query.isLoading,
    error: query.error,
    can: (permission) => query.data?.user.permissions.includes(permission) ?? false,
    hasRole: (role) => query.data?.user.roles.includes(role) ?? false,
    async signOut() {
      await apiFetch('/auth/logout', { method: 'POST', skipRefresh: true });
      optimisticMemberships = null;
      router.replace('/login');
    },
    async switchTenant(tenantId) {
      const result = await apiFetch<LoginResult>('/auth/tenant', {
        method: 'POST',
        body: { tenantId },
      });
      if (result.user?.tenants) optimisticMemberships = result.user.tenants;
      await query.refetch();
      optimisticMemberships = null;
    },
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Remembers the workspace list a login returned, so the switcher can render immediately. */
export function rememberMemberships(memberships: readonly Membership[]): void {
  optimisticMemberships = memberships;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside <SessionProvider>');
  return context;
}

