import * as React from 'react';
import Link from 'next/link';

import { cn } from '../../lib/cn';
import { ArrowLeftIcon } from './icons';

/**
 * Layout.
 *
 * Two containers, because the two surfaces genuinely want different measures: the storefront reads as
 * prose and centres on a 1200px column, while an operations table of forty audit rows wants the width
 * and takes 1560px. Having both as named components means a screen says which one it is rather than
 * typing a magic `max-w-`.
 */
export function Container({
  wide = false,
  className,
  children,
}: {
  /** The console's measure. The storefront's is the default. */
  wide?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn('mx-auto w-full px-6', wide ? 'max-w-[1560px]' : 'max-w-[1200px]', className)}
    >
      {children}
    </div>
  );
}

/**
 * A section.
 *
 * The padding is the page's rhythm — 64px on a phone, 112px on a desktop — and it is set once here so
 * no two sections can disagree about the space between them. That single number is most of what makes
 * a long page feel composed rather than assembled.
 */
export function Section({
  band = false,
  className,
  children,
  id,
}: {
  /** Renders on the raised neutral, so consecutive sections do not run together. */
  band?: boolean;
  className?: string;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cn(band && 'border-y border-hairline bg-deeper', className)}
    >
      <Container className="py-16 md:py-28">{children}</Container>
    </section>
  );
}

/**
 * The opening of a section.
 *
 * `eyebrow` is a short noun phrase, not a sentence and not a numbered index — it is there to say what
 * kind of thing follows, in three words, so the heading below it can be a claim. `lead` is the one
 * sentence that has to survive being read alone.
 *
 * `aside` sits at the far end of the eyebrow row: a link, a count, anything the section wants to say
 * about itself without interrupting the heading.
 */
export function SectionHead({
  eyebrow,
  title,
  lead,
  aside,
  className,
}: {
  eyebrow?: string;
  title: string;
  lead?: string;
  aside?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('max-w-3xl', className)}>
      {eyebrow === undefined ? null : (
        <div className="mb-4 flex items-center gap-4">
          <span className="text-[12px] font-semibold uppercase tracking-[0.14em] text-brand">
            {eyebrow}
          </span>
          {aside === undefined ? null : (
            <span className="ml-auto text-[13px] text-ink-faint">{aside}</span>
          )}
        </div>
      )}

      <h2 className="text-balance text-[clamp(1.75rem,3.4vw,2.5rem)] font-semibold leading-[1.1] tracking-[-0.028em] text-ink">
        {title}
      </h2>

      {lead === undefined ? null : (
        <p className="mt-5 max-w-[62ch] text-[16px] leading-[1.7] text-ink-dim">{lead}</p>
      )}
    </header>
  );
}

/** A hairline rule that runs the full width of its container. Used to separate lists inside a section. */
export function Rule({ className }: { className?: string }) {
  return <div aria-hidden className={cn('h-px w-full bg-hairline', className)} />;
}

/**
 * A link back to the list a detail page was opened from.
 *
 * Carried as a component rather than typed per page because the arrow, the gap and the hover tone are
 * the same three decisions on every detail view, and a back link that sits half a pixel differently
 * on two screens is the kind of drift nobody fixes.
 */
export function BackLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex items-center gap-1.5 text-[13px] text-ink-faint transition-colors duration-150 ease-standard hover:text-ink',
        className,
      )}
    >
      <ArrowLeftIcon width={14} height={14} />
      {children}
    </Link>
  );
}
