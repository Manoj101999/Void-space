'use client';

/**
 * Tenant administration (SRS FR-1.2, FR-1.3, §3.6). Members, roles and workspace policy.
 *
 * The member list is a marketplace's "holders" table: an avatar, a name, the roles that person
 * holds, and the one control an administrator actually needs — the role selector, inline. A modal
 * per member edit would be three clicks where one is enough.
 *
 * The error and confirmation lines are plain, in the page, rather than toasts. A role change is
 * consequential and an administrator may be several rows past it by the time it lands; a message
 * that has already faded is worse than no message.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ROLES, type Role } from '@void-space/types';

import { ApiRequestError, apiFetch } from '../../../lib/api';
import { formatNumber, formatRelative } from '../../../lib/format';
import { Panel } from '../../../components/ui/card';
import { ErrorNote, LoadingBlock } from '../../../components/ui/feedback';
import { RequirePermission } from '../../../components/permission-gate';
import {
  EventChip,
  PageHead,
  PersonCell,
  StatCell,
  StatRow,
} from '../../../components/console-kit';

interface Member {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly roles: readonly Role[];
  readonly status: 'invited' | 'active' | 'suspended';
  readonly lastLoginAt: string | null;
}

interface TenantDetail {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: 'active' | 'suspended';
  readonly createdAt: string;
  readonly settings: {
    readonly defaultPolycountBudget: number | null;
    readonly requiredMetadataFields: readonly string[];
    readonly allowedCategories: readonly string[];
    readonly webhookUrl: string | null;
    readonly webhookEvents: readonly string[];
  };
  readonly counts: { users: number; assets: number; licenses: number; pendingReview: number };
}

/**
 * Permission check happens here, above the queries, not after they fail: a role the §3.6 matrix
 * excludes never sends a request this screen would be refused for.
 */
export default function AdminPage() {
  return (
    <RequirePermission permission="tenant:manage-users">
      <TeamAdministration />
    </RequirePermission>
  );
}

function TeamAdministration() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);

  const tenant = useQuery<TenantDetail>({
    queryKey: ['tenant'],
    queryFn: () => apiFetch<{ tenant: TenantDetail }>('/tenant').then((r) => r.tenant),
  });

  const members = useQuery<{ users: readonly Member[] }>({
    queryKey: ['users'],
    queryFn: () => apiFetch<{ users: readonly Member[] }>('/users'),
  });

  const invites = useQuery<{
    invites: readonly {
      id: string;
      email: string;
      role: Role;
      expiresAt: string;
      acceptedAt: string | null;
    }[];
  }>({
    queryKey: ['invites'],
    queryFn: () =>
      apiFetch<{
        invites: readonly {
          id: string;
          email: string;
          role: Role;
          expiresAt: string;
          acceptedAt: string | null;
        }[];
      }>('/users/invites'),
  });

  async function mutate(label: string, path: string, body: unknown) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetch<{ invite?: { token: string; email: string } }>(path, {
        method: 'PATCH',
        body,
      });
      setNotice(result.invite ? `Invitation token: ${result.invite.token}` : `${label} applied`);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      await queryClient.invalidateQueries({ queryKey: ['invites'] });
    } catch (caught) {
      const apiError = caught as ApiRequestError;
      setError({ message: apiError.message, code: apiError.code });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-7">
      <PageHead
        title="Administration"
        meta={
          tenant.data
            ? `${tenant.data.name} · ${tenant.data.slug} · roles follow the §3.6 permission matrix`
            : 'Querying'
        }
      />

      {error ? <ErrorNote message={error.message} code={error.code} /> : null}
      {notice ? (
        <div className="relative overflow-hidden rounded-card border border-hairline bg-surface shadow-panel flex items-center gap-3 px-5 py-3.5" role="status">
          <span className="inline-block h-3.5 w-3.5 shrink-0 rounded-[3px]" aria-hidden />
          <span className="font-mono text-[12px] text-ink-dim break-all">{notice}</span>
        </div>
      ) : null}

      <StatRow>
        <StatCell label="Members" value={formatNumber(tenant.data?.counts.users ?? 0)} />
        <StatCell label="Assets" value={formatNumber(tenant.data?.counts.assets ?? 0)} />
        <StatCell label="Licences" value={formatNumber(tenant.data?.counts.licenses ?? 0)} />
        <StatCell
          label="Awaiting review"
          value={formatNumber(tenant.data?.counts.pendingReview ?? 0)}
          tone={(tenant.data?.counts.pendingReview ?? 0) > 0 ? 'heat' : 'plain'}
        />
      </StatRow>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <Panel title="Members" right={members.data ? `${members.data.users.length} records` : undefined}>
          {members.isLoading ? <LoadingBlock label="Loading members" /> : null}
          {members.error ? <ErrorNote message={(members.error as Error).message} /> : null}

          {members.data ? (
            <div className="overflow-x-auto">
              <table className="vs-table">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th className="text-right">Last seen</th>
                    <th className="text-right">Set role</th>
                  </tr>
                </thead>
                <tbody>
                  {members.data.users.map((member) => (
                    <tr key={member.id}>
                      <td>
                        <PersonCell name={member.fullName} sub={member.email} />
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {member.roles.map((role) => (
                            <span key={role} className="chip">
                              {role}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <EventChip
                          action={
                            member.status === 'active'
                              ? 'tenant.member_active'
                              : member.status === 'invited'
                                ? 'tenant.user_invited'
                                : 'tenant.member_suspended'
                          }
                        />
                      </td>
                      <td className="font-mono text-[12px] text-ink-dim whitespace-nowrap text-right">
                        {formatRelative(member.lastLoginAt)}
                      </td>
                      <td className="text-right">
                        <label className="w-auto">
                          <span className="sr-only">{`Set the role for ${member.fullName}`}</span>
                          <select
                            value={member.roles[0] ?? ''}
                            disabled={busy !== null}
                            aria-label={`Set the role for ${member.fullName}`}
                            onChange={(event) =>
                              void mutate('Role change', `/users/${member.id}`, {
                                role: event.target.value,
                              })
                            }
                          >
                            {ROLES.map((role) => (
                              <option key={role} value={role}>
                                {role}
                              </option>
                            ))}
                          </select>
                        </label>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Panel>



        <div className="space-y-5">
          <Panel title="Workspace policy" right="FR-14.3">
            {tenant.data ? (
              <dl className="px-5 py-2">
                {[
                  {
                    key: 'Polycount budget',
                    value: formatNumber(tenant.data.settings.defaultPolycountBudget),
                  },
                  {
                    key: 'Required metadata',
                    value: tenant.data.settings.requiredMetadataFields.join(', ') || 'None',
                  },
                  {
                    key: 'Allowed categories',
                    value: tenant.data.settings.allowedCategories.join(' / ') || 'Any',
                  },
                  { key: 'Webhook', value: tenant.data.settings.webhookUrl ?? 'Not configured' },
                  { key: 'Status', value: tenant.data.status },
                ].map((row) => (
                  <div className="vs-spec-row" key={row.key}>
                    <span className="vs-spec-key">{row.key}</span>
                    <span className="vs-spec-value break-words">{row.value}</span>
                  </div>
                ))}
              </dl>
            ) : (
              <LoadingBlock label="Loading policy" />
            )}
          </Panel>

          <Panel
            title="Invitations"
            right={invites.data ? `${invites.data.invites.length} on record` : undefined}
          >
            {invites.data && invites.data.invites.length > 0 ? (
              <table className="vs-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th className="text-right">State</th>
                  </tr>
                </thead>
                <tbody>
                  {invites.data.invites.map((invite) => (
                    <tr key={invite.id}>
                      <td className="truncate">{invite.email}</td>
                      <td>
                        <span className="chip">{invite.role}</span>
                      </td>
                      <td className="font-mono text-[12px] text-ink-dim whitespace-nowrap text-right">
                        {invite.acceptedAt ? 'Accepted' : `Expires ${formatRelative(invite.expiresAt)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="px-5 py-6 text-[13.5px]" style={{ color: 'var(--vs-fg-faint)' }}>
                No invitations outstanding.
              </div>
            )}
          </Panel>

          <Panel title="Developer surface" right="FR-12.3">
            <div
              className="px-5 py-5 text-[13.5px] leading-relaxed"
              style={{ color: 'var(--vs-fg-dim)' }}
            >
              API keys are issued per user under the Developer role. The raw value is shown once at
              creation and only a scrypt hash is stored, so a key that is lost has to be replaced
              rather than recovered. A key carries the same permissions as the person who owns it,
              and revoking it does not touch that person’s session.
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
