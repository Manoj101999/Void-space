import { z } from 'zod';
import { booleanishSchema, paginationQuerySchema } from './common';

/** FR-11.3: notification centre list + unread count for the UI header. */
export const notificationListQuerySchema = paginationQuerySchema.extend({
  unreadOnly: booleanishSchema.default(false),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

export const markNotificationsReadSchema = z.object({
  /** Omit to mark every unread notification as read. */
  ids: z.array(z.string().uuid()).optional(),
});
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadSchema>;

export interface NotificationSummary {
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly readAt: string | null;
  readonly createdAt: string;
}

export interface NotificationCenter {
  readonly items: readonly NotificationSummary[];
  readonly unreadCount: number;
}
