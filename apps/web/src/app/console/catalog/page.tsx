'use client';

/**
 * The workspace marketplace — the staff view of every module (SRS §6.1).
 *
 * Laid out as a collection page, because that is what it is: a banner with the totals, a filter rail
 * on the left, a toolbar, and a grid of items. The rules the earlier table-based version already
 * followed are kept, because they are about honesty rather than layout:
 *
 * - **Nothing heavy loads unasked.** Cards carry metadata and a badge; the 3D model is fetched only
 *   when someone opens the preview, one at a time. A grid of live canvases would be a slideshow, and
 *   the bundled whale skeleton alone is 13.6 MB with 28 textures.
 * - **Filtering is instant and local.** The catalogue is small enough to filter in the browser, so a
 *   keystroke does not wait on a round trip. A deliberate contrast with the *public* catalogue, which
 *   re-queries the server because its facet counts must describe the whole collection rather than the
 *   page in hand.
 * - **The licence is the headline.** This is a licensed marketplace, not a file list: token id and
 *   licence state sit at the same level as the name.
 * - **Counts say what they count.** The API returns a true `total`; anything derived from the loaded
 *   page says "in view", because a sum over the first hundred rows is not a total.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { apiFetch } from '../../../lib/api';
import { formatBytes, formatNumber, formatRelative } from '../../../lib/format';
import { AssetQuickLook, type QuickLookAsset } from '../../../components/asset-quick-look';
import {
  ConsoleBanner,
  EmptyBlock,
  FilterRail,
  ItemCard,
  StatCell,
  Toolbar,
  type RailGroup,
} from '../../../components/console-kit';
import { ErrorNote, LoadingBlock } from '../../../components/ui/feedback';

interface CatalogItem {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly updatedAt: string;
  readonly currentVersion: QuickLookAsset['currentVersion'];
  readonly license: {
    readonly tokenId: string;
    readonly txHash: string | null;
    readonly status: string;
    readonly mintedAt: string;
    readonly licenseType?: string;
    readonly revokedAt?: string | null;
  } | null;
  readonly xrModuleUrl: string | null;
}

type SortKey = 'recent' | 'name' | 'polycount';

const SORTS: readonly { readonly value: SortKey; readonly label: string }[] = [
  { value: 'recent', label: 'Recently updated' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'polycount', label: 'Most detailed first' },
];

/** Above this an asset needs a decimation pass before it runs on a standalone headset (FR-3.4). */
const HEAVY_TRIANGLES = 150_000;

type Band = '' | 'light' | 'medium' | 'heavy';

function bandOf(polycount: number | null | undefined): Band {
  if (polycount === null || polycount === undefined) return '';
  if (polycount > HEAVY_TRIANGLES) return 'heavy';
  if (polycount > 50_000) return 'medium';
  return 'light';
}

export default function ConsoleCatalogPage() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [licence, setLicence] = useState('');
  const [band, setBand] = useState<Band>('');
  const [sort, setSort] = useState<SortKey>('recent');
  const [preview, setPreview] = useState<CatalogItem | null>(null);

  const catalog = useQuery<{ items: readonly CatalogItem[]; total: number }>({
    queryKey: ['catalog'],
    queryFn: () =>
      apiFetch<{ items: readonly CatalogItem[]; total: number }>(
        '/assets?publishedOnly=true&pageSize=100',
      ),
  });

  const items = catalog.data?.items ?? [];

  const categories = useMemo(
    () =>
      [...new Set(items.map((item) => item.category))]
        .sort()
        .map((value) => ({
          value,
          label: value,
          count: items.filter((item) => item.category === value).length,
        })),
    [items],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();

    const filtered = items.filter((item) => {
      if (category && item.category !== category) return false;
      if (licence === 'active' && item.license?.status !== 'active') return false;
      if (licence === 'revoked' && item.license?.status !== 'revoked') return false;
      if (licence === 'none' && item.license !== null) return false;
      if (band && bandOf(item.currentVersion?.polycount) !== band) return false;
      if (!needle) return true;
      return (
        item.name.toLowerCase().includes(needle) ||
        item.category.toLowerCase().includes(needle) ||
        item.tags.some((tag) => tag.toLowerCase().includes(needle))
      );
    });

    return [...filtered].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'polycount') {
        return (b.currentVersion?.polycount ?? 0) - (a.currentVersion?.polycount ?? 0);
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [items, query, category, licence, band, sort]);

  const activeLicences = items.filter((item) => item.license?.status === 'active').length;
  const revokedLicences = items.filter((item) => item.license?.status === 'revoked').length;
  // Counted once and reused, so the figure and its hint cannot disagree — the hint is the sentence
  // "1 needs decimation" / "3 need decimation", and a plural computed separately from the number it
  // describes is how a counter starts reading "1 need".
  const heavyCount = items.filter(
    (item) => bandOf(item.currentVersion?.polycount) === 'heavy',
  ).length;
  const filtering = Boolean(query || category || licence || band);

  const groups: readonly RailGroup[] = [
    { title: 'Category', value: category, onChange: setCategory, options: categories },
    {
      title: 'Licence',
      value: licence,
      onChange: setLicence,
      options: [
        { value: 'active', label: 'Active', count: activeLicences },
        { value: 'revoked', label: 'Revoked', count: revokedLicences },
        {
          value: 'none',
          label: 'Not licensed',
          count: items.length - activeLicences - revokedLicences,
        },
      ],
    },
    {
      title: 'Complexity',
      value: band,
      onChange: (next) => setBand(next as Band),
      options: [
        { value: 'light', label: 'Under 50k tris' },
        { value: 'medium', label: '50k – 150k tris' },
        { value: 'heavy', label: 'Over 150k tris' },
      ],
    },
  ];

  if (catalog.isLoading) return <LoadingBlock label="Loading the marketplace" />;
  if (catalog.error || !catalog.data) {
    return <ErrorNote message={(catalog.error as Error)?.message ?? 'The marketplace is unavailable'} />;
  }

  return (
    <div className="space-y-7">
      <ConsoleBanner
        eyebrow={`Marketplace · ERC-721 · ${
          catalog.data.total > items.length
            ? `showing the first ${items.length} of ${catalog.data.total}`
            : 'all published modules'
        }`}
        title="Published modules"
        description="Every asset here has passed review and had its licence minted on chain. Open the preview to stream the model from IPFS — nothing is downloaded until you ask for it."
        stats={
          <>
            <StatCell label="Published" value={formatNumber(catalog.data.total)} />
            <StatCell
              label="Licences active"
              value={formatNumber(activeLicences)}
              hint={revokedLicences > 0 ? `${revokedLicences} revoked` : 'none revoked'}
              tone="forest"
            />
            <StatCell
              label="Categories in view"
              value={formatNumber(categories.length)}
              hint={`${items.length} modules loaded`}
            />
            <StatCell
              label="Heavy for XR"
              value={formatNumber(heavyCount)}
              hint={`need${heavyCount === 1 ? 's' : ''} decimation`}
              tone="honey"
            />
          </>
        }
      />

      <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
        <FilterRail groups={groups} />

        <div>
          <Toolbar
            search={query}
            onSearch={setQuery}
            placeholder="Search by name, category or tag"
            count={
              filtering
                ? `${visible.length} of ${items.length} shown`
                : `${formatNumber(items.length)} modules`
            }
          >
            <label className="w-auto">
              <span className="sr-only">Sort by</span>
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as SortKey)}
                aria-label="Sort the marketplace"
              >
                {SORTS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </Toolbar>

          {visible.length === 0 ? (
            <div className="relative overflow-hidden rounded-card border border-hairline bg-surface shadow-panel mt-6">
              <EmptyBlock
                title="Nothing matches those filters"
                hint="Try a broader search, or click the selected row in the rail to switch that filter off."
                action={
                  filtering ? (
                    <button
                      type="button"
                      className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12"
                      onClick={() => {
                        setQuery('');
                        setCategory('');
                        setLicence('');
                        setBand('');
                      }}
                    >
                      Clear filters
                    </button>
                  ) : null
                }
              />
            </div>
          ) : (
            <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {visible.map((item) => {
                const version = item.currentVersion;
                const heavy = bandOf(version?.polycount) === 'heavy';

                return (
                  <ItemCard
                    key={item.id}
                    assetId={item.id}
                    name={item.name}
                    href={`/console/assets/${item.id}`}
                    collection={item.category}
                    cid={version?.ipfsCid ?? null}
                    polycount={version?.polycount ?? null}
                    sizeBytes={version?.sizeBytes ?? null}
                    badge={item.license ? `#${item.license.tokenId}` : undefined}
                    figure={`${formatNumber(version?.polycount ?? null)} tris`}
                    figureSub={`${formatBytes(version?.sizeBytes ?? 0)} · ${formatRelative(item.updatedAt)}${
                      heavy ? ' · heavy for XR' : ''
                    }`}
                    action={
                      // A button, not a link: the preview opens in place rather than navigating.
                      <button type="button" className="rounded-control border border-veil-8 bg-veil-6 px-3 py-1.5 text-[13px] font-semibold text-ink transition-colors duration-150 ease-standard hover:bg-veil-12" onClick={() => setPreview(item)}>
                        Preview
                      </button>
                    }
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      {preview ? <AssetQuickLook asset={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}
