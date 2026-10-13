import * as React from 'react';

import { cn } from '../../lib/cn';

/**
 * The card: `surface` fill, 1px `hairline` border, 12px radius.
 *
 * Depth comes from tone and a hairline rather than from a glow, so a panel reads as raised on any
 * background without a shadow tuned to one. `overflow-hidden` is on the card rather than on the
 * header so a table or a media well inside it inherits the radius instead of squaring off the
 * corners it sits in.
 */
export function Card({ className, children, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn('overflow-hidden rounded-card border border-hairline bg-surface', className)}
      {...props}
    >
      {children}
    </section>
  );
}

/**
 * A card's title row.
 *
 * `right` is for a figure or a link — never prose. It is set in mono at the faint ink step so it
 * reads as metadata about the panel, not as a second heading competing with the first.
 */
export function CardHeader({
  title,
  right,
  className,
  children,
}: {
  title?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 border-b border-hairline px-5 py-3.5',
        className,
      )}
    >
      {title === undefined ? children : <h2 className="text-sm font-semibold text-ink">{title}</h2>}
      {right === undefined ? null : (
        <div className="font-mono text-[12px] text-ink-faint">{right}</div>
      )}
    </div>
  );
}

/** The card's content area. 20px of padding is the documented 24px minus the border's optical weight. */
export function CardBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('px-5 py-5', className)}>{children}</div>;
}

/** A full-bleed row inside a card, for a table or a list that should meet the card's edges. */
export function CardSection({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('border-t border-hairline', className)}>{children}</div>;
}

/**
 * A card with its heading row handled — the console's workhorse.
 *
 * `title` is required and `right` is reserved for a figure or a link, so a panel cannot quietly become
 * a differently-headed card. It delegates to `Card` and `CardHeader` rather than restating the border
 * and radius, which is what keeps a console panel and a storefront card the same object at the same
 * elevation.
 */
export function Panel({
  title,
  right,
  className,
  children,
}: {
  title: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={className}>
      <CardHeader title={title} right={right} />
      {children}
    </Card>
  );
}
