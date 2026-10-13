'use client';

/**
 * Copy-to-clipboard for the identifiers this platform is full of.
 *
 * CIDs, transaction hashes, token ids and addresses are all things people need *out* of the
 * interface — to verify on a block explorer, paste into a bug report, or hand to a modeller. Until
 * now they had to select 60-character strings by hand.
 *
 * The confirm state is a word, not a colour: DESIGN.md is explicit that state must never be
 * signalled by colour alone, and a button that silently turns green is exactly that.
 */
import { useCallback, useState } from 'react';

import { useToast } from './toast';

export function CopyButton({
  value,
  label,
  compact = false,
}: {
  value: string | null | undefined;
  /** What is being copied, used in the confirmation. e.g. "CID". */
  label: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  const copy = useCallback(async () => {
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${label} copied`, value.length > 42 ? `${value.slice(0, 42)}…` : value);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard access needs a secure context and permission; the dashboard is served over https
      // but a browser policy can still refuse, so say so rather than pretending it worked.
      toast.failure(
        `Could not copy the ${label.toLowerCase()}`,
        'Your browser blocked clipboard access — select the value and copy it manually.',
      );
    }
  }, [value, label, toast]);

  return (
    <button
      type="button"
      className={compact ? 'inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12 h-8 px-3 text-[13px] text-ink-dim hover:bg-veil-6 hover:text-ink' : 'inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12 border-hairline-strong bg-transparent text-ink-dim hover:bg-veil-6 hover:text-ink'}
      onClick={() => void copy()}
      disabled={!value}
      aria-label={`Copy ${label.toLowerCase()}`}
      title={value ? `Copy ${label.toLowerCase()}` : 'Nothing to copy yet'}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
