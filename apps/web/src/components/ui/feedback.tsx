import * as React from 'react';

import { cn } from '../../lib/cn';
import { CubeIcon } from './icons';

/**
 * Loading, failure and emptiness.
 *
 * There is no spinner anywhere in this product. A wheel tells a reader to wait; a skeleton in the
 * shape of the thing that is coming tells them what they are waiting for, and it is the only
 * animation in the console that runs unprompted. It is on the placeholder rather than on the content,
 * so nothing ever moves once there is something to read.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'animate-shimmer rounded-control bg-[linear-gradient(90deg,var(--fc-a-4)_0%,var(--fc-a-8)_50%,var(--fc-a-4)_100%)] bg-[length:200%_100%]',
        className ?? 'h-4 w-full',
      )}
    />
  );
}

/** The first frame of a screen: a label and three lines the shape of the content that is loading. */
export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="rounded-card border border-hairline bg-surface px-5 py-6" role="status">
      <div className="mb-4 text-[12px] font-semibold text-ink-faint">{label}</div>
      <div className="space-y-2.5">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </div>
  );
}

/**
 * A failure, in the words the reader needs.
 *
 * What happened, then what to do about it, then the code — in that order, because the code is for the
 * support thread and the sentence is for the person reading it now. `role="alert"` so it is announced
 * rather than merely displayed.
 */
export function ErrorNote({
  message,
  code,
  hint,
  className,
}: {
  message: string;
  code?: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        // A coloured rule on the leading edge rather than a coloured box: it reads as a margin note
        // and it avoids an alpha modifier on a `var()` colour, which Tailwind would silently drop.
        'rounded-card border border-hairline border-l-[3px] border-l-state-rejected bg-surface py-5 pl-[18px] pr-5',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-2 text-[13.5px] font-semibold text-state-rejected">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
          Failed
        </span>
        {code === undefined ? null : (
          <span className="font-mono text-[12px] text-ink-faint">{code}</span>
        )}
      </div>
      <p className="mt-3 max-w-[62ch] text-[13.5px] leading-relaxed text-ink">{message}</p>
      {hint === undefined ? null : (
        <p className="mt-2 max-w-[62ch] text-[13px] leading-relaxed text-ink-faint">{hint}</p>
      )}
    </div>
  );
}

/**
 * An empty state.
 *
 * The hint points at the first action rather than apologising: an empty catalogue is not a failure,
 * it is a catalogue nobody has published to yet, and the reader needs to know which of those it is.
 */
export function EmptyState({
  title,
  hint,
  action,
  className,
}: {
  title: string;
  hint: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-16 text-center', className)}>
      <CubeIcon className="text-ink-faint opacity-40" width={30} height={30} />
      <div className="mt-4 text-[17px] font-semibold tracking-[-0.015em] text-ink">{title}</div>
      <p className="mt-2 max-w-[46ch] text-[13.5px] leading-relaxed text-ink-faint">{hint}</p>
      {action === undefined ? null : (
        <div className="mt-6 flex flex-wrap justify-center gap-2">{action}</div>
      )}
    </div>
  );
}

/** A reading on a scale: an AI confidence, a completeness. Colour is applied by the caller. */
export function Meter({
  value,
  label,
  className,
}: {
  /** 0 to 1. */
  value: number;
  label?: string;
  className?: string;
}) {
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)));

  return (
    <div
      role="img"
      aria-label={label ?? `${percent}%`}
      className={cn('h-1 w-full overflow-hidden rounded-full bg-veil-8', className)}
    >
      <span
        className="block h-full rounded-full bg-current transition-[width] duration-300 ease-standard"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
