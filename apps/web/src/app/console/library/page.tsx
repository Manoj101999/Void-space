'use client';

/**
 * Asset library (SRS FR-3.5, FR-3.1).
 *
 * A Creator's working set: a filter rail, a grid of item cards, and the intake panel behind a
 * disclosure. The card carries what the pipeline is doing — pin state, polycount, version — because
 * "why is this asset not in the review queue yet" is the question this screen exists to answer, and
 * the answer is a measurement rather than a status word.
 *
 * Every filter here is a *server* filter: `q`, `status` and `category` are all in
 * `assetListQuerySchema`. Pinning deliberately is not one — the endpoint cannot filter on it, and a
 * rail row that narrowed the current page while claiming to narrow the library would be the exact
 * lie this screen exists to prevent. Pin state is printed on each card instead.
 *
 * The search box belongs to the shell too. The top bar submits `?q=`, this screen reads it as the
 * initial query, and refining it here updates the same parameter — one search, not two that disagree.
 */
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Suspense, useMemo, useState } from 'react';
import type { AssetStatus, Paginated } from '@void-space/types';

import { apiFetch } from '../../../lib/api';
import { formatBytes, formatNumber, formatRelative } from '../../../lib/format';
import { useSession } from '../../../lib/session';
import { AssetEditDialog } from '../../../components/asset-edit-dialog';
import { UploadPanel } from '../../../components/upload-panel';
import {
  EmptyBlock,
  FilterRail,
  ItemCard,
  PageHead,
  Toolbar,
  type RailGroup,
} from '../../../components/console-kit';
import { Panel } from '../../../components/ui/card';
import { ErrorNote, LoadingBlock } from '../../../components/ui/feedback';

interface AssetSummaryView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string;
  readonly tags: readonly string[];
  readonly status: AssetStatus;
  readonly updatedAt: string;
  readonly creator: { id: string; fullName: string } | null;
  readonly currentVersion: {
    readonly versionNumber: number;
    readonly format: string;
    readonly sizeBytes: number;
    readonly polycount: number | null;
    readonly pinStatus: string;
    readonly ipfsCid: string | null;
  } | null;
  /** FR-3.2/FR-4.5 — server-computed: the asset's creator or an admin may open the editor. */
  readonly canEdit: boolean;
}

interface TenantView {
  readonly settings: { readonly allowedCategories: readonly string[] };
}

/** The lifecycle states, with the label a reader expects to see. */
const STATUS_FILTERS: readonly { readonly value: AssetStatus; readonly label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'pending', label: 'In review' },
  { value: 'needs_manual_review', label: 'Manual review' },
  { value: 'approved', label: 'Approved' },
  { value: 'revision', label: 'Needs changes' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'published', label: 'Published' },
];

const PAGE_SIZE = 24;

export default function LibraryPage() {
  // `useSearchParams` needs a Suspense boundary while the route is prepared; the console is
  // force-dynamic, so this only ever renders with real parameters.
  return (
    <Suspense fallback={<LoadingBlock label="Loading the library" />}>
      <Library />
    </Suspense>
  );
}

function Library() {
  const searchParams = useSearchParams();
  const urlQuery = searchParams.get('q') ?? '';
  const status = (searchParams.get('status') ?? '') as AssetStatus | '';
  const category = searchParams.get('category') ?? '';

  // Keyed on the parameters so a global search or a shared link lands on a fresh view rather than on
  // stale local state.
  return (
    <LibraryView
      key={`${urlQuery}|${status}|${category}`}
      initialQuery={urlQuery}
      initialStatus={status}
      initialCategory={category}
    />
  );
}

function LibraryView({
  initialQuery,
  initialStatus,
  initialCategory,
}: {
  readonly initialQuery: string;
  readonly initialStatus: AssetStatus | '';
  readonly initialCategory: string;
}) {
  const { can } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState(initialQuery);
  const [status, setStatus] = useState<AssetStatus | ''>(initialStatus);
  const [category, setCategory] = useState(initialCategory);
  const [page, setPage] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<AssetSummaryView | null>(null);

  const canUpload = can('asset:upload-own');

  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
    sort: 'updatedAt',
    order: 'desc',
  });
  if (status) query.set('status', status);
  if (category) query.set('category', category);
  if (search.trim()) query.set('q', search.trim());

  const assets = useQuery<Paginated<AssetSummaryView>>({
    queryKey: ['assets', query.toString()],
    queryFn: () => apiFetch<Paginated<AssetSummaryView>>(`/assets?${query.toString()}`),
    /**
     * A fresh upload is listed with `ipfsCid: null` until the worker pins it, and the card has
     * nothing to key a preview by until that field arrives — so without a poll the Library kept
     * the drawn figure on a new asset until somebody reloaded the page, even after the render
     * existed. Poll only while a listed version is still in flight, which is exactly the window
     * in which the CID appears (the render itself is retried by `ConsoleThumb`), then stop: a
     * settled Library costs nothing, same rule as the dashboard and the review queue.
     */
    refetchInterval: (active) => {
      const items = active.state.data?.items ?? [];
      const pinning = items.some(
        (item) =>
          item.currentVersion !== null &&
          (item.currentVersion.pinStatus === 'pending' ||
            item.currentVersion.pinStatus === 'pinning'),
      );
      return pinning ? 5_000 : false;
    },
  });

  const tenant = useQuery<TenantView>({
    queryKey: ['tenant'],
    queryFn: () => apiFetch<{ tenant: TenantView }>('/tenant').then((result) => result.tenant),
  });

  /**
   * Mirrors the filters into the URL with `replaceState`, not a navigation: the link stays
   * shareable, which is the point, and a keystroke does not cost a router round trip.
   */
  function writeUrl(next: { q?: string; status?: string; category?: string }) {
    const params = new URLSearchParams();
    const q = next.q ?? search;
    const s = next.status ?? status;
    const c = next.category ?? category;
    if (q.trim()) params.set('q', q.trim());
    if (s) params.set('status', s);
    if (c) params.set('category', c);
    const value = params.toString();
    router.replace(value.length > 0 ? `/console/library?${value}` : '/console/library', {
      scroll: false,
    });
  }

  const categories = useMemo(
    () => (tenant.data?.settings.allowedCategories ?? []).map((value) => ({ value, label: value })),
    [tenant.data],
  );

  const canDelete = can('asset:delete-own-unpublished');

  async function handleDelete(asset: AssetSummaryView) {
    const confirmed = window.confirm(
      `Delete "${asset.name}"?\n\nThis cannot be undone. The asset and all its versions will be permanently removed.`,
    );
    if (!confirmed) return;

    try {
      await apiFetch(`/assets/${asset.id}`, { method: 'DELETE' });
      queryClient.invalidateQueries({ queryKey: ['assets'] });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to delete asset');
    }
  }

  const filtering = Boolean(search.trim() || status || category);

  /**
   * Back to the unfiltered library: no search, no state filter, no category, first page, and a
   * URL with no query string so the address stays the plain library route. The query string is
   * the whole request (`['assets', query]`), so clearing it is what refetches; nothing else has
   * to be told.
   */
  function showAll() {
    setSearch('');
    setStatus('');
    setCategory('');
    setPage(1);
    router.replace('/console/library', { scroll: false });
  }

  const groups: readonly RailGroup[] = [
    {
      title: 'State',
      value: status,
      onChange: (next) => {
        setStatus(next as AssetStatus | '');
        setPage(1);
        writeUrl({ status: next });
      },
      options: STATUS_FILTERS.map((entry) => ({ value: entry.value, label: entry.label })),
    },
    {
      title: 'Category',
      value: category,
      onChange: (next) => {
        setCategory(next);
        setPage(1);
        writeUrl({ category: next });
      },
      options: categories,
    },
  ];

  return (
    <div className="space-y-7">
      <PageHead
        title="Asset library"
        meta={
          assets.data
            ? `${formatNumber(assets.data.total)} records · ${
                can('review:decide') ? 'workspace scope' : 'your assets'
              } · page ${assets.data.page} of ${assets.data.totalPages}`
            : 'Querying'
        }
        actions={
          canUpload ? (
            <button
              type="button"
              className={uploading ? 'inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12' : 'inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12 border-brand bg-brand text-white shadow-heat hover:border-brand-warm hover:bg-brand-warm'}
              aria-expanded={uploading}
              onClick={() => setUploading((value) => !value)}
            >
              {uploading ? 'Close intake' : 'Ingest an asset'}
            </button>
          ) : null
        }
      />

      {canUpload && uploading ? (
        <Panel title="Intake" right="FR-3.1 · streamed, 200 MB ceiling">
          <UploadPanel categories={tenant.data?.settings.allowedCategories ?? []} />
        </Panel>
      ) : null}

      {assets.isLoading ? <LoadingBlock label="Loading the library" /> : null}
      {assets.error ? <ErrorNote message={(assets.error as Error).message} /> : null}

      {assets.data ? (
        <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
          <FilterRail groups={groups} />

          <div>
            <Toolbar
              search={search}
              onSearch={(next) => {
                setSearch(next);
                setPage(1);
                writeUrl({ q: next });
              }}
              placeholder="Search by name or tag"
              count={
                filtering
                  ? `${formatNumber(assets.data.total)} matching`
                  : `${formatNumber(assets.data.total)} records`
              }
            />

            {assets.data.items.length === 0 ? (
              <div className="relative overflow-hidden rounded-card border border-hairline bg-surface shadow-panel mt-6">
                <EmptyBlock
                  title={filtering ? 'Nothing matches those filters' : 'The library is empty'}
                  hint={
                    filtering
                      ? 'Try a broader search, or click the selected row in the rail to switch that filter off.'
                      : canUpload
                        ? 'Ingest a model to start the pipeline: it is staged, measured, pinned to IPFS and — if you submit it — placed in the review queue.'
                        : 'Ask a workspace administrator for upload rights, or wait for a teammate to submit work.'
                  }
                  action={
                    filtering ? (
                      <button
                        type="button"
                        className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12"
                        onClick={showAll}
                      >
                        Clear filters
                      </button>
                    ) : canUpload ? (
                      <button
                        type="button"
                        className="inline-flex h-10 items-center justify-center gap-2 rounded-control border px-4 text-[14px] font-semibold transition-all duration-200 ease-standard border-brand bg-brand text-white shadow-heat hover:border-brand-warm hover:bg-brand-warm"
                        onClick={() => setUploading(true)}
                      >
                        Ingest an asset
                      </button>
                    ) : null
                  }
                />
              </div>
            ) : (
              <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {assets.data.items.map((asset) => {
                  const version = asset.currentVersion;
                  const pinned = version?.pinStatus === 'pinned';

                  return (
                    <ItemCard
                      key={asset.id}
                      assetId={asset.id}
                      name={asset.name}
                      href={`/console/assets/${asset.id}`}
                      collection={`${asset.category}${
                        asset.creator ? ` · ${asset.creator.fullName}` : ''
                      }`}
                      cid={version?.ipfsCid ?? null}
                      polycount={version?.polycount ?? null}
                      sizeBytes={version?.sizeBytes ?? null}
                      badge={`v${version?.versionNumber ?? '—'}`}
                      status={asset.status}
                      figure={`${formatNumber(version?.polycount ?? null)} tris`}
                      figureSub={`${formatBytes(version?.sizeBytes ?? 0)} · ${
                        pinned ? 'pinned' : (version?.pinStatus ?? 'unpinned')
                      } · ${formatRelative(asset.updatedAt)}`}
                      onEdit={asset.canEdit ? () => setEditing(asset) : undefined}
                      onDelete={canDelete ? () => handleDelete(asset) : undefined}
                    />
                  );
                })}
              </div>
            )}

            {assets.data.totalPages > 1 ? (
              <div className="mt-6 flex items-center justify-between gap-3">
                <button
                  type="button"
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  Previous
                </button>
                <span className="text-[12px] tracking-[0.01em] text-ink-faint">
                  Page {assets.data.page} of {assets.data.totalPages}
                </span>
                <button
                  type="button"
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12"
                  disabled={page >= assets.data.totalPages}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Next
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {editing ? (
        <AssetEditDialog
          asset={editing}
          categories={tenant.data?.settings.allowedCategories ?? []}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
