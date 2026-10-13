'use client';

/**
 * The storefront hero: one real licence, turning, from the actual catalogue.
 *
 * The point of putting a live model above the fold is that the page's central claim — "the bytes you
 * preview are the bytes the hash commits to" — becomes something a visitor confirms by dragging,
 * rather than something they read. A static render would be a photograph of a 3D asset, which is
 * exactly the thing being argued against, and on a page selling 3D content a screenshot of a 3D file
 * is the one image that proves nothing.
 *
 * The switcher exists because one hero model says "here is a model" and four say "here is a catalogue".
 * Only the featured model is ever mounted, so the page still holds exactly one WebGL context.
 */
import Link from 'next/link';
import { useState } from 'react';
import type { PublicCatalogItem } from '@void-space/types';

import { cn } from '../lib/cn';
import { formatNumber } from '../lib/format';
import { thumbnailUrl } from '../lib/public-api';
import { buttonVariants } from './ui/button';
import { Chip } from './ui/chip';
import { ModelStage } from './model-stage';
import { ModelStageFallback } from './model-stage-fallback';

/** Only the first few are offered as a switcher; beyond that the catalogue grid is the right tool. */
const MAX_SWITCHER = 4;

export function HeroStage({ items }: { readonly items: readonly PublicCatalogItem[] }) {
  const [index, setIndex] = useState(0);
  const options = items.slice(0, MAX_SWITCHER);
  const featured = options[index] ?? options[0];

  return (
    <div className="relative">
      {/* A single soft light source behind the stage, so the model sits in a lit space rather than on
          a flat rectangle. Pointer-events-none and blurred: it must never intercept an orbit drag. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-8 -z-10 rounded-[48px] bg-heat-glow blur-2xl"
      />

      <div className="overflow-hidden rounded-surface border border-hairline bg-deeper shadow-float">
        <div className="relative">
          {featured ? (
            <ModelStage
              cid={featured.ipfsCid}
              format={featured.format}
              name={featured.name}
              polycount={featured.polycount}
              variant="hero"
              autoRotate
              presentation
              className="h-[380px] sm:h-[440px] lg:h-[520px]"
            />
          ) : (
            <div className="relative h-[380px] sm:h-[440px] lg:h-[520px]">
              <ModelStageFallback
                title="No models are listed yet"
                body="A model appears here once it has been reviewed and its licence has been minted on chain."
              />
            </div>
          )}

          {/* The chain badge, in the corner where a marketplace puts it. It states the one fact that
              separates this listing from a file on a share drive. */}
          <div className="pointer-events-none absolute left-4 top-4">
            <Chip tone={featured ? 'live' : 'neutral'} dot>
              {featured ? 'Licensed on chain' : 'Awaiting the first listing'}
            </Chip>
          </div>
        </div>

        {featured ? (
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-hairline bg-surface px-5 py-4">
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink">
                {featured.name}
              </div>
              <div className="mt-1 truncate font-mono text-[11.5px] text-ink-faint">
                {featured.category} · {formatNumber(featured.polycount)} tris · {featured.licenseType}
                {featured.tokenId ? ` · token #${featured.tokenId}` : ''}
              </div>
            </div>

            <Link
              href={`/m/${featured.assetId}`}
              className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'shrink-0')}
            >
              Open model
            </Link>
          </div>
        ) : null}

        {options.length > 1 ? (
          /*
            Thumbnails only, no captions.

            With a name and a figure beside each render, four tiles in this column gave about sixty
            pixels of text width — every name came out as "Blue W…" and every count as "22,562 t…",
            which is worse than no label at all. The caption strip above already prints the name,
            category, triangle count and licence of whichever model is active, so the tiles only have
            to be recognisable and unambiguous. The render is; the name rides along on `title` and
            `aria-label` for anyone who needs it.
          */
          <div
            className="grid grid-cols-4 gap-2 border-t border-hairline p-3"
            role="group"
            aria-label="Featured models"
          >
            {options.map((item, position) => {
              const active = position === index;
              return (
                <button
                  key={item.assetId}
                  type="button"
                  onClick={() => setIndex(position)}
                  aria-pressed={active}
                  aria-label={`Show ${item.name}`}
                  title={item.name}
                  className={cn(
                    'relative overflow-hidden rounded-control border transition-colors duration-150 ease-standard',
                    active
                      ? 'border-veil-24'
                      : 'border-hairline opacity-60 hover:opacity-100 hover:border-hairline-strong',
                  )}
                >
                  <img
                    src={thumbnailUrl(item.ipfsCid)}
                    alt=""
                    width={160}
                    height={120}
                    loading="lazy"
                    className="aspect-[4/3] w-full bg-surface object-cover"
                  />
                  {/* The active marker is a bar, not a border tint: it survives being drawn over a
                      render that happens to be the same tone as the accent. */}
                  <span
                    aria-hidden
                    className={cn(
                      'absolute inset-x-0 bottom-0 h-[2px]',
                      active ? 'bg-brand' : 'bg-transparent',
                    )}
                  />
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

