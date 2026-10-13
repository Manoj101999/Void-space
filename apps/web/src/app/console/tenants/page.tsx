'use client';

/**
 * Platform tenant administration (SRS FR-14.1, FR-1.5).
 *
 * The SuperAdmin's view of the platform: every workspace, what is inside it, and the one control
 * that matters — suspend or reinstate. Until now the API for this existed (`GET /tenants`,
 * `PATCH /tenants/:id/status`) and no screen used it, so FR-14.1's list was reachable only by
 * curl. A capability with no interface is not a delivered capability.
 *
 * Two things are deliberate:
 *
 *  1. **The guard is `tenant:manage`, not `tenant:manage-users`.** The Team screen next door is a
 *     TenantAdmin's screen — one workspace's members. This one crosses workspaces, which §3.6
 *     grants to SuperAdmin alone.
 *
 *  2. **Suspension asks first, in place.** It revokes every refresh token in the workspace the
 *     moment it lands (FR-2.7), which is not an action to fire from a stray click. The confirm
 *     row appears under the row it belongs to, so the administrator never has to hold a workspace
 *     name in their head across a dialog.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';

import { ApiRequestError, apiFetch } from '../../../lib/api';
import { formatNumber, formatRelative } from '../../../lib/format';
import { Panel } from '../../../components/ui/card';
import { ErrorNote, LoadingBlock } from '../../../components/ui/feedback';
import { RequirePermission } from '../../../components/permission-gate';
import { PageHead, StatCell, StatRow } from '../../../components/console-kit';

interface TenantRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: 'active' | 'suspended';
  readonly createdAt: string;
  readonly userCount?: number;
  readonly assetCount?: number;
  readonly licenseCount?: number;
}

/**
 * Permission check happens above the queries, not after they fail: a role the §3.6 matrix
 * excludes never sends a request this screen would be refused for.
 */
export default function TenantsPage() {
  return (
    <RequirePermission permission="tenant:manage">
      <PlatformTenants />
    </RequirePermission>
  );
}

function PlatformTenants() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);

  const tenants = useQuery<{ tenants: readonly TenantRow[]; total: number }>({
    queryKey: ['tenants'],
    queryFn: () => apiFetch<{ tenants: readonly TenantRow[]; total: number }>('/tenants'),
  });

  async function setStatus(tenant: TenantRow, status: 'active' | 'suspended') {
    setBusy(tenant.id);
    setError(null);
    setConfirming(null);
    try {
      await apiFetch(`/tenants/${tenant.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({
          status,
          reason: status === 'suspended' ? 'Suspended from the platform console' : undefined,
        }),
      });
      // The list carries the counts this row renders, so it is refetched rather than patched:
      // reinstating a workspace changes more than its status string.
      await queryClient.invalidateQueries({ queryKey: ['tenants'] });
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? { message: caught.message, ...(caught.code ? { code: caught.code } : {}) }
          : { message: caught instanceof Error ? caught.message : 'The change was not applied.' },
      );
    } finally {
      setBusy(null);
    }
  }

  if (tenants.isPending) return <LoadingBlock label="Reading workspaces" />;

  if (tenants.isError) {
    return (
      <ErrorNote
        message="The workspace list could not be read"
        hint={tenants.error instanceof Error ? tenants.error.message : undefined}
      />
    );
  }

  const rows = tenants.data.tenants;
  const active = rows.filter((row) => row.status === 'active').length;
  const users = rows.reduce((sum, row) => sum + (row.userCount ?? 0), 0);
  const assets = rows.reduce((sum, row) => sum + (row.assetCount ?? 0), 0);
  const licences = rows.reduce((sum, row) => sum + (row.licenseCount ?? 0), 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHead
        title="Workspaces"
        meta={`${formatNumber(rows.length)} workspace${rows.length === 1 ? '' : 's'} · ${formatNumber(active)} active`}
      />

      <StatRow>
        <StatCell label="Workspaces" value={formatNumber(rows.length)} hint="Across the platform" />
        <StatCell label="Active" value={formatNumber(active)} hint="Not suspended" />
        <StatCell label="People" value={formatNumber(users)} hint="Memberships, not accounts" />
        <StatCell
          label="Assets"
          value={formatNumber(assets)}
          hint={`${formatNumber(licences)} licences issued`}
        />
      </StatRow>

      {error ? <ErrorNote message="That change was not applied" hint={error.message} /> : null}

      <Panel title="All workspaces" right={`${formatNumber(rows.length)} total`}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-hairline text-left font-mono text-[11px] uppercase tracking-[0.1em] text-ink-faint">
                <th className="px-4 py-3 font-normal">Workspace</th>
                <th className="px-4 py-3 font-normal">Status</th>
                <th className="px-4 py-3 text-right font-normal">People</th>
                <th className="px-4 py-3 text-right font-normal">Assets</th>
                <th className="px-4 py-3 text-right font-normal">Licences</th>
                <th className="px-4 py-3 font-normal">Created</th>
                <th className="px-4 py-3 text-right font-normal">Control</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((tenant) => (
                <TenantRows
                  key={tenant.id}
                  tenant={tenant}
                  busy={busy === tenant.id}
                  confirming={confirming === tenant.id}
                  onAsk={() => setConfirming(tenant.id)}
                  onCancel={() => setConfirming(null)}
                  onSetStatus={setStatus}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}


/**
 * One workspace, plus its confirmation row when a suspension is being asked about.
 *
 * A `Fragment` rather than a wrapper element: a second `<tr>` inside a `<td>` would be invalid
 * table markup, and the confirm row has to be a sibling of the row it belongs to.
 */
function TenantRows({
  tenant,
  busy,
  confirming,
  onAsk,
  onCancel,
  onSetStatus,
}: {
  readonly tenant: TenantRow;
  readonly busy: boolean;
  readonly confirming: boolean;
  readonly onAsk: () => void;
  readonly onCancel: () => void;
  readonly onSetStatus: (tenant: TenantRow, status: 'active' | 'suspended') => Promise<void>;
}) {
  const suspended = tenant.status === 'suspended';

  return (
    <Fragment>
      <tr className="border-b border-hairline last:border-b-0">
        <td className="px-4 py-3">
          <div className="text-ink">{tenant.name}</div>
          <div className="font-mono text-[11.5px] text-ink-faint">{tenant.slug}</div>
        </td>
        <td className="px-4 py-3">
          {/* Two spellings of "state", because a suspended workspace is a warning and an active
              one is simply the norm — colouring both would make the page shout. */}
          <span
            className="font-mono text-[11px] uppercase tracking-[0.08em]"
            style={{ color: suspended ? 'var(--vs-review)' : 'var(--vs-published)' }}
          >
            {tenant.status}
          </span>
        </td>
        <td className="px-4 py-3 text-right tabular-nums text-ink-dim">
          {formatNumber(tenant.userCount ?? 0)}
        </td>
        <td className="px-4 py-3 text-right tabular-nums text-ink-dim">
          {formatNumber(tenant.assetCount ?? 0)}
        </td>
        <td className="px-4 py-3 text-right tabular-nums text-ink-dim">
          {formatNumber(tenant.licenseCount ?? 0)}
        </td>
        <td className="px-4 py-3 text-ink-faint">{formatRelative(tenant.createdAt)}</td>
        <td className="px-4 py-3 text-right">
          <button
            type="button"
            disabled={busy}
            onClick={suspended ? () => void onSetStatus(tenant, 'active') : onAsk}
            className="rounded-control border border-hairline px-2.5 py-1 text-[12px] text-ink-dim transition-colors duration-150 ease-standard hover:border-hairline-strong hover:text-ink disabled:opacity-50"
          >
            {busy ? 'Working…' : suspended ? 'Reinstate' : 'Suspend'}
          </button>
        </td>
      </tr>

      {confirming ? (
        <tr className="border-b border-hairline bg-veil-4">
          <td colSpan={7} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[12.5px] text-ink-dim">
                Suspending <b className="text-ink">{tenant.name}</b> signs out every member
                immediately and blocks further API access. Content is kept and the action is
                recorded in the audit log.
              </span>
              <button
                type="button"
                onClick={() => void onSetStatus(tenant, 'suspended')}
                className="rounded-control border border-transparent bg-accent px-3 py-1 text-[12px] font-semibold text-accent-ink"
              >
                Suspend workspace
              </button>
              <button
                type="button"
                onClick={onCancel}
                className="rounded-control px-3 py-1 text-[12px] text-ink-dim hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

