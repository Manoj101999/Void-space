'use client';

/**
 * A single catalogue card.
 *
 * The media well prefers the pre-rendered render and falls back to a drawn figure. It does **not**
 * mount a live viewer per card: a grid of ten WebGL contexts is what makes a 3D marketplace feel
 * broken on a laptop, and the interactive view is one click away.
 *
 * Figures are the ones a buyer filters on — triangle count, file size, licence — not marketing copy.
 * The `heavy` note is a genuinely useful warning rather than a badge: a quarter-million-triangle scan
 * will not run on a standalone headset without decimation, and the person who needs to know that is
 * the person scanning the grid.
 *
 * The whole card is one link. The public catalogue has no bookmark toggle and no cart, so a card with
 * a link inside a link would only add an unreachable focus stop.
 */
import Link from 'next/link';
import { useState } from 'react';
import type { PublicCatalogItem } from '@void-space/types';

import { formatBytes, formatNumber } from '../lib/format';
import { thumbnailUrl } from '../lib/public-api';
import { Chip } from './ui/chip';
import { CubeIcon } from './ui/icons';

/** Above this, the asset needs a decimation pass before it goes into a headset (FR-3.4 budget). */
const HEAVY_TRIANGLES = 150_000;

export function MarketCard({ item }: { item: PublicCatalogItem }) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const heavy = item.polycount !== null && item.polycount > HEAVY_TRIANGLES;

  return (
    <Link
      href={`/m/${item.assetId}`}
      aria-label={`Open ${item.name}`}
      className="group flex flex-col overflow-hidden rounded-card border border-hairline bg-surface transition-all duration-200 ease-standard hover:-translate-y-0.5 hover:border-hairline-strong hover:shadow-float"
    >
      <div className="relative aspect-[4/3] overflow-hidden border-b border-hairline bg-deeper">
        {thumbnailFailed ? (
          <div className="absolute inset-0 flex items-center justify-center bg-grid-faint bg-grid-sm text-ink-faint">
            <CubeIcon width={44} height={44} className="opacity-40" />
          </div>
        ) : (
          // A plain <img>, not next/image: these are already correctly sized renders served from our
          // own route handler, so the optimizer would only add a second cache in front of a cache.
          <img
            src={thumbnailUrl(item.ipfsCid)}
            alt={`Render of ${item.name}`}
            loading="lazy"
            width={1200}
            height={900}
            onError={() => setThumbnailFailed(true)}
            className="h-full w-full object-cover transition-transform duration-500 ease-standard group-hover:scale-[1.04]"
          />
        )}

        <span className="absolute left-3 top-3">
          <Chip tone="brand">{item.licenseType}</Chip>
        </span>

        {heavy ? (
          <span className="absolute right-3 top-3">
            <Chip tone="warn">heavy for XR</Chip>
          </span>
        ) : null}

        <span className="pointer-events-none absolute inset-x-0 bottom-0 flex translate-y-1.5 items-center justify-between gap-2 bg-scrim px-3.5 py-2.5 text-[13px] font-semibold text-ink opacity-0 transition-all duration-200 ease-standard group-hover:translate-y-0 group-hover:opacity-100">
          Open in the 3D studio
          <span aria-hidden>→</span>
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-1.5 px-4 py-4">
        <h3 className="text-[15px] font-semibold leading-[1.35] tracking-[-0.01em] text-ink">
          {item.name}
        </h3>
        <div className="font-mono text-[11.5px] text-ink-faint">
          {item.category} · {item.tenantName}
        </div>
      </div>

      <div className="mt-auto flex flex-wrap gap-x-4 gap-y-1.5 border-t border-hairline px-4 py-3 font-mono text-[12px] text-ink">
        <span className="tabular-nums">{formatNumber(item.polycount)} tris</span>
        <span className="text-ink-faint">{formatBytes(Number(item.sizeBytes))}</span>
        <span className="text-ink-faint">
          token <span className="text-ink">#{item.tokenId ?? '—'}</span>
        </span>
      </div>
    </Link>
  );
}
