/**
 * The landing page — now at `/home`.
 *
 * It used to be the root URL; `/` became the welcome screen that hands over to sign-in, so this
 * page moved here unchanged (only its import paths changed) and is still reachable on its own.
 *
 * It answers "what is this and why would I buy it". The first version of this page made the mistake the
 * whole product is built to avoid: it showed a code frame, monospace bracket labels and a terminal,
 * which is how you sell a developer tool and how you *fail* to sell a marketplace for 3D content.
 * Nobody buys a DAM because its `curl` output is pretty. They buy it because the library looks like a
 * shop and the licence holds up.
 *
 * So the page leads with the thing itself — a real licensed model, turning, from this workspace's own
 * catalogue — and then explains, in order, what happens to an asset, what a record proves, what the
 * platform does, who it is for, and where it stops.
 *
 * It is rendered per request, because the figures in the band below the hero are a *live claim about
 * the catalogue*: "4 models licensed" is either true right now or it is a lie, and a cached count is
 * the second one. The API reads are tolerant — if the API is unreachable the page degrades to its
 * argument without the numbers rather than failing.
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { HeroStage } from '../../components/hero-showcase';
import { MarketCard } from '../../components/market-card';
import {
  API_REFERENCE_AVAILABLE,
  MarketFooter,
  MarketHeader,
} from '../../components/market-shell';
import { cn } from '../../lib/cn';
import { buttonVariants } from '../../components/ui/button';
import { Chip } from '../../components/ui/chip';
import {
  ArrowRightIcon,
  CheckIcon,
  CubeIcon,
  LayersIcon,
  ShieldIcon,
  UploadIcon,
  UsersIcon,
} from '../../components/ui/icons';
import { Container, Section, SectionHead } from '../../components/ui/layout';
import { EmptyState } from '../../components/ui/feedback';
import { Stat, StatGrid } from '../../components/ui/stat';
import { formatBytes, formatNumber } from '../../lib/format';
import { browseMarketplace, marketplaceStats } from '../../lib/public-api';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'VOID·SPACE — 3D asset marketplace with provenance you can check',
  description:
    'Ingest, review, license and deliver 3D content with provenance that can be checked. Streamed uploads, measured geometry, human review, ERC-721 licences and XR-ready delivery.',
};

/* ------------------------------------------------------------------ content */

/** What happens to an asset, in order. The order is the policy, so it is stated as one. */
const STEPS: readonly {
  readonly step: string;
  readonly title: string;
  readonly body: string;
  readonly icon: typeof UploadIcon;
}[] = [
  {
    step: '01',
    title: 'Ingest',
    body: 'A streamed upload takes files up to 200 MB without buffering them in memory, measures the geometry on the way in, and pins the bytes to IPFS so what arrived is provable.',
    icon: UploadIcon,
  },
  {
    step: '02',
    title: 'Review',
    body: 'An assessor approves, sends back or rejects. Every decision needs a comment, cannot be self-approved, and lands in a ledger no role can edit afterwards.',
    icon: CheckIcon,
  },
  {
    step: '03',
    title: 'License',
    body: 'Publishing mints an ERC-721 licence carrying the content hash and the terms. The token id, contract address and transaction become part of the asset record.',
    icon: ShieldIcon,
  },
  {
    step: '04',
    title: 'Deliver',
    body: 'Buyers receive the exact bytes the hash commits to, at a polycount budget their target device can run — and the viewer re-counts the geometry it decoded.',
    icon: CubeIcon,
  },
];

/**
 * What a record proves.
 *
 * These are the four claims that separate this from a folder of files, and each one is a mechanism
 * rather than a promise: something the platform does, not something it intends.
 */
const PROOF: readonly { readonly title: string; readonly body: string }[] = [
  {
    title: 'The file is the address',
    body: 'Content addressing means the bytes a buyer previews are the bytes the licence covers. There is no mutable copy in a bucket that could quietly drift from the record.',
  },
  {
    title: 'The measurement is taken, not declared',
    body: 'Triangle count, vertices and true extents are read from the file on ingest and re-counted by the viewer when it decodes it. An export that overstates its budget is caught by the second reading.',
  },
  {
    title: 'The decision has a name on it',
    body: 'Approvals and rejections carry the assessor, a mandatory comment and a timestamp, and are written to a ledger with write access revoked at the database level rather than by convention.',
  },
  {
    title: 'The terms travel with the file',
    body: 'The token id, contract address and minting transaction are printed on the listing, so a licence is something a buyer checks instead of a document somebody asserted.',
  },
];

/** Capabilities, each one a job that used to be done by hand. */
const CAPABILITIES: readonly {
  readonly title: string;
  readonly body: string;
  readonly icon: typeof UploadIcon;
}[] = [
  {
    title: 'Streamed ingest, 200 MB',
    body: 'Files stage to disk and pin without ever being held whole in memory, so one large scan does not decide whether uploads work.',
    icon: UploadIcon,
  },
  {
    title: 'Geometry measured on arrival',
    body: 'Triangles, vertices, materials, textures and extents, read from the file itself rather than from what an export claimed.',
    icon: CubeIcon,
  },
  {
    title: 'Classification with a confidence figure',
    body: 'Suggested tags arrive with the model version and a confidence score; low confidence escalates to a person instead of guessing.',
    icon: LayersIcon,
  },
  {
    title: 'Revisions that stay retrievable',
    body: 'Every version is addressed by hash and kept, so what shipped is still available after three more rounds of changes.',
    icon: CheckIcon,
  },
  {
    title: 'Licensing you can revoke',
    body: 'Mint, attach terms, revoke. A takedown flags the token and removes it from distribution — the token is never burned, so provenance survives.',
    icon: ShieldIcon,
  },
  {
    title: 'Tenancy that holds',
    body: 'Roles and policy per workspace, isolated by row-level security in the database, so isolation survives an application bug.',
    icon: UsersIcon,
  },
];


/** Who this is for, in one sentence each. */
const AUDIENCES: readonly { readonly title: string; readonly body: string }[] = [
  {
    title: 'Studios licensing a library',
    body: 'A storefront for the back catalogue, terms that travel with the file, and a paper trail for every licence sold.',
  },
  {
    title: 'XR and training teams',
    body: 'Commission against a polycount and know which version was approved, at what complexity, before it reaches a headset.',
  },
  {
    title: 'Brands and institutions',
    body: 'Publish 3D content under terms that hold up, with a review record that survives a reorganisation or an audit.',
  },
];

/**
 * What the platform does not do.
 *
 * A page that lists only strengths is an advertisement. These are the limits a technical buyer would
 * find in the first week, said up front, which is cheaper for everyone than discovering them later.
 */
const LIMITS: readonly { readonly title: string; readonly body: string }[] = [
  {
    title: 'No payment rail',
    body: 'Licences are minted and entitlements are issued; money is not moved. Settlement, invoicing and tax belong to the storefront — the API is the surface it integrates against.',
  },
  {
    title: 'A format needs a decoder',
    body: 'glTF and GLB render and measure in the browser. An OBJ or FBX is stored, hashed, licensed and downloadable, but it is not previewed here.',
  },
  {
    title: 'One deployment, one database',
    body: 'Workspaces are isolated inside a single database rather than spread across regions, so this is not a global edge service.',
  },
];

/**
 * The specimen record.
 *
 * Marked as a specimen in the copy and `aria-hidden` in the markup: these are the fields the pipeline
 * actually produces, shown as an illustration of output, and they must never be mistaken for a live
 * listing. A screenshot of somebody's whale would demonstrate none of this.
 */
const RECEIPT: readonly { readonly label: string; readonly value: string; readonly note: string }[] = [
  { label: 'Content hash', value: 'bafy…digest', note: 'the bytes, addressed' },
  { label: 'Review decision', value: 'approved', note: 'assessor, comment, timestamp' },
  { label: 'Licence token', value: '#1247', note: 'ERC-721, terms attached' },
  { label: 'Transaction', value: '0x…mint', note: 'block and gas on the listing' },
];

/**
 * The routes the console itself calls, so the developer section is a fact rather than a claim.
 *
 * Every one of these is in `apps/api/src/modules`, and the point of printing them is that the console
 * is not a privileged client: it authenticates the same way and is refused the same way, which is what
 * makes "anything the console does, a storefront can do" true.
 */
const ENDPOINTS: readonly {
  readonly method: string;
  readonly path: string;
  readonly note: string;
}[] = [
  { method: 'GET', path: '/public/catalog', note: 'The listing projection. No session required.' },
  { method: 'POST', path: '/assets', note: 'Streamed multipart upload, 200 MB ceiling.' },
  { method: 'POST', path: '/assets/:id/decisions', note: 'Approve, reject or send back.' },
  { method: 'POST', path: '/assets/:id/publish', note: 'Mint the ERC-721 licence.' },
  { method: 'GET', path: '/audit', note: 'The append-only ledger.' },
];


/* --------------------------------------------------------------------- page */

export default async function LandingPage() {
  // One round trip each, in parallel. `browseMarketplace` degrades to an empty page rather than
  // throwing, so an API that is still starting produces a page without a hero model instead of a 500.
  const [page, stats] = await Promise.all([browseMarketplace({ limit: 8 }), marketplaceStats()]);

  // The hero features one asset and offers the first four as a switcher; the showroom is the catalogue
  // itself. On a large catalogue they are different lists — with four published assets they necessarily
  // overlap, which is why the two sections are framed differently: one is a stage, the other is a grid.
  const featured = page.items.slice(0, 4);
  const showroom = page.items.slice(0, 8);

  return (
    <div className="flex min-h-[100dvh] flex-col bg-base">
      <MarketHeader current="product" announcement />

      <main id="main" className="flex-1">
        {/* ---------------------------------------------------------------------- hero */}
        <div className="relative overflow-hidden">
          {/* The only texture on the page: a hairline grid fading out from the top edge. Masked, so it
              can never compete with the headline or the model. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-grid-faint bg-grid-lg [mask-image:radial-gradient(80%_60%_at_50%_0%,#000_0%,transparent_72%)]"
          />

          <Container className="relative grid gap-14 py-16 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:items-center lg:gap-20 lg:py-24">
            <div>
              <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-brand">
                3D asset lifecycle platform
              </span>

              {/* One sentence, and the last word is the whole product. Balance is on, because a
                  headline broken by luck reads as a mistake at this size. */}
              <h1 className="mt-6 text-balance text-[clamp(2.25rem,4.2vw,3.4rem)] font-semibold leading-[1.06] tracking-[-0.032em] text-ink">
                The 3D asset pipeline your buyers can <span className="text-brand">verify</span>.
              </h1>

              <p className="mt-7 max-w-[54ch] text-[16.5px] leading-[1.7] text-ink-dim">
                Streamed ingest, measured geometry, a human decision on the record, an ERC-721 licence
                — and delivery from the exact bytes the content hash commits to.
              </p>

              <div className="mt-9 flex flex-wrap items-center gap-3">
                <Link href="/catalog" className={buttonVariants({ size: 'lg', variant: 'primary' })}>
                  Browse the catalogue
                </Link>
                <Link href="#how" className={buttonVariants({ size: 'lg' })}>
                  See how it works
                </Link>
              </div>

              <p className="mt-7 text-[13px] leading-relaxed text-ink-faint">
                Runs entirely on your own hardware — no cloud account, no faucet, no paid RPC.
              </p>
            </div>

            <HeroStage items={featured} />
          </Container>
        </div>

        {/* ------------------------------------------------------------------- figures */}
        {stats ? (
          // No bottom padding: the next `Section` already opens with 64–112px, and adding to it
          // produced a 200px band of nothing between the figures and the catalogue.
          <Container>
            <div className="overflow-hidden rounded-surface border border-hairline">
              <StatGrid columns={4}>
                <Stat
                  label="Models licensed"
                  value={formatNumber(stats.published)}
                  hint="minted on chain"
                  tone="forest"
                />
                <Stat
                  label="Triangles indexed"
                  value={formatNumber(stats.polygons)}
                  hint="measured, not declared"
                />
                <Stat
                  label="Pinned to IPFS"
                  value={formatBytes(Number(stats.bytes))}
                  hint="content-addressed"
                />
                <Stat
                  label="Categories"
                  value={formatNumber(stats.categories)}
                  hint="across the catalogue"
                />
              </StatGrid>
            </div>

            <p className="mt-4 text-[12.5px] text-ink-faint">
              Read live from this workspace’s public catalogue on every request. A count that was
              cached would be a claim about a moment that has passed.
            </p>
          </Container>
        ) : null}

        {/* ------------------------------------------------------------------- showroom */}
        <Section id="showroom">
          <SectionHead
            eyebrow="The catalogue"
            title="A listing is a licence, not a file."
            lead="Every card carries the two things a buyer needs to decide: what the model costs them in triangles, and which licence it arrives under. Open one and it turns in the browser, streamed from the content address printed on the card."
            aside={
              <Link
                href="/catalog"
                className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-ink transition-colors duration-150 ease-standard hover:text-brand-warm"
              >
                Browse the catalogue
                <ArrowRightIcon width={14} height={14} />
              </Link>
            }
          />

          {showroom.length > 0 ? (
            <div className="mt-14 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {showroom.map((item) => (
                <MarketCard key={item.assetId} item={item} />
              ))}
            </div>
          ) : (
            <div className="mt-14 rounded-card border border-hairline bg-surface">
              <EmptyState
                title="The catalogue is empty"
                hint="A model appears here once an assessor has approved it and its licence has been minted on chain."
              />
            </div>
          )}
        </Section>

        {/* --------------------------------------------------------------- how it works */}
        <Section band id="how">
          <SectionHead
            eyebrow="How it works"
            title="Four gates, in this order."
            lead="The order is the policy. Nothing gets licensed that has not been reviewed, and nothing gets reviewed that has not been measured — so the record a buyer reads is built out of things that already happened."
          />

          <ol className="mt-14 grid gap-10 md:grid-cols-2 xl:grid-cols-4">
            {STEPS.map((step) => (
              <li key={step.step} className="min-w-0">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-control border border-hairline bg-base text-brand">
                    <step.icon width={18} height={18} />
                  </span>
                  <span className="font-mono text-[12px] text-ink-faint">{step.step}</span>
                </div>

                <h3 className="mt-5 text-[17px] font-semibold tracking-[-0.015em] text-ink">
                  {step.title}
                </h3>
                <p className="mt-3 text-[14px] leading-[1.7] text-ink-dim">{step.body}</p>
              </li>
            ))}
          </ol>
        </Section>

        {/* --------------------------------------------------------------------- proof */}
        <Section>
          <SectionHead
            eyebrow="What a record proves"
            title="Every listing carries the evidence for its own claims."
            lead="Not a badge, and not a PDF attached to an email. Four mechanisms, each of which a buyer can check against the file they downloaded."
          />

          <div className="mt-14 grid gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)] lg:gap-20">
            <ul className="flex flex-col gap-9">
              {PROOF.map((item) => (
                <li key={item.title} className="grid grid-cols-[auto_minmax(0,1fr)] gap-4">
                  <span className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-heat-12 text-brand">
                    <CheckIcon width={13} height={13} />
                  </span>
                  <div>
                    <h3 className="text-[16px] font-semibold tracking-[-0.012em] text-ink">
                      {item.title}
                    </h3>
                    <p className="mt-2.5 max-w-[62ch] text-[14px] leading-[1.7] text-ink-dim">
                      {item.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>

            {/*
              The record, drawn as a chain rather than written as a list. The connector between the
              steps is the argument: hash leads to decision leads to token leads to transaction, and a
              reader who follows the line has understood the product without reading a paragraph.

              `aria-hidden` and labelled "specimen" in the copy — these are the fields the pipeline
              produces, shown as an illustration of output, and they must never be mistaken for a live
              listing.
            */}
            <div
              aria-hidden
              className="rounded-surface border border-hairline bg-deeper p-6 lg:sticky lg:top-24 lg:self-start"
            >
              <div className="flex items-center justify-between gap-4">
                <span className="text-[13px] font-semibold text-ink">Asset record</span>
                <Chip tone="neutral">specimen</Chip>
              </div>

              <ol className="mt-6">
                {RECEIPT.map((row, position) => (
                  <li
                    key={row.label}
                    className="relative grid grid-cols-[18px_minmax(0,1fr)] gap-4 pb-6 last:pb-0"
                  >
                    {position < RECEIPT.length - 1 ? (
                      <span className="absolute left-[8px] top-5 h-full w-px bg-hairline-strong" />
                    ) : null}

                    <span className="relative mt-0.5 h-[18px] w-[18px] rounded-full border border-heat-40 bg-base">
                      <span className="absolute inset-[5px] rounded-full bg-brand" />
                    </span>

                    <div className="min-w-0">
                      <div className="text-[12px] font-semibold text-ink-faint">{row.label}</div>
                      <div className="mt-1 font-mono text-[13px] text-ink">{row.value}</div>
                      <div className="mt-0.5 text-[12px] text-ink-faint">{row.note}</div>
                    </div>
                  </li>
                ))}
              </ol>

              <p className="mt-6 border-t border-hairline pt-4 text-[12.5px] leading-relaxed text-ink-faint">
                Every field above is produced by the pipeline and printed on the real listing.
              </p>
            </div>
          </div>
        </Section>

        {/* -------------------------------------------------------------- capabilities */}
        <Section band>
          <SectionHead
            eyebrow="Capabilities"
            title="What the platform actually does."
            lead="Six of the ten, chosen because each one replaced a job somebody was doing by hand."
          />

          <div className="mt-14 grid gap-x-10 gap-y-12 md:grid-cols-2 xl:grid-cols-3">
            {CAPABILITIES.map((item) => (
              <div key={item.title}>
                <span className="flex h-9 w-9 items-center justify-center rounded-control border border-hairline bg-base text-brand">
                  <item.icon width={17} height={17} />
                </span>
                <h3 className="mt-4 text-[16px] font-semibold tracking-[-0.012em] text-ink">
                  {item.title}
                </h3>
                <p className="mt-2.5 text-[14px] leading-[1.7] text-ink-dim">{item.body}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* ----------------------------------------------------------------- audience */}
        <Section>
          <SectionHead
            eyebrow="Who it is for"
            title="Built for the people who have to answer for it."
            lead="Three kinds of team, and what each of them gets that they do not have today."
          />

          <div className="mt-14 grid gap-10 md:grid-cols-3">
            {AUDIENCES.map((item) => (
              <div key={item.title} className="border-t border-hairline pt-6">
                <h3 className="text-[16px] font-semibold tracking-[-0.012em] text-ink">
                  {item.title}
                </h3>
                <p className="mt-3 text-[14px] leading-[1.7] text-ink-dim">{item.body}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* --------------------------------------------------------------- developers */}
        <Section band>
          <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center lg:gap-20">
            <div>
              <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-brand">
                For developers
              </span>

              <h2 className="mt-5 text-balance text-[clamp(1.6rem,2.8vw,2.125rem)] font-semibold leading-[1.15] tracking-[-0.024em] text-ink">
                The API the console runs on.
              </h2>

              <p className="mt-5 max-w-[54ch] text-[15px] leading-[1.7] text-ink-dim">
                The console is a client of the same documented REST surface, not a privileged one. A
                storefront, a game or a training tool authenticates the same way, is refused the same
                way, and lands in the same audit ledger.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                {/*
                  The CTA points at the interactive reference, which the API registers outside
                  production only — so it is rendered only where it resolves. See
                  `API_REFERENCE_AVAILABLE`.
                */}
                {API_REFERENCE_AVAILABLE ? (
                  <a
                    href="/api/v1/docs"
                    target="_blank"
                    rel="noreferrer"
                    className={buttonVariants({ variant: 'primary' })}
                  >
                    Read the API reference
                    <ArrowRightIcon width={15} height={15} />
                  </a>
                ) : null}
                <span className="font-mono text-[12.5px] text-ink-faint">
                  OpenAPI 3.1 · Bearer token or cookie
                </span>
              </div>
            </div>

            <ul className="divide-y divide-hairline overflow-hidden rounded-card border border-hairline bg-base">
              {ENDPOINTS.map((endpoint) => (
                <li
                  key={`${endpoint.method}-${endpoint.path}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-4"
                >
                  <span
                    className={cn(
                      'font-mono text-[11px] font-semibold uppercase tracking-[0.08em]',
                      endpoint.method === 'GET' ? 'text-ink-faint' : 'text-brand',
                    )}
                  >
                    {endpoint.method}
                  </span>
                  <code className="font-mono text-[13px] text-ink">
                    /api/v1{endpoint.path}
                  </code>
                  <span className="w-full text-[12.5px] leading-relaxed text-ink-faint sm:w-auto sm:flex-1 sm:text-right">
                    {endpoint.note}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Section>

        {/* ------------------------------------------------------------------- limits */}
        <Section>
          <SectionHead
            eyebrow="Where it stops"
            title="Three things this platform does not do."
            lead="A page that lists only strengths is an advertisement. These are the limits a technical buyer would find in the first week, said up front."
          />

          <div className="mt-14 grid gap-10 md:grid-cols-3">
            {LIMITS.map((item) => (
              <div key={item.title} className="border-t border-hairline pt-6">
                <h3 className="text-[16px] font-semibold tracking-[-0.012em] text-ink">
                  {item.title}
                </h3>
                <p className="mt-3 text-[14px] leading-[1.7] text-ink-dim">{item.body}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* ---------------------------------------------------------------------- cta */}
        <Section className="relative overflow-hidden border-t border-hairline">
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-heat-glow" />

          <div className="relative mx-auto max-w-2xl text-center">
            <h2 className="text-balance text-[clamp(1.75rem,3.4vw,2.5rem)] font-semibold leading-[1.1] tracking-[-0.028em] text-ink">
              See a real licence before you talk to anyone.
            </h2>
            <p className="mx-auto mt-5 max-w-[56ch] text-[16px] leading-[1.7] text-ink-dim">
              The catalogue is public: open an asset, orbit it, and read the token id, the contract
              address and the transaction that minted it. Nothing there asks you to sign in.
            </p>
            <div className="mt-9 flex flex-wrap justify-center gap-3">
              <Link href="/catalog" className={buttonVariants({ size: 'lg', variant: 'primary' })}>
                Open the catalogue
              </Link>
              <Link href="/login" className={buttonVariants({ size: 'lg' })}>
                Sign in to the console
              </Link>
            </div>
          </div>
        </Section>

      </main>

      <MarketFooter />
    </div>
  );
}

