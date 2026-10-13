import * as React from 'react';

import { cn } from '../../lib/cn';

/**
 * Counters.
 *
 * A stat is a label, a figure and one line of context, and nothing else — no icon, no sparkline, no
 * delta. The figure is set in mono with tabular figures so a row of counters is a table you can read
 * down, which is the whole point of putting them next to each other.
 *
 * `StatGrid` draws its separators as the 1px gap between cells showing the hairline colour through,
 * rather than as borders. That is why the cells are opaque and the grid is not: one rule for the
 * divider instead of four, and no doubled lines where two cells meet.
 */
export function StatGrid({
  columns = 4,
  className,
  children,
}: {
  columns?: 2 | 3 | 4;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'grid gap-px bg-hairline',
        columns === 2 && 'grid-cols-2',
        columns === 3 && 'grid-cols-2 md:grid-cols-3',
        columns === 4 && 'grid-cols-2 md:grid-cols-4',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The one figure that is allowed a colour.
 *
 * `heat` is work waiting on a decision, `forest` is a healthy total, `honey` is something in flight.
 * Everything else is plain ink: a row of six tinted numbers is a dashboard nobody can read, and
 * DESIGN.md's rule is one heat element per view.
 */
export function Stat({
  label,
  value,
  hint,
  tone = 'plain',
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: 'plain' | 'heat' | 'forest' | 'honey';
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 bg-surface px-5 py-4 transition-colors duration-200 ease-standard hover:bg-surface-raised',
        className,
      )}
    >
      <span className="text-[12px] font-semibold text-ink-faint">{label}</span>
      <span
        className={cn(
          'font-mono text-[22px] leading-none tracking-[-0.02em]',
          tone === 'heat' && 'text-brand',
          tone === 'forest' && 'text-state-published',
          tone === 'honey' && 'text-state-pending',
          tone === 'plain' && 'text-ink',
        )}
      >
        {value}
      </span>
      {hint === undefined ? null : (
        <span className="font-mono text-[11px] leading-tight text-ink-faint">{hint}</span>
      )}
    </div>
  );
}

/** A single figure with no chrome, for a sidebar or a footer strip. */
export function InlineStat({
  label,
  value,
  className,
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4', className)}>
      <dt className="text-[12.5px] text-ink-faint">{label}</dt>
      <dd className="font-mono text-[12.5px] text-ink">{value}</dd>
    </div>
  );
}

/**
 * A histogram, drawn with divs so it stays crisp at any width and needs no chart library.
 *
 * The empty days are kept: a fortnight with a gap in it is a different fact from a fortnight without
 * one, and a chart that silently omits its zeros cannot show that. The tone difference between a used
 * day and an empty one is what makes the gap legible — which is also why the tallest bar scales to the
 * container rather than to a printed axis: the shape is the reading, and the totals beside it are the
 * numbers.
 */
export function Sparkbars({
  data,
  className,
}: {
  data: readonly { day: string; count: number }[];
  className?: string;
}) {
  const max = Math.max(1, ...data.map((point) => point.count));
  const total = data.reduce((sum, point) => sum + point.count, 0);

  return (
    <div className={cn('px-5 py-5', className)}>
      <div className="flex h-20 items-end gap-[3px]">
        {data.map((point) => (
          <div
            key={point.day}
            title={`${point.day}: ${point.count} ingested`}
            className={cn('flex-1 rounded-t-[3px]', point.count > 0 ? 'bg-brand' : 'bg-veil-8')}
            style={{ height: `${Math.max(4, (point.count / max) * 100)}%` }}
          />
        ))}
      </div>
      <div className="mt-3 font-mono text-[11.5px] text-ink-faint">
        {total} ingested across {data.length} days · busiest day {max}
      </div>
    </div>
  );
}
