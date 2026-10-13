'use client';

/**
 * Permission gate for console screens (SRS §3.6).
 *
 * The API is the authority: every request is re-checked server-side against the §3.6 matrix, and a
 * role that lacks a permission gets a 403 whatever the UI does. But a screen that mounts its
 * queries first and *then* discovers it is not allowed produces the worst of both worlds — two
 * failed requests per visit, a browser console full of 403s, and a page that renders a broken
 * version of a tool the caller cannot use.
 *
 * So the check happens before the subtree mounts. The gate is keyed on the same permission the API
 * enforces and the navigation uses to decide whether to show the door at all, which keeps one
 * matrix in charge of all three.
 *
 * The refusal is deliberately informative rather than blank: it names the permission, the roles the
 * caller actually holds, and states plainly that nothing was requested — because "why can't I open
 * this?" is the only question the screen needs to answer.
 */
import Link from 'next/link';

import type { Permission } from '@void-space/types';

import { useSession } from '../lib/session';
import { Panel } from './ui/card';
import { LoadingBlock } from './ui/feedback';

/** Human wording for the permissions a whole screen is gated behind. */
const PERMISSION_LABEL: Partial<Record<Permission, string>> = {
  'review:view-queue': 'Review the submission queue',
  'review:decide': 'Approve, reject or request changes',
  'audit:view': 'Read the audit ledger',
  'tenant:manage-users': 'Manage workspace members and roles',
  'catalog:view': 'View the catalogue',
  'asset:upload-own': 'Upload assets',
  'tenant:manage': 'Change workspace settings',
};

export function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  /** Mounted only when the caller holds the permission, so no doomed request is ever sent. */
  children: React.ReactNode;
}) {
  const { can, session, isLoading } = useSession();

  if (can(permission)) return <>{children}</>;

  // Before the session resolves there is nothing to refuse yet. Showing the panel here would make
  // every first paint claim a permission problem, so the gate stays neutral instead.
  if (isLoading || !session) return <LoadingBlock label="Resolving permissions" />;

  return (
    <div className="mx-auto max-w-2xl">
      <Panel
        title="Access refused"
        right={<span className="font-mono text-[12px] text-ink-dim">§3.6 · permission matrix</span>}
      >
        <div className="px-5 py-6">
          <h2 className="font-medium leading-[1.1] tracking-[-0.021em] text-ink text-2xl">
            This screen is not open to {session.user.roles.join(' / ') || 'this role'}.
          </h2>

          <p className="mt-4 max-w-[62ch] text-[13.5px] leading-relaxed" style={{ color: 'var(--vs-fg-dim)' }}>
            Opening it needs <strong style={{ color: 'var(--fc-fg)' }}>
              {PERMISSION_LABEL[permission] ?? permission}
            </strong>{' '}
            (<code className="font-mono text-[12px] text-ink-dim">{permission}</code>), which the §3.6 permission matrix does not
            grant to {session.user.roles.length > 1 ? 'any of your roles' : 'your role'} in{' '}
            {session.tenant.name}.
          </p>

          <p className="mt-3 text-[13px] leading-relaxed" style={{ color: 'var(--vs-fg-faint)' }}>
            Nothing was requested — the check ran before this page loaded, so the API was never asked
            for data you cannot read.
          </p>

          <div className="mt-6 flex flex-wrap gap-2">
            <Link href="/console" className="inline-flex h-10 items-center justify-center gap-2 rounded-control border px-4 text-[14px] font-semibold transition-all duration-200 ease-standard border-brand bg-brand text-white shadow-heat hover:border-brand-warm hover:bg-brand-warm">
              Back to overview
            </Link>
            <Link href="/console/notifications" className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12">
              Your notifications
            </Link>
          </div>

          <div
            className="text-[12px] tracking-[0.01em] text-ink-faint mt-6 border-t pt-4 leading-relaxed"
            style={{ borderColor: 'var(--vs-line)' }}
          >
            Ask a workspace administrator if you need this access. The request has to come from them,
            in this workspace, because roles are per-workspace and a change takes effect on your next
            request.
          </div>
        </div>
      </Panel>
    </div>
  );
}
