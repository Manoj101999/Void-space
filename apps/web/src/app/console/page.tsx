'use client';

/**
 * Overview (SRS §6.1 "role-aware dashboards").
 *
 * Structured like a marketplace's home: a banner that says which workspace you are in and what state
 * it is in, the figures that decide what you do next, a grid of what is live, then the activity. An
 * operator opening this screen is answering one of three questions — "is anything waiting on me?",
 * "is anything broken?", "what changed?" — so the page is ordered by urgency, not by which figure is
 * largest.
 *
 * One request renders most of the screen (`GET /dashboard`), which keeps it fast and keeps the
 * counters consistent with each other. The numbers are scoped by role on the server: a Creator sees
 * their library, a reviewer sees the tenant backlog.
 */
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { AssetStatus } from '@void-space/types';

import { apiFetch } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useSession } from '../../lib/session';
import { formatBytes, formatNumber, formatRelative, shortId } from '../../lib/format';
import {
  ConsoleBanner,
  EmptyBlock,
  EventChip,
  ItemCard,
  PersonCell,
  StatCell,
  StatRow,
} from '../../components/console-kit';
import { Panel } from '../../components/ui/card';
import { STATUS_LABEL } from '../../components/ui/chip';
import { ErrorNote, LoadingBlock } from '../../components/ui/feedback';
import { Sparkbars } from '../../components/ui/stat';
import { buttonVariants } from '../../components/ui/button';
import { Chip, statusColor } from '../../components/ui/chip';
import { TBody, TD, TH, THead, TR, Table } from '../../components/ui/table';

interface DashboardPayload {
  readonly scope: 'tenant' | 'own';
  readonly counts: {
    readonly assets: number;
    readonly byStatus: Partial<Record<AssetStatus, number>>;
    readonly awaitingReview: number;
    readonly myDrafts: number;
    readonly published: number;
    readonly licensesMinted: number;
    readonly users: number;
    readonly activeApiKeys: number;
    readonly storageBytes: number;
  };
  readonly jobsInFlight: readonly { queue: string; status: string; count: number }[];
  readonly recent: readonly {
    id: string;
    action: string;
    actorLabel: string | null;
    entityType: string;
    entityId: string | null;
    createdAt: string;
  }[];
  readonly ingest: readonly { day: string; count: number }[];
}

interface AssetSummaryView {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly status: AssetStatus;
  readonly currentVersion: {
    readonly versionNumber: number;
    readonly sizeBytes: number;
    readonly polycount: number | null;
    readonly pinStatus: string;
    readonly ipfsCid: string | null;
  } | null;
}

const STATUS_ORDER: readonly AssetStatus[] = [
  'draft',
  'pending',
  'needs_manual_review',
  'approved',
  'revision',
  'rejected',
  'published',
];

export default function OverviewPage() {
  const { can, session } = useSession();

  const dashboard = useQuery<DashboardPayload>({
    queryKey: ['dashboard'],
    queryFn: () => apiFetch<DashboardPayload>('/dashboard'),
    refetchInterval: 15_000,
  });

  // The rail wants renders, which the counter payload does not carry — one small extra read.
  const published = useQuery<{ items: readonly AssetSummaryView[] }>({
    queryKey: ['assets', 'published-rail'],
    queryFn: () =>
      apiFetch<{ items: readonly AssetSummaryView[] }>(
        '/assets?status=published&pageSize=6&sort=updatedAt&order=desc',
      ),
    enabled: can('catalog:view'),
  });

  if (dashboard.isLoading) return <LoadingBlock label="Loading workspace" />;
  if (dashboard.error || !dashboard.data) {
    return <ErrorNote message={(dashboard.error as Error)?.message ?? 'Dashboard unavailable'} />;
  }

  const data = dashboard.data;
  const totalInFlight = data.jobsInFlight.reduce((sum, job) => sum + job.count, 0);

  return (
    <div className="space-y-8">
      <ConsoleBanner
        eyebrow={`${
          data.scope === 'tenant' ? 'Workspace' : 'Your work'
        } · ${formatNumber(data.counts.assets)} assets indexed`}
        title={session?.tenant.name ?? 'Workspace'}
        description={`Counters are scoped to ${
          data.scope === 'tenant' ? 'the whole workspace' : 'the assets you own'
        }. Signed in as ${session?.user.roles.join(' / ') ?? 'a member'}.`}
        actions={
          <>
            {can('asset:upload-own') ? (
              <Link href="/console/library" className={buttonVariants({ variant: 'primary' })}>
                Upload an asset
              </Link>
            ) : null}
            {can('review:view-queue') ? (
              <Link href="/console/review" className={buttonVariants()}>
                Open the review queue
              </Link>
            ) : null}
          </>
        }
        stats={
          <>
            <StatCell
              label="Awaiting review"
              value={formatNumber(data.counts.awaitingReview)}
              hint={data.counts.awaitingReview > 0 ? 'oldest first' : 'queue clear'}
              tone={data.counts.awaitingReview > 0 ? 'heat' : 'plain'}
            />
            <StatCell
              label="Published"
              value={formatNumber(data.counts.published)}
              hint="live in the catalogue"
              tone="forest"
            />
            <StatCell
              label="Licences minted"
              value={formatNumber(data.counts.licensesMinted)}
              hint="ERC-721 registry"
            />
            <StatCell
              label="In flight"
              value={formatNumber(totalInFlight)}
              hint={totalInFlight > 0 ? 'queue jobs running' : 'no jobs pending'}
              tone={totalInFlight > 0 ? 'honey' : 'plain'}
            />
          </>
        }
      />

      {/* --------------------------------------------------------------------- live grid */}
      {can('catalog:view') ? (
        <section>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-[19px] font-semibold tracking-[-0.02em] text-ink">
                Live in the catalogue
              </h2>
              <p className="mt-2 max-w-[70ch] text-[13.5px] leading-relaxed text-ink-faint">
                What a buyer can open right now. Each listing carries a minted licence and is served
                from the same bytes its content address commits to.
              </p>
            </div>
            <Link
              href="/console/catalog"
              className="text-[13.5px] font-semibold text-ink transition-colors duration-150 ease-standard hover:text-brand-warm"
            >
              See all {formatNumber(data.counts.published)} →
            </Link>
          </div>

          {published.data && published.data.items.length > 0 ? (
            /*
              A horizontal rail, the way a marketplace opens: one row of what is live, scrolled rather
              than wrapped, so the section stays one band tall however much is published. `snap-x`
              makes the scroll land on a card instead of anywhere.

              The negative margin and matching padding let the rail bleed to the edge of the viewport
              on a narrow screen, so the cut-off card reads as "there is more" rather than as a broken
              grid. `pb-2` gives the hover lift somewhere to go without clipping.
            */
            <div className="mt-6 -mx-6 flex snap-x snap-mandatory gap-4 overflow-x-auto px-6 pb-2">
              {published.data.items.map((asset) => (
                <div key={asset.id} className="w-[250px] shrink-0 snap-start">
                  <ItemCard
                    assetId={asset.id}
                    name={asset.name}
                    href={`/console/assets/${asset.id}`}
                    collection={asset.category}
                    cid={asset.currentVersion?.ipfsCid ?? null}
                    polycount={asset.currentVersion?.polycount ?? null}
                    sizeBytes={asset.currentVersion?.sizeBytes ?? null}
                    badge="ERC-721"
                    figureSub={`v${asset.currentVersion?.versionNumber ?? '—'} · ${
                      asset.currentVersion?.pinStatus ?? 'unpinned'
                    }`}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-6 rounded-card border border-hairline bg-surface">
              <EmptyBlock
                title="Nothing is published yet"
                hint="An asset appears here once an assessor has approved it and its licence has been minted on chain."
              />
            </div>
          )}
        </section>
      ) : null}

      {/* ------------------------------------------------------------------ states + jobs */}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Panel title="Lifecycle states" right={data.scope === 'tenant' ? 'workspace-wide' : 'your assets'}>
          {/*
            Seven cells, each a coloured rule across the top with the state's name and count under it.
            The rule is the state colour at full strength, which is the one place a lifecycle colour
            appears as a large area — a bar you scan across is readable at a glance in a way seven
            tinted chips are not.
          */}
          <div className="grid grid-cols-4 gap-px bg-hairline md:grid-cols-7">
            {STATUS_ORDER.map((status) => {
              const count = data.counts.byStatus[status] ?? 0;
              return (
                <div
                  key={status}
                  className={cn(
                    'flex flex-col gap-2 bg-surface px-3.5 py-4',
                    // An empty state is not hidden — it is drawn faint, because "nobody is in review"
                    // is information and a missing cell would read as a missing column.
                    count === 0 && 'opacity-45',
                  )}
                >
                  <span
                    aria-hidden
                    className="h-[3px] w-full rounded-full"
                    style={{ background: statusColor(status) }}
                  />
                  <span className="text-[12px] font-semibold leading-tight text-ink-faint">
                    {STATUS_LABEL[status]}
                  </span>
                  <span className="font-mono text-[20px] leading-none tracking-[-0.02em] text-ink">
                    {formatNumber(count)}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="border-t border-hairline" />

          <div className="flex items-baseline justify-between gap-4 px-5 pt-4">
            <span className="text-[12px] font-semibold text-ink-faint">
              Ingest volume, last 14 days
            </span>
            {can('asset:upload-own') ? (
              <Link
                href="/console/library"
                className="text-[13px] text-ink-dim transition-colors duration-150 ease-standard hover:text-ink"
              >
                Upload
              </Link>
            ) : null}
          </div>
          <Sparkbars data={data.ingest} />
        </Panel>


        <div className="space-y-5">
          <Panel
            title="Queue telemetry"
            right={totalInFlight > 0 ? `${totalInFlight} in flight` : 'idle'}
          >
            {data.jobsInFlight.length === 0 ? (
              <p className="px-5 py-6 text-[13.5px] leading-relaxed text-ink-faint">
                No jobs pending. Pinning, enrichment, minting and publishing all run through the
                queue, so an empty one means nothing is behind.
              </p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Queue</TH>
                    <TH>State</TH>
                    <TH align="right">Count</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.jobsInFlight.map((job) => (
                    <TR key={`${job.queue}-${job.status}`}>
                      <TD className="font-mono text-[12.5px]">{job.queue}</TD>
                      <TD>
                        <Chip>{job.status}</Chip>
                      </TD>
                      <TD align="right" className="font-mono">
                        {job.count}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Panel>

          <Panel title="Workspace" right="FR-14.1">
            <StatRow>
              <StatCell label="Members" value={formatNumber(data.counts.users)} />
              <StatCell label="Active API keys" value={formatNumber(data.counts.activeApiKeys)} />
              <StatCell label="Your drafts" value={formatNumber(data.counts.myDrafts)} />
              <StatCell
                label="Stored"
                value={formatBytes(data.counts.storageBytes)}
                hint="pinned to IPFS"
              />
            </StatRow>
          </Panel>
        </div>
      </div>

      {/* -------------------------------------------------------------------- activity */}
      <Panel
        title="Activity"
        right={
          // audit:view is held by TenantAdmin / Compliance / SuperAdmin only (§3.6), so the link is
          // hidden for everyone else rather than leading to a 403.
          can('audit:view') ? (
            <Link
              href="/console/audit"
              className="text-[13.5px] font-semibold text-ink transition-colors duration-150 ease-standard hover:text-brand-warm"
            >
              Full ledger →
            </Link>
          ) : (
            <span>Your recent slice</span>
          )
        }
      >
        <Table>
          <THead>
            <TR>
              <TH>Event</TH>
              <TH>Actor</TH>
              <TH>Entity</TH>
              <TH align="right">When</TH>
            </TR>
          </THead>
          <TBody>
            {data.recent.map((entry) => (
              <TR key={entry.id}>
                <TD>
                  <EventChip action={entry.action} />
                </TD>
                <TD>
                  {entry.actorLabel ? (
                    <PersonCell name={entry.actorLabel} compact />
                  ) : (
                    <span className="font-mono text-[12.5px] text-ink-dim">System</span>
                  )}
                </TD>
                <TD className="font-mono text-[12px] text-ink-faint">
                  {entry.entityType}/{shortId(entry.entityId, 6)}
                </TD>
                <TD align="right" className="whitespace-nowrap font-mono text-[12px] text-ink-faint">
                  {formatRelative(entry.createdAt)}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Panel>
    </div>
  );
}
