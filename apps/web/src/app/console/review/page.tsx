'use client';

/**
 * Assessor triage queue (SRS FR-4.1, FR-4.3, §6.1). Oldest submission first.
 *
 * A queue is a table, not a grid. A reviewer reads down twenty-five rows looking for the one that has
 * been waiting longest or carries the worst AI signal, and a wall of cards makes that comparison
 * harder: the eye cannot line up "82% / 6.2 h" across a card layout the way it can down a column.
 *
 * So this keeps the table and borrows the marketplace's *legibility* instead — a render per row so
 * the reviewer can see what is being asked about, a confidence meter rather than a percentage as
 * bare text, and the waiting time promoted to its own column, because "oldest first" is the whole
 * policy of this screen and the number behind it should not be a footnote.
 */
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { AssetStatus } from '@void-space/types';

import { apiFetch } from '../../../lib/api';
import { formatBytes, formatHours, formatNumber } from '../../../lib/format';
import { RequirePermission } from '../../../components/permission-gate';
import {
  ConsoleThumb,
  EmptyBlock,
  EventChip,
  PageHead,
  StatCell,
  StatRow,
} from '../../../components/console-kit';
import { Panel } from '../../../components/ui/card';
import { StatusChip, Tag } from '../../../components/ui/chip';
import { ErrorNote, LoadingBlock } from '../../../components/ui/feedback';

interface QueueItem {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly status: AssetStatus;
  readonly creator: { fullName: string } | null;
  readonly version: {
    versionNumber: number;
    format: string;
    sizeBytes: number;
    polycount: number | null;
    pinStatus: string;
    ipfsCid: string | null;
  } | null;
  readonly ai: {
    confidence: number;
    tags: readonly string[];
    qualityFlags: readonly string[];
    needsManualReview: boolean;
    modelVersion: string;
  } | null;
  readonly waitingHours: number | null;
}

interface QueuePage {
  readonly items: readonly QueueItem[];
  readonly total: number;
  readonly page: number;
  readonly totalPages: number;
}

interface Stats {
  readonly awaitingReview: number;
  readonly approvedTotal: number;
  readonly rejectedTotal: number;
  readonly revisionTotal: number;
  readonly averageReviewHours: number | null;
  readonly oldestWaitingHours: number | null;
}

type Bucket = 'pending' | 'needs_manual_review';

/**
 * Permission check happens here, above the queries, not after they fail: a role the §3.6 matrix
 * excludes never sends a request this screen would be refused for.
 */
export default function ReviewQueuePage() {
  return (
    <RequirePermission permission="review:view-queue">
      <ReviewQueue />
    </RequirePermission>
  );
}

/**
 * The AI signal.
 *
 * A bar as well as a number, because 0.38 and 0.62 look nearly identical as text at a glance and
 * completely different as lengths. The bar carries no colour of its own until it crosses the
 * threshold, so a row of healthy confidences is a row of quiet grey and the eye only stops on the
 * one that is low.
 */
function Confidence({ value, model }: { readonly value: number; readonly model: string }) {
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)));
  const low = value < 0.5;

  return (
    <div className="min-w-[132px]">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[12px] text-ink-dim" style={{ color: low ? 'var(--vs-rejected)' : 'var(--fc-fg)' }}>
          {percent}%
        </span>
        <span className="truncate font-mono text-[11px] text-ink-faint">{model}</span>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-veil-8" role="img" aria-label={`Confidence ${percent}%`}>
        <span
          style={{
            width: `${percent}%`,
            background: low ? 'var(--vs-rejected)' : 'var(--vs-fg-faint)',
          }}
        />
      </div>
    </div>
  );
}

function ReviewQueue() {
  const [bucket, setBucket] = useState<Bucket>('pending');

  const stats = useQuery<Stats>({
    queryKey: ['review', 'stats'],
    queryFn: () => apiFetch<{ stats: Stats }>('/review/stats').then((r) => r.stats),
    refetchInterval: 20_000,
  });

  const queue = useQuery<QueuePage>({
    queryKey: ['review', 'queue', bucket],
    queryFn: () => apiFetch<QueuePage>(`/review/queue?status=${bucket}&pageSize=25`),
    refetchInterval: 15_000,
  });

  const oldest = stats.data?.oldestWaitingHours ?? null;

  return (
    <div className="space-y-7">
      <PageHead
        title="Review queue"
        meta={`Oldest first · average decision ${formatHours(
          stats.data?.averageReviewHours ?? null,
        )} · oldest waiting ${formatHours(oldest)}`}
        actions={
          <div className="flex gap-2" role="group" aria-label="Queue bucket">
            <button
              type="button"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12"
              data-active={bucket === 'pending'}
              aria-pressed={bucket === 'pending'}
              onClick={() => setBucket('pending')}
            >
              Awaiting decision
            </button>
            <button
              type="button"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12"
              data-active={bucket === 'needs_manual_review'}
              aria-pressed={bucket === 'needs_manual_review'}
              onClick={() => setBucket('needs_manual_review')}
            >
              Flagged for manual review
            </button>
          </div>
        }
      />

      <StatRow>
        <StatCell
          label="Awaiting"
          value={formatNumber(stats.data?.awaitingReview ?? 0)}
          hint="needs a decision"
          tone={(stats.data?.awaitingReview ?? 0) > 0 ? 'heat' : 'plain'}
        />
        <StatCell label="Approved" value={formatNumber(stats.data?.approvedTotal ?? 0)} tone="forest" />
        <StatCell label="Rejected" value={formatNumber(stats.data?.rejectedTotal ?? 0)} />
        <StatCell label="Sent back" value={formatNumber(stats.data?.revisionTotal ?? 0)} />
        <StatCell
          label="Oldest waiting"
          value={formatHours(oldest)}
          hint="submitted to now"
          tone={oldest !== null && oldest > 48 ? 'honey' : 'plain'}
        />
      </StatRow>



      <Panel
        title={bucket === 'pending' ? 'Awaiting decision' : 'Flagged for manual classification'}
        right={queue.data ? `${queue.data.total} items` : undefined}
      >
        {queue.isLoading ? <LoadingBlock label="Loading the queue" /> : null}
        {queue.error ? <ErrorNote message={(queue.error as Error).message} /> : null}

        {queue.data && queue.data.items.length === 0 ? (
          <EmptyBlock
            title="Queue clear"
            hint="Nothing is waiting on a decision. An asset arrives here the moment a creator submits it, and leaves when someone holding review:decide approves, rejects, or sends it back."
          />
        ) : null}

        {queue.data && queue.data.items.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="vs-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>AI signal</th>
                  <th className="text-right">Complexity</th>
                  <th className="text-right">Waiting</th>
                  <th className="text-right">State</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {queue.data.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="flex items-center gap-3">
                        <span className="inline-flex h-11 w-11 shrink-0 overflow-hidden rounded-[6px] border border-hairline bg-deeper">
                          {/*
                            This table passes no CID, so every row draws the figure. Renders exist for
                            queued assets too — the renderer walks every state — so this is the table's
                            choice rather than a missing file: a queue row is read, and the detail page
                            is where somebody looks at the model.
                          */}
                          <ConsoleThumb cid={null} alt="" seed={item.id} />
                        </span>
                        <span className="min-w-0">
                          <Link
                            href={`/console/assets/${item.id}`}
                            className="block truncate text-[13.5px] font-semibold text-ink transition-colors duration-150 ease-standard hover:text-brand-warm"
                          >
                            {item.name}
                          </Link>
                          <span className="block truncate font-mono text-[11px] text-ink-faint">
                            {item.category} · {item.creator?.fullName ?? 'unknown'} · v
                            {item.version?.versionNumber ?? '—'}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td>
                      {item.ai ? (
                        <div>
                          <Confidence value={item.ai.confidence} model={item.ai.modelVersion} />
                          <div className="mt-2 flex flex-wrap gap-1">
                            {item.ai.tags.slice(0, 2).map((tag) => (
                              <Tag key={tag}>{tag}</Tag>
                            ))}
                            {item.ai.qualityFlags.slice(0, 2).map((flag) => (
                              <Tag key={flag} tone="brand">
                                {flag}
                              </Tag>
                            ))}
                          </div>
                          {item.ai.needsManualReview ? (
                            <div className="mt-2">
                              <EventChip action="ai.enrichment_flagged" />
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <span className="font-mono text-[12px] text-ink-dim">Awaiting enrichment…</span>
                      )}
                    </td>
                    <td className="font-mono tracking-[-0.01em] tabular-nums whitespace-nowrap text-right">
                      {formatNumber(item.version?.polycount ?? null)}
                      <span className="mt-1 block font-mono text-[11px] text-ink-faint">
                        {formatBytes(item.version?.sizeBytes ?? 0)}
                      </span>
                    </td>
                    <td className="font-mono tracking-[-0.01em] tabular-nums whitespace-nowrap text-right">
                      {formatHours(item.waitingHours)}
                    </td>
                    <td className="text-right">
                      <StatusChip status={item.status} />
                    </td>
                    <td className="text-right">
                      <Link href={`/console/assets/${item.id}`} className="inline-flex items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 font-semibold transition-all duration-200 ease-standard hover:bg-veil-12 h-8 px-3 text-[13px] text-ink-dim hover:bg-veil-6 hover:text-ink">
                        Decide
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
