import * as React from 'react';

import { cn } from '../../lib/cn';

/**
 * People.
 *
 * An avatar is initials on a coloured disc. The hue is chosen by hashing the name, so the same person
 * keeps the same colour on every screen without anyone maintaining a map — and it is a *literal* hex
 * applied as an inline style rather than a Tailwind class, because "pick one of six by hash" cannot be
 * expressed as a static class without a safelist, and a safelist is a build step nobody will remember
 * to update.
 *
 * The palette deliberately avoids the lifecycle states: a person is not a status.
 */
const AVATAR_TONES = ['#fa5d19', '#2a6dfb', '#42c366', '#9061ff', '#ecb730', '#eb3424'] as const;

export function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '·';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) % 100_000;
  }
  const tone = AVATAR_TONES[hash % AVATAR_TONES.length];

  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold tracking-[0.02em] text-white',
        size === 'sm' ? 'h-6 w-6 text-[10px]' : 'h-8 w-8 text-[11.5px]',
        className,
      )}
      style={{ background: tone }}
    >
      {initialsOf(name)}
    </span>
  );
}

/**
 * A name with a face and one line of context.
 *
 * `sub` is mono because it is always an identifier or a timestamp — an email, a role list, "5m ago" —
 * and never a sentence. Prose belongs in a paragraph, not in a table cell.
 */
export function PersonCell({
  name,
  sub,
  size = 'md',
  className,
}: {
  name: string;
  sub?: React.ReactNode;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <Avatar name={name} size={size} />
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-semibold text-ink">{name}</span>
        {sub === undefined ? null : (
          <span className="block truncate font-mono text-[11px] text-ink-faint">{sub}</span>
        )}
      </span>
    </span>
  );
}
