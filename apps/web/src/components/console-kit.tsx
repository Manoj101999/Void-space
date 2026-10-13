'use client';

/**
 * The console's shared pieces.
 *
 * This is the marketplace vocabulary applied to an operations tool: a banner that says which workspace
 * you are in and what state it is in, a stat row under it, a filter rail beside a grid of item cards,
 * typed events in the activity feed, and a person cell.
 *
 * Every one of these is a *thin* component over `components/ui`. The rail, the stat cell, the person
 * cell and the status pill were each implemented twice — once here in bespoke classes and once in the
 * shared kit — which is how an operator's screen and a buyer's screen end up disagreeing about what a
 * "review" chip looks like. They now delegate, so there is one implementation and one place to change.
 *
 * Two rules are enforced here rather than re-decided per screen:
 *
 *   1. **No invented numbers.** A marketplace card shows a price because a marketplace has prices.
 *      This platform has none, so the card's prominent figure is the one the pipeline actually
 *      measured — triangles — and its action reads "Open model" rather than "Buy now". A card that
 *      borrowed the *shape* of a price without the data would be a lie with a nicer layout.
 *   2. **No bespoke styles.** A class of its own belongs in the Tailwind theme, not in a component
 *      file or a stylesheet.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { cn } from '../lib/cn';
import { formatNumber } from '../lib/format';
import { thumbnailUrl } from '../lib/public-api';
import { toggleBookmark, useBookmarks } from '../lib/bookmarks';
import { StatusChip } from './ui/chip';
import { SearchField } from './ui/field';
import { EmptyState } from './ui/feedback';
import { BellIcon, CubeIcon, HeartIcon, SearchIcon } from './ui/icons';
import { FilterRail as UiFilterRail, type RailGroup, type RailOption } from './ui/rail';
import { Stat, StatGrid } from './ui/stat';
import { Avatar, initialsOf } from './ui/avatar';

/* Glyphs live in `ui/icons`; re-exported under the names the console screens already import. */
export { SearchIcon, BellIcon, HeartIcon };
export type { RailGroup, RailOption };

/** A wireframe cube: the chain badge mark, and the placeholder when there is no render. */
export function CubeGlyph({ size = 34 }: { readonly size?: number }) {
  return <CubeIcon width={size} height={size} />;
}

/* ------------------------------------------------------------------------ thumbnail */

/**
 * The card's preview.
 *
 * Renders are produced by the pin job (see `apps/worker/src/lib/thumbnail.ts`) and served by the
 * `/thumbnails/[cid]` route handler. Until one exists — or if the read fails — the fallback is a drawn
 * figure derived from the asset id rather than a broken-image glyph, so a brand-new asset still looks
 * designed while its render is pending. Deterministic, so the same asset always gets the same figure
 * and a grid does not reshuffle on every visit.
 *
 * Two timing facts about a fresh upload make the retry below necessary rather than decorative:
 *
 *  1. The card mounts while the pin is still in flight, so it is born with `cid === null`.
 *  2. The render lands seconds after the pin — the pin job draws it from the staged bytes rather
 *     than waiting on a gateway round trip — so the first request for a brand-new CID, which
 *     happens the instant that CID arrives, is very likely a 404.
 *
 * Remembering either of those as a plain "failed" flag — which is what this used to do — latches the
 * drawn figure for the rest of the visit: the asset could finish rendering perfectly and the card
 * would never show it without a full page reload. Failure is therefore keyed to the CID it happened
 * for, and a 404 is retried on a short cadence until the render exists or the budget runs out.
 */
const THUMBNAIL_RETRY_MS = 4_000;

/**
 * Six minutes of retrying — comfortably longer than the slowest render in the pipeline (four
 * browser attempts with their backoff) — so a preview that is genuinely never coming stops asking
 * instead of polling a static route forever. Four seconds rather than ten because the thing being
 * waited on now completes in the tens of seconds, and a card that has to wait a further ten of them
 * is a card that looks broken.
 */
const THUMBNAIL_RETRY_LIMIT = 90;

export function ConsoleThumb({
  cid,
  alt,
  seed,
}: {
  readonly cid: string | null;
  readonly alt: string;
  readonly seed: string;
}) {
  /** The CID a 404 came from, and how many times that CID has been re-requested since. */
  const [miss, setMiss] = useState<{ readonly cid: string; readonly attempts: number } | null>(null);

  const failed = cid === null || (miss !== null && miss.cid === cid);

  /**
   * Clearing the miss is what makes the `<img>` mount again and re-request the file; if it 404s
   * once more the error handler records the next miss and this effect schedules the one after
   * that. Nothing retries past the limit, and nothing at all is requested while `cid` is null —
   * there is no content address to ask for yet.
   */
  useEffect(() => {
    if (cid === null || miss === null || miss.cid !== cid) return;
    if (miss.attempts >= THUMBNAIL_RETRY_LIMIT) return;
    const timer = setTimeout(() => setMiss(null), THUMBNAIL_RETRY_MS);
    return () => clearTimeout(timer);
  }, [cid, miss]);

  if (failed || !cid) {
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) {
      hash = (hash * 31 + seed.charCodeAt(index)) % 100000;
    }
    const rings = 2 + (hash % 3);
    const rotation = hash % 40;

    return (
      <div className="flex h-full w-full items-center justify-center bg-grid-faint bg-grid-sm text-ink-faint">
        <svg
          width="72"
          height="72"
          viewBox="0 0 100 100"
          fill="none"
          stroke="currentColor"
          strokeWidth="0.8"
          style={{ transform: `rotate(${rotation}deg)`, opacity: 0.5 }}
          aria-hidden
        >
          {Array.from({ length: rings }, (_, index) => {
            const side = 22 + index * (56 / rings);
            return (
              <rect key={index} x={50 - side / 2} y={50 - side / 2} width={side} height={side} />
            );
          })}
          <line x1="50" y1="10" x2="50" y2="90" />
          <line x1="10" y1="50" x2="90" y2="50" />
        </svg>
      </div>
    );
  }

  return (
    // A plain <img>, not next/image: these are already correctly sized renders served from our own
    // route handler, so the optimizer would only add a second cache in front of a cache.
    <img
      src={thumbnailUrl(cid)}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() =>
        setMiss((current) => ({
          cid,
          attempts: current !== null && current.cid === cid ? current.attempts + 1 : 1,
        }))
      }
      className="h-full w-full object-cover"
    />
  );
}

/* ------------------------------------------------------------------------ page head */

export function PageHead({
  title,
  meta,
  actions,
}: {
  readonly title: string;
  /** One mono line under the title: the figures that describe this screen right now. */
  readonly meta?: string;
  readonly actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-5">
      <div className="min-w-0">
        <h1 className="text-[clamp(1.5rem,2.4vw,1.875rem)] font-semibold tracking-[-0.028em] text-ink">
          {title}
        </h1>
        {meta ? <div className="mt-2 font-mono text-[12.5px] text-ink-faint">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------------ stat cells */

/**
 * The stat row of a banner.
 *
 * Delegates to `ui/stat`, which draws its dividers as the 1px gap between cells showing the hairline
 * colour through. That is why the cells are opaque and the row is not: one rule for the divider instead
 * of four, and no doubled lines where two cells meet.
 */
export function StatRow({ children }: { readonly children: React.ReactNode }) {
  return <StatGrid columns={4}>{children}</StatGrid>;
}

export function StatCell({
  label,
  value,
  hint,
  tone = 'plain',
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly hint?: string;
  readonly tone?: 'plain' | 'heat' | 'forest' | 'honey';
}) {
  return <Stat label={label} value={value} hint={hint} tone={tone} />;
}

/* ------------------------------------------------------------------------ banner */

/**
 * The workspace banner.
 *
 * A collection page opens with a banner and the figures that decide whether the collection is worth
 * opening. This is the same object: who you are signed in as, what this workspace contains, and the
 * numbers that decide what an operator does next — how much is waiting on a decision, how much space
 * the library occupies.
 *
 * The eyebrow is a plain semantic label rather than a `//` prefixed mono string. The old form was
 * borrowed from a terminal, and this is a library: the workspace name is the headline and the fact
 * that you are looking at a scope belongs underneath it, not above it in punctuation.
 */
export function ConsoleBanner({
  eyebrow,
  title,
  description,
  actions,
  stats,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description?: string;
  readonly actions?: React.ReactNode;
  readonly stats: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-surface border border-hairline bg-surface">
      <div className="relative bg-heat-glow">
        <div className="flex flex-wrap items-start justify-between gap-6 px-6 py-6">
          <div className="min-w-0">
            <span className="text-[12px] font-semibold uppercase tracking-[0.14em] text-brand">
              {eyebrow}
            </span>
            <h2 className="mt-3 text-[clamp(1.4rem,2.2vw,1.75rem)] font-semibold tracking-[-0.024em] text-ink">
              {title}
            </h2>
            {description ? (
              <p className="mt-2.5 max-w-2xl text-[13.5px] leading-relaxed text-ink-dim">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </div>
      <div className="border-t border-hairline">
        <StatRow>{stats}</StatRow>
      </div>
    </section>
  );
}


/* ------------------------------------------------------------------------ item card */

export interface ItemCardProps {
  readonly assetId: string;
  readonly name: string;
  readonly href: string;
  /** The "collection" line. A tenant name in the console; the category in the catalogue. */
  readonly collection: string;
  readonly cid: string | null;
  readonly polycount: number | null;
  readonly sizeBytes: number | null;
  /** Corner badge: the licence or the version. Absent when the asset is not licensed. */
  readonly badge?: string;
  /** The prominent figure. Defaults to the measured triangle count. */
  readonly figure?: string;
  /** The line under the figure. Defaults to the file size. */
  readonly figureSub?: string;
  readonly status?: React.ComponentProps<typeof StatusChip>['status'];
  readonly action?: React.ReactNode | undefined;
  readonly onEdit?: (() => void) | undefined;
  readonly onDelete?: (() => void) | undefined;
}

/**
 * A catalogue card for the console grid.
 *
 * The layout is the storefront's `MarketCard` reduced to the fields an operator cares about: the render
 * with the bookmark in the corner, the collection line, the name, the lifecycle state and a footer with
 * one measured figure and one action. It is a card and not a table row because scanning a hundred
 * renders is faster than reading a hundred rows, and the console is where somebody has to look at every
 * asset at least once.
 */
export function ItemCard({
  assetId,
  name,
  href,
  collection,
  cid,
  polycount,
  sizeBytes,
  badge,
  figure,
  figureSub,
  status,
  action,
  onEdit,
  onDelete,
}: ItemCardProps) {
  const bookmarks = useBookmarks();
  const saved = bookmarks.has(assetId);

  const bytes = sizeBytes === null ? null : `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;

  return (
    <article className="group flex flex-col overflow-hidden rounded-card border border-hairline bg-surface transition-all duration-200 ease-standard hover:-translate-y-0.5 hover:border-hairline-strong hover:shadow-float">
      <div className="relative aspect-[4/3] overflow-hidden border-b border-hairline bg-deeper">
        <Link href={href} aria-label={`Open ${name}`} className="block h-full w-full">
          {/*
            A render is keyed by the version's CID and can exist in any lifecycle state — the
            renderer (`scripts/render-thumbnails.mjs`) walks them all. An asset the renderer has
            not reached yet (a fresh upload, or a format it cannot draw) simply has no file, and
            `ConsoleThumb` falls back to the drawn figure on that 404 by design.
          */}
          <ConsoleThumb cid={cid} alt={`Render of ${name}`} seed={assetId} />
        </Link>

        {badge ? (
          <span className="absolute left-3 top-3 inline-flex items-center rounded-full border border-heat-40 bg-[rgba(10,10,10,0.7)] px-2.5 py-[3px] font-mono text-[11px] text-brand-warm backdrop-blur">
            {badge}
          </span>
        ) : null}

        {/*
          The heart sits outside the link's hit area but inside the media box: it is rendered as a
          sibling of the link, positioned over it. A bookmark control inside a link is the classic way
          to get a nested interactive element that no keyboard can reach.
        */}
        <button
          type="button"
          onClick={() => toggleBookmark(assetId)}
          aria-pressed={saved}
          aria-label={saved ? `Remove ${name} from bookmarks` : `Bookmark ${name}`}
          title={saved ? 'Remove bookmark' : 'Bookmark this asset'}
          className={cn(
            'absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-[rgba(10,10,10,0.66)] backdrop-blur transition-colors duration-150 ease-standard',
            saved
              ? 'border-heat-40 text-brand'
              : 'text-ink-dim hover:border-hairline-strong hover:text-ink',
          )}
        >
          <HeartIcon filled={saved} />
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-2 px-4 py-4">
        <div className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-faint">
          {collection}
        </div>

        <h3 className="text-[14.5px] font-semibold leading-[1.35] tracking-[-0.008em] text-ink">
          <Link
            href={href}
            className="transition-colors duration-150 ease-standard hover:text-brand-warm"
          >
            {name}
          </Link>
        </h3>

        {status ? <div className="mt-0.5">{<StatusChip status={status} />}</div> : null}
      </div>

      {/*
        The footer is a two-column row, never wrapping: a card whose action button drops to a second
        line because its triangle count is long makes a grid look ragged, and the reader reads the
        raggedness as a rendering fault rather than as a long number. The figure truncates instead —
        it is the one of the two that can be shortened without losing its meaning, and the full value
        is on `title`.
      */}
      <div className="mt-auto grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 border-t border-hairline px-4 py-3">
        <span className="flex min-w-0 flex-col">
          <b
            className="truncate font-mono text-[14px] font-medium text-ink"
            title={figure ?? `${formatNumber(polycount)} tris`}
          >
            {figure ?? `${formatNumber(polycount)} tris`}
          </b>
          <span className="truncate font-mono text-[11px] text-ink-faint">
            {figureSub ?? bytes ?? 'not measured'}
          </span>
        </span>
        <div className="flex items-center gap-2">
          {onEdit ? (
            <button
              type="button"
              onClick={onEdit}
              className="shrink-0 rounded-control border border-hairline-strong bg-veil-6 px-3 py-1.5 text-[13px] font-semibold text-ink transition-colors duration-150 ease-standard hover:bg-veil-12"
            >
              Edit
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              onClick={onDelete}
              className="shrink-0 rounded-control border border-heat-40/30 bg-heat-40/10 px-3 py-1.5 text-[13px] font-semibold text-heat-40 transition-colors duration-150 ease-standard hover:bg-heat-40/20"
            >
              Delete
            </button>
          ) : null}
          {action ?? (
            <Link
              href={href}
              className="shrink-0 rounded-control border border-veil-8 bg-veil-6 px-3 py-1.5 text-[13px] font-semibold text-ink transition-colors duration-150 ease-standard hover:bg-veil-12"
            >
              Open model
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}


/* ------------------------------------------------------------------------ filter rail */

/**
 * The rail.
 *
 * Delegates to `ui/rail` — one selection per group, and clicking the selected row clears it, which is
 * how a marketplace behaves and, more importantly, the only way to undo a filter without hunting for a
 * reset control. The row is a button rather than a checkbox input because it is not a form: nothing is
 * submitted, and `role="checkbox"` on a control that re-queries a table would be a lie about what it
 * does.
 */
export function FilterRail({ groups }: { readonly groups: readonly RailGroup[] }) {
  return <UiFilterRail groups={groups} />;
}

/* ------------------------------------------------------------------------ toolbar */

/**
 * The strip above a grid: a search field, whatever controls the screen needs, and a result count on the
 * right. One row, so it reads as chrome rather than three separate widgets.
 */
export function Toolbar({
  search,
  onSearch,
  placeholder = 'Search',
  children,
  count,
}: {
  readonly search: string;
  readonly onSearch: (next: string) => void;
  readonly placeholder?: string;
  readonly children?: React.ReactNode;
  readonly count?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <SearchField
        label={placeholder}
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        className="min-w-[220px] flex-1"
      />

      {children}

      {count === undefined ? null : (
        <span className="ml-auto font-mono text-[12.5px] text-ink-faint" aria-live="polite">
          {count}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ events */

export type EventKind = 'ok' | 'wait' | 'escalate' | 'fail' | 'chain' | 'plain';

/**
 * Which family an audit action belongs to.
 *
 * Derived from the action name rather than from a hand-maintained table, because the ledger is written
 * by the API and the worker — a table here would silently fall out of date the first time an action is
 * added. The name is the contract; this reads it.
 */
export function eventKind(action: string): EventKind {
  if (/failed$|rejected|revoked|deleted|removed$|suspended/.test(action)) return 'fail';
  if (action.startsWith('chain.')) return 'chain';
  if (action.startsWith('ai.')) return 'escalate';
  if (/approved|published|pinned|accepted|completed|minted|adopted|linked/.test(action)) return 'ok';
  if (/submitted|requested|manual_review|invited|revision/.test(action)) return 'wait';
  return 'plain';
}

/** `asset.publish_requested` → `Publish requested`. Sentence case, per the voice rules. */
export function eventLabel(action: string): string {
  const [namespace, ...rest] = action.split('.');
  const words = (rest.length > 0 ? rest.join(' ') : namespace ?? action).replace(/_/g, ' ').trim();
  if (words.length === 0) return action;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The hue a kind of event is drawn in.
 *
 * Written as literal classes rather than built from a variable, because Tailwind has to see the string
 * at build time to emit the rule — a template literal assembled at runtime produces a chip with no
 * colour and no error, which is the worst possible failure mode.
 */
const EVENT_CLASS: Record<EventKind, string> = {
  ok: 'border-state-published text-state-published',
  wait: 'border-state-pending text-state-pending',
  escalate: 'border-state-review text-state-review',
  fail: 'border-state-rejected text-state-rejected',
  chain: 'border-heat-40 text-brand-warm',
  plain: 'border-hairline-strong text-ink-dim',
};

/** An event, as a typed chip: colour plus a word, never colour alone. */
export function EventChip({ action }: { readonly action: string }) {
  const kind = eventKind(action);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-[3px] text-[11.5px]',
        EVENT_CLASS[kind],
      )}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {eventLabel(action)}
    </span>
  );
}

/* ------------------------------------------------------------------------ people */

/**
 * A person cell: initials, name, and one mono line of context.
 *
 * Delegates to `ui/avatar`, which picks the hue by hashing the name — so the same person keeps the same
 * colour on every screen without anyone maintaining a map, and the palette deliberately avoids the
 * lifecycle states, because a person is not a status.
 */
export function PersonCell({
  name,
  sub,
  compact = false,
}: {
  readonly name: string;
  readonly sub?: string;
  readonly compact?: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Avatar name={name} size={compact ? 'sm' : 'md'} />
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-semibold text-ink">{name}</span>
        {sub ? (
          <span className="block truncate font-mono text-[11px] text-ink-faint">{sub}</span>
        ) : null}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------------ empty */

/** An empty state, delegating to `ui/feedback` so the console and the catalogue say it the same way. */
export function EmptyBlock({
  title,
  hint,
  action,
}: {
  readonly title: string;
  readonly hint: string;
  readonly action?: React.ReactNode;
}) {
  return <EmptyState title={title} hint={hint} action={action} />;
}

/** Kept exported because the review screen prints the initials of an anonymous actor. */
export { initialsOf };

