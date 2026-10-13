'use client';

/**
 * Audit ledger (SRS FR-13.1–FR-13.3). Append-only; the API has no write path for it.
 *
 * The event column is the interesting one. A ledger row's action name is a stable identifier
 * (`asset.publish_requested`), not a sentence, so it is translated for reading *and* coloured by
 * family — a failed mint and a completed one should not look identical at a glance when you are
 * scanning for the one that went wrong.
 *
 * The page states its own immutability rather than relying on the reader to know it: write access is
 * revoked at the database level, which is a different guarantee from "the application offers no edit
 * button", and that difference is exactly what an auditor is checking.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { apiFetch } from '../../../lib/api';
import { formatDateTime, formatNumber, shortId } from '../../../lib/format';
import { RequirePermission } from '../../../components/permission-gate';
import { EmptyBlock, EventChip, PageHead, PersonCell, Toolbar } from '../../../components/console-kit';
import { Panel } from '../../../components/ui/card';
import { ErrorNote, LoadingBlock } from '../../../components/ui/feedback';

interface AuditEntry {
  readonly id: string;
  readonly action: string;
  readonly actorLabel: string | null;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly createdAt: string;
  readonly txHash: string | null;
}

interface AuditPage {
  readonly items: readonly AuditEntry[];
  readonly total: number;
  readonly page: number;
  readonly totalPages: number;
  readonly actions: readonly string[];
  readonly actors: readonly { id: string; label: string }[];
}

/**
 * Permission check happens here, above the queries, not after they fail: a role the §3.6 matrix
 * excludes never sends a request this screen would be refused for.
 */
export default function AuditPage() {
  return (
    <RequirePermission permission="audit:view">
      <AuditLedger />
    </RequirePermission>
  );
}

function AuditLedger() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);

  const query = new URLSearchParams({ page: String(page), pageSize: '40' });
  if (action) query.set('action', action);

  const log = useQuery<AuditPage>({
    queryKey: ['audit', query.toString()],
    queryFn: () => apiFetch<AuditPage>(`/audit?${query.toString()}`),
  });

  return (
    <div className="space-y-7">
      <PageHead
        title="Audit ledger"
        meta={
          log.data
            ? `${formatNumber(log.data.total)} entries · page ${log.data.page} of ${log.data.totalPages} · append-only, write revoked at the database`
            : 'Querying'
        }
      />

      <Panel
        title="Event stream"
        right={log.data ? `page ${log.data.page}/${log.data.totalPages}` : undefined}
      >
        <Toolbar
          search={action}
          onSearch={(next) => {
            setAction(next);
            setPage(1);
          }}
          placeholder="Filter by action, e.g. chain.license_minted"
          count={`${log.data?.actions.length ?? 0} distinct actions recorded`}
        />

        {log.isLoading ? <LoadingBlock label="Loading the ledger" /> : null}
        {log.error ? <ErrorNote message={(log.error as Error).message} /> : null}

        {log.data && log.data.items.length === 0 ? (
          <EmptyBlock
            title="No entries match"
            hint="The filter is a substring match on the action name. Clear it to see the whole ledger, which records every write in this workspace."
            action={
              action ? (
                <button
                  type="button"
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12"
                  onClick={() => {
                    setAction('');
                    setPage(1);
                  }}
                >
                  Clear the filter
                </button>
              ) : null
            }
          />
        ) : null}

        {log.data && log.data.items.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="vs-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Actor</th>
                  <th>Entity</th>
                  <th>Chain</th>
                </tr>
              </thead>
              <tbody>
                {log.data.items.map((entry) => (
                  <tr key={entry.id}>
                    <td className="font-mono text-[12px] text-ink-dim whitespace-nowrap">{formatDateTime(entry.createdAt)}</td>
                    <td>
                      <EventChip action={entry.action} />
                    </td>
                    <td>
                      {entry.actorLabel ? (
                        <PersonCell name={entry.actorLabel} compact />
                      ) : (
                        <span className="font-mono text-[12px] text-ink-dim">System</span>
                      )}
                    </td>
                    <td className="font-mono text-[12px] text-ink-dim" style={{ color: 'var(--vs-fg-faint)' }}>
                      {entry.entityType}
                      {entry.entityId ? `/${shortId(entry.entityId, 6)}` : ''}
                    </td>
                    <td className="font-mono text-[12px] text-ink-dim">
                      {entry.txHash ? (
                        <span title={entry.txHash}>{entry.txHash.slice(0, 12)}…</span>
                      ) : (
                        <span style={{ color: 'var(--vs-fg-faint)' }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {log.data && log.data.totalPages > 1 ? (
          <div className="flex items-center justify-between gap-3 p-4">
            <button
              type="button"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12"
              disabled={page <= 1}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous
            </button>
            <span className="text-[12px] tracking-[0.01em] text-ink-faint">
              Page {log.data.page} of {log.data.totalPages}
            </span>
            <button
              type="button"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12"
              disabled={page >= log.data.totalPages}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </button>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
