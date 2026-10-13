'use client';

/**
 * Application shell (SRS §6.1).
 *
 * The layout is a marketplace's, because the work is: a sticky top bar with the workspace search,
 * the chain readout and the account; a row of section tabs under it; then the screen's own banner,
 * filters and grid. What an operator does all day in this product — find an asset, decide on it,
 * trace what happened to it — maps onto that shape directly, and it is the shape the audience
 * already reads fluently.
 *
 * Two rows rather than one. OpenSea fits its whole nav and its search into a single bar; with seven
 * destinations, a search field and three controls, one row would either crush the search or hide
 * half the destinations behind a chevron. The tabs get their own row, exactly as a collection page's
 * Items / Activity / Offers tabs do.
 *
 * Navigation is filtered by the §3.6 permission matrix, so a role never sees a door it cannot open.
 * That is courtesy, not security: every endpoint re-checks the caller independently.
 */
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Suspense, useId, useEffect, useState } from 'react';
import type { Permission } from '@void-space/types';

import { apiFetch } from '../lib/api';
import { cn } from '../lib/cn';
import { SessionProvider, useSession } from '../lib/session';
import type { SessionView } from '../lib/session-types';
import { Avatar } from './ui/avatar';
import { Chip } from './ui/chip';
import { CubeIcon } from './ui/icons';
import { BellIcon, SearchIcon } from './console-kit';
import { ErrorNote } from './ui/feedback';

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly permission: Permission;
}

const NAV: readonly NavItem[] = [
  { href: '/console', label: 'Overview', permission: 'catalog:view' },
  { href: '/console/library', label: 'Library', permission: 'asset:upload-own' },
  { href: '/console/review', label: 'Review', permission: 'review:view-queue' },
  { href: '/console/catalog', label: 'Marketplace', permission: 'catalog:view' },
  { href: '/console/licenses', label: 'Licences', permission: 'catalog:view' },
  { href: '/console/audit', label: 'Audit', permission: 'audit:view' },
  { href: '/console/admin', label: 'Team', permission: 'tenant:manage-users' },
  // FR-14.1 — the SuperAdmin's cross-workspace view. Separate from Team, which is a single
  // workspace's members: one screen is the tenant, the other is the platform.
  { href: '/console/tenants', label: 'Workspaces', permission: 'tenant:manage' },
];

/**
 * The wordmark.
 *
 * The cube and the type together — the same mark as the storefront, from the same component, so a
 * visitor moving between the catalogue and the console is visibly in one product. It used to be two
 * different marks: an ASCII drawing on the storefront and a bare word here.
 */
export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <CubeIcon className="text-brand" width={compact ? 17 : 20} height={compact ? 17 : 20} strokeWidth={1.3} />
      <span
        className={cn(
          'font-semibold tracking-[-0.02em] text-ink',
          compact ? 'text-[14px]' : 'text-[15px]',
        )}
      >
        VOID·SPACE
      </span>
    </span>
  );
}

/**
 * First frame of the application.
 *
 * Calm by design: a signed-out visitor is a normal visitor, not an error (this screen replaces the
 * fault panel that used to flash "SESSION REFUSED … REDIRECTING" on every signed-out visit).
 */
function HoldingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-base">
      <div className="flex flex-col items-center gap-5">
        <Wordmark />
        <div
          aria-hidden
          className="h-0.5 w-16 animate-dot-pulse rounded-full bg-brand"
        />
        <p className="text-[12.5px] text-ink-faint">Checking your session</p>
      </div>
    </div>
  );
}

function NotificationBell() {
  const { data } = useQuery<{ unreadCount: number }>({
    queryKey: ['notifications', 'count'],
    queryFn: () => apiFetch<{ unreadCount: number }>('/notifications/count'),
    refetchInterval: 20_000,
    retry: false,
  });

  const count = data?.unreadCount ?? 0;

  return (
    <Link
      href="/console/notifications"
      aria-label={count > 0 ? `${count} unread notifications` : 'Notifications'}
      title="Notifications"
      className="relative inline-flex h-9 w-9 items-center justify-center rounded-control border border-hairline bg-surface text-ink-dim transition-colors duration-150 ease-standard hover:border-hairline-strong hover:bg-surface-raised hover:text-ink"
    >
      <BellIcon />
      {count > 0 ? (
        <span className="absolute -right-1 -top-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-base bg-brand px-1 font-mono text-[10px] text-white">
          {count > 9 ? '9+' : count}
        </span>
      ) : null}
    </Link>
  );
}


/**
 * The workspace search.
 *
 * It is a real form: pressing Enter navigates to the library with the query in the URL, so the
 * search is shareable, bookmarkable and works with the back button. A search box that silently
 * filters a page you are not on is the most common decorative control in a dashboard.
 *
 * The URL is the single source of truth, and this box mirrors it back: the library reads `?q=` as
 * its initial query, refines it from its own toolbar and clears everything from its "All" button —
 * so without the mirror a top bar still reading "pump" over an unfiltered library would be one
 * search pretending to be two that agree. Only *committed* queries move the URL, so text typed but
 * not yet submitted is left alone.
 */
function WorkspaceSearch() {
  const router = useRouter();
  const inputId = useId();
  const searchParams = useSearchParams();
  const urlQuery = searchParams.get('q') ?? '';
  const [value, setValue] = useState(urlQuery);

  useEffect(() => {
    setValue(urlQuery);
  }, [urlQuery]);

  return (
    <form
      role="search"
      className="relative flex h-10 items-center"
      onSubmit={(event) => {
        event.preventDefault();
        const query = value.trim();
        router.push(query.length > 0 ? `/console/library?q=${encodeURIComponent(query)}` : '/console/library');
      }}
    >
      <span className="pointer-events-none absolute left-3.5 text-ink-faint">
        <SearchIcon />
      </span>
      <label className="sr-only" htmlFor={inputId}>
        Search assets by name or tag
      </label>
      <input
        id={inputId}
        type="search"
        value={value}
        placeholder="Search assets by name or tag"
        onChange={(event) => setValue(event.target.value)}
        className="h-10 w-full rounded-control border border-hairline bg-surface pl-10 pr-3.5 text-[14px] text-ink transition-colors duration-150 ease-standard placeholder:text-ink-faint hover:border-hairline-strong focus:border-brand focus:outline-none"
      />
    </form>
  );
}

function WorkspaceSwitcher() {
  const { session, memberships, switchTenant } = useSession();
  const [busy, setBusy] = useState(false);

  if (!session) return null;

  // One workspace means nothing to switch between, so the control stays a readout.
  if (memberships.length <= 1) {
    return (
      <span
        className="inline-flex items-center gap-2 rounded-full border border-hairline-strong bg-surface px-3 py-1.5 font-mono text-[12px] text-ink-dim"
        title={`Workspace: ${session.tenant.name}`}
      >
        <span aria-hidden className="h-1.5 w-1.5 animate-dot-pulse rounded-full bg-state-published" />
        {session.tenant.name}
      </span>
    );
  }

  return (
    <select
      value={session.tenant.id}
      disabled={busy}
      aria-label="Switch workspace"
      onChange={async (event) => {
        setBusy(true);
        try {
          await switchTenant(event.target.value);
        } finally {
          setBusy(false);
        }
      }}
      className={cn(
        'h-9 w-auto min-w-[150px] cursor-pointer appearance-none rounded-control border border-hairline bg-surface pl-3 pr-9 text-[13px] text-ink',
      )}
    >
      {memberships.map((membership) => (
        <option key={membership.id} value={membership.id}>
          {membership.name}
        </option>
      ))}
    </select>
  );
}

/**
 * Avatar + account menu. Keeps sign-out out of the primary navigation.
 *
 * `tenants.length > 1` decides whether the switcher is offered at all, which is why the account
 * menu also carries the workspace list as a fallback on narrow screens where the switcher is hidden.
 */
function AccountMenu() {
  const { session, signOut } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  if (!session) return null;

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-2.5 rounded-full border border-hairline bg-surface py-1 pl-1 pr-3 text-ink transition-colors duration-150 ease-standard hover:border-hairline-strong"
      >
        <Avatar name={session.user.fullName} size="sm" />
        <span className="hidden text-[13px] font-semibold sm:inline">{session.user.fullName}</span>
      </button>

      {open ? (
        <>
          {/* Click-away layer: closes the menu without stealing focus from the page. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="menu"
            className="absolute right-0 top-[calc(100%_+_8px)] z-50 w-64 overflow-hidden rounded-card border border-hairline bg-surface shadow-float"
          >
            <div className="border-b border-hairline px-4 py-4">
              <div className="text-[14px] font-semibold text-ink">{session.user.fullName}</div>
              <div className="mt-0.5 truncate font-mono text-[11.5px] text-ink-faint">
                {session.user.email}
              </div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {session.user.roles.map((role) => (
                  <Chip key={role}>{role}</Chip>
                ))}
              </div>
              {session.readOnly ? (
                <div className="mt-2.5 text-[12px] leading-snug text-ink-faint">
                  Read-only session — write actions are refused by the API, not hidden here.
                </div>
              ) : null}
            </div>

            <div className="py-1.5">
              {[
                { href: '/console/notifications', label: 'Notifications' },
                { href: '/catalog', label: 'Public catalogue' },
              ].map((entry) => (
                <Link
                  key={entry.href}
                  href={entry.href}
                  onClick={() => setOpen(false)}
                  className="block px-4 py-2 text-[13.5px] text-ink-dim transition-colors duration-150 ease-standard hover:bg-veil-6 hover:text-ink"
                >
                  {entry.label}
                </Link>
              ))}
              <a
                href="/api/v1/docs"
                target="_blank"
                rel="noreferrer"
                className="block px-4 py-2 text-[13.5px] text-ink-dim transition-colors duration-150 ease-standard hover:bg-veil-6 hover:text-ink"
              >
                API reference
              </a>
            </div>

            <div className="border-t border-hairline py-1.5">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  void signOut().then(() => router.replace('/login'));
                }}
                className="block w-full px-4 py-2 text-left text-[13.5px] text-state-rejected transition-colors duration-150 ease-standard hover:bg-veil-6"
              >
                Sign out
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}


/**
 * The two rows of navigation.
 *
 * The tabs are links, not tabs in the ARIA sense: each is a route, and the browser's own history is
 * what moves between them. `aria-current="page"` is the correct signal for that, and a
 * `role="tablist"` here would tell a screen reader to expect arrow-key navigation that does not
 * exist.
 */
function Header() {
  const pathname = usePathname();
  const { can } = useSession();
  const visible = NAV.filter((item) => can(item.permission));

  return (
    <header className="sticky top-0 z-50 border-b border-hairline bg-[rgba(10,10,10,0.94)] backdrop-blur-xl backdrop-saturate-150">
      <div className="mx-auto flex h-16 w-full max-w-[1560px] items-center gap-4 px-6">
        <Link href="/console" className="shrink-0" aria-label="VOID·SPACE console home">
          <Wordmark compact />
        </Link>

        <div className="min-w-0 flex-1 lg:hidden">
          {/* `useSearchParams` (the `?q=` mirror) wants a Suspense boundary while the route is
              prepared — the same convention as the library screen. */}
          <Suspense fallback={null}>
            <WorkspaceSearch />
          </Suspense>
        </div>

        <div className="mx-auto hidden w-full max-w-[520px] lg:block">
          <Suspense fallback={null}>
            <WorkspaceSearch />
          </Suspense>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="hidden xl:inline-flex">
            <WorkspaceSwitcher />
          </span>
          <NotificationBell />
          <AccountMenu />
        </div>
      </div>

      <nav aria-label="Sections" className="border-t border-hairline">
        <div className="mx-auto flex w-full max-w-[1560px] gap-1 overflow-x-auto px-6">
          {visible.map((item) => {
            const active =
              pathname === item.href ||
              (item.href !== '/console' && pathname.startsWith(`${item.href}/`));

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  // The active marker is a 2px bar on the leading edge, not a filled pill: a nav that
                  // shouts makes every screen look like a notification.
                  'relative whitespace-nowrap px-3.5 py-3 text-[13.5px] transition-colors duration-150 ease-standard',
                  active ? 'font-semibold text-ink' : 'text-ink-dim hover:text-ink',
                )}
              >
                {item.label}
                {active ? (
                  <span aria-hidden className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-brand" />
                ) : null}
              </Link>
            );
          })}
        </div>
      </nav>
    </header>
  );
}


/**
 * The frame around every authenticated screen.
 *
 * The main column is capped at 1560px rather than the storefront's 1200: an operator reading a
 * table of forty audit rows wants the width, and the storefront's measure is about reading prose.
 */
function Shell({ children }: { children: React.ReactNode }) {
  const { session, isLoading, error } = useSession();
  const status = (error as { status?: number } | null)?.status;

  // 401 is not a fault, it is "not signed in": the provider has already asked the router to show the
  // sign-in screen. Rendering a fault panel here meant every signed-out visit flashed
  // "SESSION REFUSED … REDIRECTING" before the redirect landed.
  if (isLoading || status === 401) return <HoldingScreen />;

  if (!session) {
    return (
      <div className="mx-auto max-w-lg px-6 py-20">
        <ErrorNote
          message={status ? `The session check failed with HTTP ${status}.` : 'No session was returned.'}
          code="SESSION_UNAVAILABLE"
          hint="The API may still be starting — retry in a moment, or sign in again."
        />
        <a className="h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12 mt-4 inline-flex" href="/login">
          Go to sign in
        </a>
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-base">
      <Header />

      <main id="main" className="mx-auto w-full max-w-[1560px] flex-1 px-6 py-8">
        {children}
      </main>

      <footer className="border-t border-hairline">
        <div className="mx-auto flex w-full max-w-[1560px] flex-wrap items-center justify-between gap-3 px-6 py-5 font-mono text-[11.5px] text-ink-faint">
          <span>VOID·SPACE · 3D asset lifecycle · ERC-721 licence registry</span>
          <span>
            {session.tenant.name} · {session.user.roles.join(' / ')}
          </span>
        </div>
      </footer>
    </div>
  );
}

export function AppShell({
  children,
  initialSession,
}: {
  children: React.ReactNode;
  /** Validated on the server by the console layout, so the first paint is already complete. */
  initialSession?: SessionView | null;
}) {
  return (
    <SessionProvider initialSession={initialSession}>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}

