import * as React from 'react';

import { cn } from '../../lib/cn';

/**
 * Tables.
 *
 * Split into five pieces rather than styled by element name, because a table's header, its rows and
 * its cells are three different concerns and each one has exactly one class list here. The wide
 * screens in this product are mostly tables, so getting the geometry right once matters: 12px mono
 * headers, 13.5px body, tabular figures, and a hairline under every row.
 *
 * Row hover lives on `TBody`, not on `TR`. A row can be in a head or a body, and `TR` cannot tell —
 * `TBody` owns the rows it contains, so it can tint only the ones a pointer can actually land on.
 */
export function Table({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full border-collapse text-[13.5px]">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  return <thead>{children}</thead>;
}

export function TBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <tbody
      className={cn(
        '[&>tr]:border-b [&>tr]:border-hairline [&>tr]:transition-colors [&>tr:hover]:bg-veil-4 [&>tr:last-child]:border-b-0',
        className,
      )}
    >
      {children}
    </tbody>
  );
}

export function TR({ children, className }: { children: React.ReactNode; className?: string }) {
  return <tr className={className}>{children}</tr>;
}

export function TH({
  children,
  align = 'left',
  className,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' }) {
  return (
    <th
      className={cn(
        'whitespace-nowrap border-b border-hairline px-4 py-2.5 font-mono text-[12px] font-normal tracking-[0.02em] text-ink-faint',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

export function TD({
  children,
  align = 'left',
  className,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' }) {
  return (
    <td
      className={cn(
        'px-4 py-3 align-middle tabular-nums',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
      {...props}
    >
      {children}
    </td>
  );
}

/** A table inside a card: full-bleed, with the card's border doing the framing. */
export function TableCard({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('overflow-hidden rounded-card border border-hairline bg-surface', className)}>
      {children}
    </div>
  );
}
