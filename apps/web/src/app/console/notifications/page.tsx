'use client';

/**
 * Notification centre (SRS FR-12.1–FR-12.3, FR-11.3).
 *
 * A feed, in the order it arrived, with unread items marked by a word rather than by a colour alone.
 * The type is printed under each row because a notification whose payload is empty still has to say
 * what kind of thing happened — and "the title is missing" is information, not a reason to render a
 * blank row.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../../../lib/api';
import { formatNumber, formatRelative } from '../../../lib/format';
import { EmptyBlock, EventChip, PageHead } from '../../../components/console-kit';
import { Panel } from '../../../components/ui/card';
import { ErrorNote, LoadingBlock } from '../../../components/ui/feedback';

interface NotificationItem {
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly readAt: string | null;
  readonly createdAt: string;
}

/** Falls back to a readable label: seeded demo rows carry no title, only a type. */
function label(item: NotificationItem): string {
  const title = item.payload['title'];
  if (typeof title === 'string' && title.length > 0) return title;
  return item.type.replace(/[._]/g, ' ').toUpperCase();
}

function body(item: NotificationItem): string | null {
  const value = item.payload['body'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export default function NotificationsPage() {
  const queryClient = useQueryClient();

  const notifications = useQuery<{
    items: readonly NotificationItem[];
    unreadCount: number;
    total: number;
  }>({
    queryKey: ['notifications'],
    queryFn: () => apiFetch('/notifications?pageSize=50'),
  });

  async function markAllRead() {
    await apiFetch('/notifications/read', { method: 'POST', body: {} });
    await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    await queryClient.invalidateQueries({ queryKey: ['notifications', 'count'] });
  }

  const unread = notifications.data?.unreadCount ?? 0;

  return (
    <div className="space-y-7">
      <PageHead
        title="Alerts"
        meta={
          notifications.data
            ? `${formatNumber(unread)} unread · ${formatNumber(notifications.data.total)} total · the newest 50 are shown`
            : 'Querying'
        }
        actions={
          <button
            type="button"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12"
            disabled={unread === 0}
            onClick={() => void markAllRead()}
          >
            Mark all read
          </button>
        }
      />

      <Panel title="Event feed" right={unread > 0 ? `${unread} unread` : 'all read'}>
        {notifications.isLoading ? <LoadingBlock label="Loading alerts" /> : null}
        {notifications.error ? <ErrorNote message={(notifications.error as Error).message} /> : null}

        {notifications.data && notifications.data.items.length === 0 ? (
          <EmptyBlock
            title="No alerts"
            hint="Review decisions, publishes, failed mints and invitations all land here, so an empty feed means the workspace has been quiet."
          />
        ) : null}

        {notifications.data && notifications.data.items.length > 0 ? (
          <ul>
            {notifications.data.items.map((item) => (
              <li
                key={item.id}
                className="flex items-start justify-between gap-4 border-b px-5 py-4 last:border-b-0"
                style={{
                  borderColor: 'var(--vs-line)',
                  // Unread rows carry a hairline of heat on the leading edge as well as the word,
                  // so the state reads in a scan and is still legible without colour.
                  boxShadow: item.readAt ? undefined : 'inset 2px 0 0 0 var(--vs-accent)',
                }}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <EventChip action={item.type} />
                    {item.readAt ? null : <span className="font-mono text-[11px] text-brand">Unread</span>}
                  </div>
                  <div className="mt-1.5 text-[14px] font-medium">{label(item)}</div>
                  {body(item) ? (
                    <div
                      className="mt-1 max-w-[70ch] text-[13px] leading-relaxed"
                      style={{ color: 'var(--vs-fg-dim)' }}
                    >
                      {body(item)}
                    </div>
                  ) : null}
                  <div className="font-mono text-[11.5px] tracking-[0.01em] tabular-nums text-ink-faint mt-2">{item.type}</div>
                </div>
                <span className="font-mono text-[12px] text-ink-dim whitespace-nowrap">{formatRelative(item.createdAt)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
    </div>
  );
}
