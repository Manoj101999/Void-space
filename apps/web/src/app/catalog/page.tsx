/**
 * The licensed catalogue (§6.1 "Public Catalog", FR-5.2, FR-5.3).
 *
 * This is a page a visitor navigates *to*, not the company's front door. It held the root URL until
 * now, which made the landing page a wall of customer assets: nobody arriving to find out what the
 * product is should be shown a gallery, and a vendor should not put licensed work on its home page.
 * The root is the product page; this is one of its features.
 *
 * It does **not** render the application shell and does not ask who is calling — no session check, no
 * holding screen. Rendered per request because it states a live fact, which licences are active right
 * now, and a takedown must take effect on the next request rather than when an ISR window expires. The
 * content comes from the anonymous API, which reads the publish-time projection rather than tenant
 * tables, so no tenant context is established at any point.
 */
import type { Metadata } from 'next';

import { HeroStage } from '../../components/hero-showcase';
import { MarketFooter, MarketHeader } from '../../components/market-shell';
import { MarketplaceBrowser } from '../../components/marketplace-browser';
import { CheckIcon } from '../../components/ui/icons';
import { Container, Section, SectionHead } from '../../components/ui/layout';
import { Stat, StatGrid } from '../../components/ui/stat';
import { formatBytes, formatNumber } from '../../lib/format';
import {
  browseMarketplace,
  marketplaceFacets,
  marketplaceStats,
  SORT_OPTIONS,
} from '../../lib/public-api';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Catalogue — licensed 3D assets · VOID·SPACE',
  description:
    'Browse licensed 3D models with verifiable provenance. Every asset carries an ERC-721 licence and content-addressed storage on IPFS.',
};

interface PageProps {
  readonly searchParams: { category?: string; tag?: string; q?: string; sort?: string };
}

/** One of the three things that happen to an asset before it is listed. */
function Step({
  index,
  title,
  children,
}: {
  index: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-base font-mono text-[12px] text-ink-dim">
        {index}
      </div>
      <h3 className="mt-5 text-[16px] font-semibold tracking-[-0.012em] text-ink">{title}</h3>
      <p className="mt-3 text-[14px] leading-[1.7] text-ink-dim">{children}</p>
    </div>
  );
}

export default async function CatalogPage({ searchParams }: PageProps) {
  const category = searchParams.category?.trim() || undefined;
  const tag = searchParams.tag?.trim() || undefined;
  const search = searchParams.q?.trim() || undefined;
  // Ignore an unknown `?sort=` rather than erroring: a stale bookmark should open the catalogue, not a
  // validation failure.
  const sort = SORT_OPTIONS.find((option) => option.value === searchParams.sort)?.value ?? 'newest';

  // One round trip each, in parallel: the grid, the facet counts and the headline figures.
  const [page, facets, stats] = await Promise.all([
    browseMarketplace({ category, tag, search, sort, limit: 24 }),
    marketplaceFacets(),
    marketplaceStats(),
  ]);

  return (
    <div className="flex min-h-[100dvh] flex-col bg-base">
      <MarketHeader current="catalog" />

      <main id="main" className="flex-1">
        {/* ------------------------------------------------------------------------ hero */}
        <div className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-grid-faint bg-grid-lg [mask-image:radial-gradient(80%_60%_at_50%_0%,#000_0%,transparent_72%)]"
          />

          <Container className="relative grid gap-12 py-14 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center lg:gap-16 lg:py-20">
            <div>
              <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-brand">
                Licensed catalogue
              </span>

              <h1 className="mt-6 text-balance text-[clamp(2rem,3.6vw,2.875rem)] font-semibold leading-[1.08] tracking-[-0.03em] text-ink">
                Models you can <span className="text-brand">verify</span>, not just download.
              </h1>

              <p className="mt-6 max-w-[56ch] text-[16px] leading-[1.7] text-ink-dim">
                Every model here is addressed by its content hash and licensed as an ERC-721 token. The
                token id, the contract address and the transaction that minted it are printed on the
                listing, so provenance is something you check rather than something you accept.
              </p>

              {stats ? (
                <div className="mt-10 overflow-hidden rounded-surface border border-hairline">
                  {/* Two columns, not four. This grid sits in a hero column about half the page wide,
                      where four cells gave each figure ~90px and wrapped both the label and the value
                      onto two lines. The landing page uses four because it has the full width. */}
                  <StatGrid columns={2}>
                    <Stat label="Models licensed" value={formatNumber(stats.published)} />
                    <Stat label="Triangles indexed" value={formatNumber(stats.polygons)} />
                    <Stat label="Pinned to IPFS" value={formatBytes(Number(stats.bytes))} />
                    <Stat label="Categories" value={formatNumber(stats.categories)} />
                  </StatGrid>
                </div>
              ) : null}
            </div>

            {/*
              A real licence, turning, above the fold. The grid below is a list of the same kind of
              thing — this is the one place a visitor confirms that in a single gesture rather than by
              taking our word for it.
            */}
            <HeroStage items={page.items.slice(0, 4)} />
          </Container>
        </div>

        {/* ------------------------------------------------------------------- catalogue */}
        <Container className="pb-20">
          <MarketplaceBrowser
            initial={page}
            facets={facets}
            initialCategory={category}
            initialTag={tag}
            initialSearch={search}
            initialSort={sort}
          />
        </Container>

        {/* ------------------------------------------------------------------ provenance */}
        <Section band id="provenance">
          <SectionHead
            eyebrow="Why these listings can be checked"
            title="Three things happen to an asset before it appears here."
          />

          <div className="mt-14 grid gap-10 md:grid-cols-3">
            <Step index="01" title="A person reviews it">
              An assessor approves the asset, sends it back for revision, or rejects it — and the
              decision, the comment and the file version are written to an append-only ledger that no
              role can edit afterwards.
            </Step>
            <Step index="02" title="It is pinned by hash">
              The file is stored on IPFS and its content address is printed on the listing. The bytes
              you preview in the viewer are the bytes that address commits to, and the viewer measures
              the geometry it decoded so you can see the record and the file agree.
            </Step>
            <Step index="03" title="Its licence is minted">
              Publishing mints an ERC-721 licence carrying the content hash and the licence terms. The
              token id, contract and transaction are on the listing, so the terms travel with the asset
              instead of living in a database you have to trust.
            </Step>
          </div>

          <p className="mt-12 flex items-center gap-2.5 text-[13.5px] text-ink-faint">
            <CheckIcon width={15} height={15} className="text-brand" />
            A delisted asset answers 404, the same as one that never existed — so the catalogue cannot
            be probed for takedowns.
          </p>
        </Section>
      </main>

      <MarketFooter />
    </div>
  );
}

