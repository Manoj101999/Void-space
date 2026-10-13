/**
 * Model page — the public listing for one licensed asset (§6.1, FR-9.6).
 *
 * A Server Component. The only interactive part is the studio, so the licence terms, the token id and
 * the transaction hash are present in the initial HTML: those are the facts a buyer came for, and
 * they should not depend on a client bundle running.
 *
 * Layout follows how a technical buyer actually reads a listing: the model large and inspectable,
 * then what the file *is*, then what the licence *is*, with the single most useful action — take the
 * file — pinned in a rail that stays on screen while the specification is read.
 *
 * Everything shown comes from the anonymous catalogue projection. A delisted asset answers 404 — the
 * same answer as one that never existed — so the catalogue cannot be probed for takedowns.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MarketFooter, MarketHeader } from '../../../components/market-shell';
import { ModelStage } from '../../../components/model-stage';
import { formatBytes, formatDateTime, formatNumber, shortCid } from '../../../lib/format';
import {
  browseMarketplace,
  gatewayUrl,
  marketplaceItem,
  thumbnailUrl,
} from '../../../lib/public-api';
import { CheckIcon } from '../../../components/ui/icons';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: { assetId: string };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const item = await marketplaceItem(params.assetId);
  if (!item) return { title: 'Model not found — VOID·SPACE' };

  return {
    title: `${item.name} — VOID·SPACE`,
    description:
      item.description ??
      `${item.name}, a licensed 3D asset published by ${item.tenantName} with verifiable on-chain provenance.`,
    openGraph: {
      title: `${item.name} — licensed 3D model`,
      description: item.description ?? `Licensed under ${item.licenseType}.`,
      images: [{ url: thumbnailUrl(item.ipfsCid), width: 1200, height: 900 }],
      type: 'article',
    },
  };
}

/** One label/value row in a specification or provenance panel. */
function SpecRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="vs-spec-row">
      <span className="vs-spec-key">{label}</span>
      <span className="vs-spec-value">{children}</span>
    </div>
  );
}

/** A claim the listing makes, with the evidence for it. */
/**
 * One claim, marked verified.
 *
 * The marker is a drawn check inside a tinted square, not an empty coloured box — an empty box reads as
 * a broken image, and this component appears three times on every listing. It inherits `currentColor`
 * from the wrapper, which is what makes it the success green here.
 *
 * The layout is a two-column grid so the check sits on the first line of the prose and the text wraps
 * cleanly underneath it, at any width.
 */
function Verified({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-2.5 text-[13px] leading-[1.65] text-ink-dim">
      <span
        aria-hidden
        // `color-mix` rather than a Tailwind opacity modifier: the check inherits `currentColor`, and
        // an opacity modifier on `currentColor` is not reliably lowered to a real value. This is the
        // same technique `StatusChip` uses, so the two markers tint identically.
        style={{ background: 'color-mix(in srgb, currentColor 16%, transparent)' }}
        className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] text-current"
      >
        <CheckIcon width={11} height={11} strokeWidth={2.4} />
      </span>
      <span>{children}</span>
    </div>
  );
}

export default async function ModelPage({ params }: PageProps) {
  const item = await marketplaceItem(params.assetId);
  if (!item) notFound();

  // "More like this": the same category, minus the model being viewed.
  const related = await browseMarketplace({ category: item.category, limit: 5 });
  const relatedItems = related.items.filter((entry) => entry.assetId !== item.assetId).slice(0, 4);

  const explorer = process.env.NEXT_PUBLIC_CHAIN_EXPLORER_URL ?? '';

  return (
    <div className="relative z-10 flex min-h-[100dvh] flex-col">
      <MarketHeader current="model" />

      <main id="main" className="mx-auto w-full max-w-[1360px] px-5 flex-1 py-8">
        <nav className="mb-6 flex items-center gap-2 text-[13px]" aria-label="Breadcrumb">
          <Link href="/catalog" className="link-underline">
            Catalogue
          </Link>
          <span aria-hidden style={{ color: 'var(--vs-fg-faint)' }}>
            /
          </span>
          <Link href={`/catalog?category=${encodeURIComponent(item.category)}`} className="link-underline">
            {item.category}
          </Link>
        </nav>

        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_368px]">
          {/* ------------------------------------------------------------- viewer column */}
          <div className="min-w-0">
            <ModelStage
              cid={item.ipfsCid}
              format={item.format}
              name={item.name}
              polycount={item.polycount}
            />

            <h1 className="text-balance text-[clamp(1.5rem,3vw,2.1rem)] font-semibold leading-[1.08] tracking-[-0.02em] text-ink mt-8">{item.name}</h1>

            <div
              className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px]"
              style={{ color: 'var(--vs-fg-faint)' }}
            >
              <span>{item.tenantName}</span>
              <span aria-hidden>·</span>
              <span>{item.category}</span>
              <span aria-hidden>·</span>
              <span>published {formatDateTime(item.publishedAt).slice(0, 10)}</span>
            </div>

            {item.description ? (
              <p className="max-w-[62ch] text-pretty text-[clamp(0.95rem,1.4vw,1.08rem)] leading-[1.62] text-ink-dim mt-6">{item.description}</p>
            ) : (
              <p className="max-w-[62ch] text-pretty text-[clamp(0.95rem,1.4vw,1.08rem)] leading-[1.62] text-ink-dim mt-6" style={{ fontStyle: 'italic', opacity: 0.7 }}>
                No summary was published for this asset.
              </p>
            )}

            {item.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 mt-6">
                {item.tags.map((value) => (
                  <Link key={value} href={`/catalog?tag=${encodeURIComponent(value)}`} className="tag-interactive">
                    {value}
                  </Link>
                ))}
              </div>
            ) : null}

            {/* ------------------------------------------------------------ specification */}
            <div className="overflow-hidden rounded-card border border-hairline bg-surface shadow-panel mt-10">
              <div className="flex items-center justify-between gap-2.5 border-b border-hairline px-4 py-3 text-[12.5px] font-semibold tracking-[0.02em] text-ink">The file</div>
              <div className="px-4 py-4">
                <SpecRow label="Format">{item.format.replace(/^\./, '').toUpperCase()}</SpecRow>
                <SpecRow label="Triangles">{formatNumber(item.polycount)}</SpecRow>
                <SpecRow label="Vertices">{formatNumber(item.vertices)}</SpecRow>
                <SpecRow label="Materials">{formatNumber(item.materials)}</SpecRow>
                <SpecRow label="Texture maps">{formatNumber(item.textures)}</SpecRow>
                <SpecRow label="Animation clips">
                  {item.animations && item.animations > 0
                    ? formatNumber(item.animations)
                    : 'None — static geometry'}
                </SpecRow>
                <SpecRow label="File size">{formatBytes(Number(item.sizeBytes))}</SpecRow>
                <SpecRow label="Content address">
                  <a
                    className="link-underline"
                    href={gatewayUrl(item.ipfsCid)}
                    target="_blank"
                    rel="noreferrer"
                    title={item.ipfsCid}
                  >
                    <span className="font-mono text-[12px] text-ink-dim">{shortCid(item.ipfsCid)}</span>
                  </a>{' '}
                  <span style={{ color: 'var(--vs-fg-faint)' }}>· open the raw file</span>
                </SpecRow>
              </div>
            </div>

            {/* -------------------------------------------------------------- provenance */}
            <div className="overflow-hidden rounded-card border border-hairline bg-surface shadow-panel mt-6">
              <div className="flex items-center justify-between gap-2.5 border-b border-hairline px-4 py-3 text-[12.5px] font-semibold tracking-[0.02em] text-ink">
                Licence provenance
                <span className="chip chip-live">on chain</span>
              </div>
              <div className="px-4 py-4">
                <SpecRow label="Licence">{item.licenseType}</SpecRow>
                <SpecRow label="Token id">
                  <span className="font-mono text-[12px] text-ink-dim">#{item.tokenId ?? '—'}</span>
                </SpecRow>
                <SpecRow label="Contract">
                  {item.contractAddress ? (
                    explorer ? (
                      <a
                        className="link-underline font-mono text-[12px] text-ink-dim"
                        href={`${explorer}/address/${item.contractAddress}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {item.contractAddress}
                      </a>
                    ) : (
                      <span className="font-mono text-[12px] text-ink-dim">{item.contractAddress}</span>
                    )
                  ) : (
                    '—'
                  )}
                </SpecRow>
                <SpecRow label="Mint transaction">
                  {item.txHash ? (
                    explorer ? (
                      <a
                        className="link-underline font-mono text-[12px] text-ink-dim"
                        href={`${explorer}/tx/${item.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                        title={item.txHash}
                      >
                        {shortCid(item.txHash)}
                      </a>
                    ) : (
                      <span className="font-mono text-[12px] text-ink-dim" title={item.txHash}>
                        {shortCid(item.txHash)}
                      </span>
                    )
                  ) : (
                    '—'
                  )}
                </SpecRow>
                {item.licenseMetadataCid ? (
                  <SpecRow label="Licence metadata">
                    <a
                      className="link-underline font-mono text-[12px] text-ink-dim"
                      href={gatewayUrl(item.licenseMetadataCid)}
                      target="_blank"
                      rel="noreferrer"
                      title={item.licenseMetadataCid}
                    >
                      {shortCid(item.licenseMetadataCid)}
                    </a>
                  </SpecRow>
                ) : null}
                {item.xrManifestRef ? (
                  <SpecRow label="XR module">
                    <span className="font-mono text-[12px] text-ink-dim">{item.xrManifestRef}</span>
                  </SpecRow>
                ) : null}
                {item.sourceLicense || item.sourceUrl ? (
                  <SpecRow label="Upstream source">
                    {item.sourceUrl ? (
                      <a className="link-underline" href={item.sourceUrl} target="_blank" rel="noreferrer">
                        {item.sourceAttribution ?? item.sourceUrl}
                      </a>
                    ) : (
                      (item.sourceAttribution ?? item.sourceLicense)
                    )}
                    {item.sourceLicense ? (
                      <span style={{ color: 'var(--vs-fg-faint)' }}> · {item.sourceLicense}</span>
                    ) : null}
                  </SpecRow>
                ) : null}
              </div>
            </div>

            {/* ------------------------------------------------------------------ terms */}
            <div className="overflow-hidden rounded-card border border-hairline bg-surface shadow-panel mt-6">
              <div className="flex items-center justify-between gap-2.5 border-b border-hairline px-4 py-3 text-[12.5px] font-semibold tracking-[0.02em] text-ink">Licence terms</div>
              <div className="px-4 py-4">
                <p className="text-pretty border-l-2 border-l-[rgba(139,108,246,0.5)] pl-3.5 text-[13.5px] leading-[1.65] text-ink-dim">{item.licenseTerms ?? 'No additional terms were recorded.'}</p>
              </div>
            </div>
          </div>

          {/* --------------------------------------------------------------------- rail */}
          <aside className="flex flex-col gap-4">
            <div className="rounded-card border border-hairline bg-surface p-5">
              <div className="flex items-center justify-between gap-3">
                <span className="chip chip-live">
                  <span className="h-[7px] w-[7px] rounded-full bg-state-published animate-dot-pulse mr-1.5" aria-hidden />
                  {item.licenseType ?? 'listed'}
                </span>
                <span className="font-mono text-[11.5px] tracking-[0.01em] tabular-nums text-ink-faint">token #{item.tokenId ?? '—'}</span>
              </div>

              <div className="mt-4 text-[13.5px] leading-relaxed" style={{ color: 'var(--vs-fg-dim)' }}>
                The registry entry travels with the file, so these terms remain checkable after this
                page changes.
              </div>

              <a
                className="h-10 items-center justify-center gap-2 rounded-control border px-4 text-[14px] font-semibold transition-all duration-200 ease-standard border-brand bg-brand text-white shadow-heat hover:border-brand-warm hover:bg-brand-warm mt-5 flex w-full justify-center"
                href={gatewayUrl(item.ipfsCid)}
                download
              >
                Download the model
              </a>

              <div className="mt-2 flex gap-2">
                <a
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12 flex-1 justify-center"
                  href={gatewayUrl(item.ipfsCid)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Preview raw
                </a>
                <Link className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12 flex-1 justify-center" href={`/console/assets/${item.assetId}`}>
                  Console
                </Link>
              </div>

              <p className="mt-4 text-[12px] leading-relaxed" style={{ color: 'var(--vs-fg-faint)' }}>
                Downloading fetches the exact bytes the content address commits to. Nothing is served
                from a mutable store.
              </p>
            </div>

            <div className="rounded-card border border-hairline bg-surface p-5">
              <div className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-brand-warm">
                What this listing claims
              </div>
              {/*
                `flex-col`, not `inline-flex`. These are three sentences, and a row puts them side by
                side inside a 300px rail — which is how this card shipped three unreadable columns of
                wrapped prose. Claims stack.
              */}
              <div className="mt-4 flex flex-col gap-3.5 text-[13px] text-state-published">
                <Verified>
                  <b>Pinned, not stored.</b> The file resolves from content address{' '}
                  <span className="font-mono text-[12px] text-ink-dim">{shortCid(item.ipfsCid)}</span>.
                </Verified>
                <Verified>
                  <b>Measured in the viewer.</b> The studio counts the geometry it actually decoded, so
                  the record above can be checked against the file rather than trusted.
                </Verified>
                <Verified>
                  <b>Licence on chain.</b>{' '}
                  {item.tokenId ? (
                    <>Minted as ERC-721 token #{item.tokenId}</>
                  ) : (
                    <>Registered in the licence registry</>
                  )}
                  {item.txHash ? ' with its terms committed alongside.' : '.'}
                </Verified>
              </div>
            </div>

            {relatedItems.length > 0 ? (
              <div className="rounded-card border border-hairline bg-surface p-5">
                <div className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-brand-warm">More in {item.category}</div>
                <div className="mt-4 flex flex-col gap-2.5">
                  {relatedItems.map((entry) => (
                    <Link key={entry.assetId} href={`/m/${entry.assetId}`} className="flex min-w-0 items-center gap-2.5 rounded-control border border-hairline bg-deeper p-2 transition-colors duration-150 ease-standard hover:border-hairline-strong">
                      <img src={thumbnailUrl(entry.ipfsCid)} alt="" width={52} height={52} loading="lazy" />
                      <span className="min-w-0">
                        <span className="text-[13px] text-ink block truncate">{entry.name}</span>
                        <span className="font-mono text-[11px] text-ink-faint block">
                          {formatNumber(entry.polycount)} tris · {entry.licenseType}
                        </span>
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      </main>

      <MarketFooter />
    </div>
  );
}
