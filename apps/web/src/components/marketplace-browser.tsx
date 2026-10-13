'use client';

/**
 * Catalogue browser (§6.1 "Public Catalog").
 *
 * The first page of results is server-rendered and passed in as `initial`, so a visitor following a
 * shared link sees models immediately rather than a spinner. Filtering then re-queries the API rather
 * than filtering in memory: facet counts and totals must describe the whole catalogue, and a client
 * that filters its own page is what makes a marketplace claim a category is empty while showing
 * "5 of 24".
 *
 * Filter state is mirrored into the URL with `history.replaceState`, not `router.replace`. The page is
 * rendered per request, so a router navigation would re-render the Server Component *and* re-run the
 * query — two round trips for one keystroke. `replaceState` keeps the link shareable, which is the
 * actual goal, and costs nothing.
 */
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import type {
  PublicCatalogFacets,
  PublicCatalogPage,
  PublicCatalogSort,
} from '@void-space/types';

import { apiFetch } from '../lib/api';
import { formatNumber } from '../lib/format';
import { SORT_OPTIONS } from '../lib/public-api';
import { buttonVariants } from './ui/button';
import { FilterChip } from './ui/chip';
import { SearchField, Select } from './ui/field';
import { EmptyState, LoadingBlock } from './ui/feedback';
import { MarketCard } from './market-card';

export interface MarketplaceBrowserProps {
  readonly initial: PublicCatalogPage;
  readonly facets: PublicCatalogFacets | null;
  /** Filters that arrived in the URL, so a shared link opens the same view. */
  readonly initialCategory?: string | undefined;
  readonly initialTag?: string | undefined;
  readonly initialSearch?: string | undefined;
  readonly initialSort?: PublicCatalogSort | undefined;
}

function buildQuery(params: {
  category?: string | undefined;
  tag?: string | undefined;
  search?: string | undefined;
  sort?: string | undefined;
}): string {
  const search = new URLSearchParams();
  if (params.category) search.set('category', params.category);
  if (params.tag) search.set('tag', params.tag);
  if (params.search) search.set('search', params.search);
  // `newest` is the server default, so it is left out of the URL rather than spelled out.
  if (params.sort && params.sort !== 'newest') search.set('sort', params.sort);
  const value = search.toString();
  return value.length > 0 ? `?${value}` : '';
}

export function MarketplaceBrowser({
  initial,
  facets,
  initialCategory,
  initialTag,
  initialSearch,
  initialSort = 'newest',
}: MarketplaceBrowserProps) {
  const [category, setCategory] = useState(initialCategory ?? '');
  const [tag, setTag] = useState(initialTag ?? '');
  const [searchInput, setSearchInput] = useState(initialSearch ?? '');
  const [search, setSearch] = useState(initialSearch ?? '');
  const [sort, setSort] = useState<PublicCatalogSort>(initialSort);

  // Debounced so a six-character query is one request, not six.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 320);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const isDefaultView = !category && !tag && !search && sort === 'newest';

  const query = useQuery<PublicCatalogPage>({
    queryKey: ['marketplace', category, tag, search, sort],
    queryFn: () =>
      apiFetch<PublicCatalogPage>(`/public/catalog${buildQuery({ category, tag, search, sort })}`),
    // The unfiltered first page was already rendered on the server.
    initialData: isDefaultView ? initial : undefined,
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  });

  const page = query.data ?? initial;
  const items = page.items;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const next = `${window.location.pathname}${buildQuery({ category, tag, search, sort })}`;
    window.history.replaceState(null, '', next);
  }, [category, tag, search, sort]);

  const clearAll = useCallback(() => {
    setCategory('');
    setTag('');
    setSearchInput('');
    setSearch('');
    setSort('newest');
  }, []);

  const categories = facets?.categories ?? [];
  const tags = (facets?.tags ?? []).slice(0, 12);
  const activeFilters = [category, tag, search].filter(Boolean).length;

  return (
    <div>
      {/* --------------------------------------------------------------------- toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-hairline py-5">
        <SearchField
          label="Search the catalogue"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          className="min-w-[240px] flex-1"
        />

        <Select
          value={sort}
          aria-label="Sort the catalogue"
          onChange={(event) => setSort(event.target.value as PublicCatalogSort)}
          className="w-auto min-w-[168px]"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>

        <span className="ml-auto font-mono text-[12.5px] text-ink-faint" aria-live="polite">
          {query.isFetching
            ? 'Searching…'
            : `${formatNumber(page.total)} model${page.total === 1 ? '' : 's'}`}
        </span>
      </div>

      {/* --------------------------------------------------------------- category chips */}
      {categories.length > 0 ? (
        <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="Categories">
          <FilterChip selected={category === ''} onClick={() => setCategory('')}>
            All
          </FilterChip>
          {categories.map((entry) => (
            <FilterChip
              key={entry.value}
              selected={category === entry.value}
              count={entry.count}
              onClick={() => setCategory(category === entry.value ? '' : entry.value)}
            >
              {entry.value}
            </FilterChip>
          ))}
        </div>
      ) : null}

      {tags.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Tags">
          {tags.map((entry) => (
            <FilterChip
              key={entry.value}
              selected={tag === entry.value}
              count={entry.count}
              onClick={() => setTag(tag === entry.value ? '' : entry.value)}
              className="text-[12.5px]"
            >
              {entry.value}
            </FilterChip>
          ))}
        </div>
      ) : null}

      {/* ------------------------------------------------------------------ active state */}
      {activeFilters > 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="text-[13px] text-ink-faint">
            {activeFilters} filter{activeFilters === 1 ? '' : 's'} applied
          </span>
          <button type="button" onClick={clearAll} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            Clear all
          </button>
        </div>
      ) : null}

      {/* ------------------------------------------------------------------------- grid */}
      <div className="mt-8">
        {query.isLoading ? (
          <LoadingBlock label="Searching the catalogue" />
        ) : items.length === 0 ? (
          <div className="rounded-card border border-hairline bg-surface">
            <EmptyState
              title={isDefaultView ? 'The catalogue is empty' : 'Nothing matches those filters'}
              hint={
                isDefaultView
                  ? 'A model appears here once it has been reviewed and its licence is minted on chain.'
                  : 'Try a broader search, or clear the filters to see the whole catalogue.'
              }
              action={
                isDefaultView ? undefined : (
                  <button type="button" onClick={clearAll} className={buttonVariants()}>
                    Clear filters
                  </button>
                )
              }
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {items.map((item) => (
              <MarketCard key={item.assetId} item={item} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

