import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import type { AssetStatus } from '@void-space/types';

import { cn } from '../../lib/cn';

/**
 * A pill. Mono, 11px, and 999px radius — the smallest piece of the system, and the one that carries
 * state most often.
 *
 * Tones are semantic rather than decorative. `brand` is a claim the platform is making (a licence
 * type, a chain), `live` is something currently true, `warn` is something waiting, `danger` is
 * something refused. Nothing here is chosen for variety.
 */
export const chipVariants = cva(
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-[3px] font-mono text-[11px] leading-[1.5] tracking-[0.02em]',
  {
    variants: {
      tone: {
        neutral: 'border-hairline-strong bg-veil-4 text-ink-dim',
        brand: 'border-heat-40 bg-heat-4 text-brand-warm',
        /* State tones use the colour at full strength for both border and label. A softer border
           would need an opacity modifier, and the palette is a CSS variable — a modifier on a
           `var()` colour is silently dropped, which is how a chip ends up with no border at all. */
        live: 'border-state-published bg-veil-4 text-state-published',
        warn: 'border-state-pending bg-veil-4 text-state-pending',
        review: 'border-state-review bg-veil-4 text-state-review',
        danger: 'border-state-rejected bg-veil-4 text-state-rejected',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface ChipProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof chipVariants> {
  /** Draws a leading dot, so a state is legible without reading the word as well as with it. */
  readonly dot?: boolean;
}

export function Chip({ className, tone, dot = false, children, ...props }: ChipProps) {
  return (
    <span className={cn(chipVariants({ tone }), className)} {...props}>
      {dot ? <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

/**
 * The lifecycle state, named in exactly one place.
 *
 * `STATUS_LABEL` and `STATUS_VAR` are exported (as `STATUS_LABEL` and `statusColor`) so the Overview's
 * state grid and this pill cannot disagree about what `needs_manual_review` is called or what colour it
 * is. Every other module that needs a status name re-exports from here — a screen that re-typed these
 * would eventually drift, and the drift would be a screen telling an operator the wrong thing about
 * where a file is in the pipeline.
 */
export const STATUS_LABEL: Record<AssetStatus, string> = {
  draft: 'Draft',
  pending: 'In review',
  needs_manual_review: 'Manual review',
  approved: 'Approved',
  rejected: 'Rejected',
  revision: 'Needs changes',
  published: 'Published',
};

const STATUS_VAR: Record<AssetStatus, string> = {
  draft: 'var(--vs-draft)',
  pending: 'var(--vs-pending)',
  needs_manual_review: 'var(--vs-review)',
  approved: 'var(--vs-approved)',
  rejected: 'var(--vs-rejected)',
  revision: 'var(--vs-revision)',
  published: 'var(--vs-published)',
};

/** The CSS colour a lifecycle state is drawn in. For bars, dots and borders around a state's name. */
export function statusColor(status: AssetStatus): string {
  return STATUS_VAR[status];
}

export function statusLabel(status: AssetStatus): string {
  return STATUS_LABEL[status];
}

export function StatusChip({ status, className }: { status: AssetStatus; className?: string }) {
  const tone = STATUS_VAR[status];

  return (
    <span
      className={cn(chipVariants({ tone: 'neutral' }), className)}
      // `color-mix` rather than a hex-alpha suffix, so this keeps working if a state token is ever
      // redefined as an `rgb()` or an `oklch()` value rather than a hex string.
      style={{ borderColor: `color-mix(in srgb, ${tone} 45%, transparent)`, color: tone }}
      title={`Lifecycle state: ${STATUS_LABEL[status]}`}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: tone }} />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** A plain tag. Used for AI-suggested labels, which are deliberately *not* styled like a claim. */
export function Tag({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'brand';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px]',
        tone === 'brand'
          ? 'border border-heat-40 bg-heat-4 text-brand-warm'
          : 'bg-surface-raised text-ink-dim',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A row of chips that wraps without collapsing the gaps. */
export function ChipRow({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('flex flex-wrap items-center gap-1.5', className)}>{children}</div>;
}

/**
 * A chip that is also a control.
 *
 * A filter, not a label — so it is a `<button>` with `aria-pressed`, and the count sits inside it
 * because "Categories 6" and "Categories" are different amounts of information and the second one
 * makes the reader click to find out.
 */
export function FilterChip({
  selected = false,
  count,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  selected?: boolean;
  count?: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        'inline-flex items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1.5 text-[13px] transition-colors duration-150 ease-standard',
        selected
          ? 'border-heat-40 bg-heat-12 text-brand-warm'
          : 'border-hairline bg-surface text-ink-dim hover:border-hairline-strong hover:text-ink',
        className,
      )}
      {...props}
    >
      {children}
      {count === undefined ? null : (
        <span className="font-mono text-[11px] text-ink-faint">{count}</span>
      )}
    </button>
  );
}
