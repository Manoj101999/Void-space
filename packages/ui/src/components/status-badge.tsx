import { ASSET_STATUS_LABELS, type AssetStatus } from '@void-space/types';
import * as React from 'react';
import { cn } from '../lib/cn';

const STATUS_STYLES: Record<AssetStatus, string> = {
  draft: 'bg-status-draft/15 text-status-draft border-status-draft/30',
  pending: 'bg-status-pending/15 text-status-pending border-status-pending/30',
  needs_manual_review: 'bg-status-review/15 text-status-review border-status-review/30',
  approved: 'bg-status-approved/15 text-status-approved border-status-approved/30',
  rejected: 'bg-status-rejected/15 text-status-rejected border-status-rejected/30',
  revision: 'bg-status-revision/15 text-status-revision border-status-revision/30',
  published: 'bg-status-published/15 text-status-published border-status-published/30',
};

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: AssetStatus;
}

/** Status pill for the asset grid and detail views (§6.1). */
export function StatusBadge({ status, className, ...props }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
        STATUS_STYLES[status],
        className,
      )}
      {...props}
    >
      {ASSET_STATUS_LABELS[status]}
    </span>
  );
}
