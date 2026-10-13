/**
 * Server-side reads for the public marketplace (§6.1 "Public Catalog").
 *
 * These run in a Server Component, so they call the API by its *internal* address rather than the
 * browser's proxied path, and they send no cookie: the endpoints behind them are anonymous by design
 * and forwarding a session here would only make the render depend on the caller.
 *
 * `cache: 'no-store'` (set inside `apiFetch`) is deliberate. A marketplace listing is a live claim
 * about what is licensed *now* — serving a cached page after a takedown would keep advertising an
 * asset that had been withdrawn.
 */
import type {
  PublicCatalogFacets,
  PublicCatalogItem,
  PublicCatalogPage,
  PublicCatalogSort,
  PublicCatalogStats,
} from '@void-space/types';

import { API_INTERNAL_URL, apiFetch } from './api';

/**
 * The sort options offered in the UI, paired with the labels a shopper reads.
 *
 * Mirrors `PUBLIC_CATALOG_SORTS` in `@void-space/db`, which is the validator's own source: the API
 * rejects anything outside it, so an option added here without a server counterpart fails loudly in
 * a request rather than silently doing nothing.
 */
export const SORT_OPTIONS: readonly { readonly value: PublicCatalogSort; readonly label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'triangles-desc', label: 'Most detailed' },
  { value: 'size-desc', label: 'Largest file' },
  { value: 'name', label: 'Name A–Z' },
];

/** Tolerates the API being unreachable so the storefront renders an honest empty state, not a 500. */
async function safe<T>(path: string): Promise<T | null> {
  try {
    return await apiFetch<T>(path, { baseUrl: `${API_INTERNAL_URL}/api/v1`, suppressErrorLog: true });
  } catch {
    return null;
  }
}

export interface BrowseParams {
  readonly category?: string | undefined;
  readonly search?: string | undefined;
  readonly tag?: string | undefined;
  readonly licenseType?: string | undefined;
  readonly sort?: PublicCatalogSort | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

function queryString(params: BrowseParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const serialised = search.toString();
  return serialised.length > 0 ? `?${serialised}` : '';
}

export async function browseMarketplace(params: BrowseParams = {}): Promise<PublicCatalogPage> {
  const page = await safe<PublicCatalogPage>(`/public/catalog${queryString(params)}`);
  return page ?? { total: 0, limit: params.limit ?? 24, offset: params.offset ?? 0, items: [] };
}

export async function marketplaceFacets(): Promise<PublicCatalogFacets | null> {
  return safe<PublicCatalogFacets>('/public/facets');
}

export async function marketplaceStats(): Promise<PublicCatalogStats | null> {
  return safe<PublicCatalogStats>('/public/stats');
}

export async function marketplaceItem(assetId: string): Promise<PublicCatalogItem | null> {
  const payload = await safe<{ item: PublicCatalogItem }>(`/public/catalog/${assetId}`);
  return payload?.item ?? null;
}

/** The content gateway. Served by nginx, which caches what it fetches from Kubo (FR-8.3). */
export function gatewayUrl(cid: string): string {
  return `/ipfs/${cid}`;
}

/** Renders are produced ahead of time by `scripts/render-thumbnails.mjs`, keyed by content address. */
export function thumbnailUrl(cid: string): string {
  return `/thumbnails/${cid}`;
}
