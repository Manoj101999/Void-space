/**
 * `notify` processor (SRS FR-11.1–FR-11.3, §3.10).
 *
 * Turns domain events into in-app notifications. The queue exists so that notification
 * fan-out never blocks the request that caused it, and so a webhook/materialised
 * integration (§3.9) can be added later without touching the producing code.
 *
 * Every write is tenant-scoped, and recipients are resolved *inside* the tenant, so a
 * notification can never be delivered across a workspace boundary.
 */
import { withTenant } from '@void-space/db';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';

import {
  attemptOf,
  createJobContext,
  isTerminalFailure,
  type JobPayload,
} from '../lib/job-tracking';
import { createWebhookDispatcher } from '../lib/webhook';

export interface NotifyDeps {
  readonly logger: Logger;
  /** Injected in tests; omitted in production so the real fetch is used (FR-11.4). */
  readonly fetchImpl?: typeof fetch;
}

export interface NotifyJobData extends JobPayload {
  readonly event: string;
  readonly recipientIds?: readonly string[];
  readonly title?: string;
  readonly body?: string;
  /** Extra context merged into the notification payload (asset id, decision, …). */
  readonly metadata?: Record<string, unknown>;
}

export function createNotifyProcessor(deps: NotifyDeps) {
  // FR-11.4 — outbound webhooks fan out from the same event that produces the in-app
  // notification, so a tenant's integration cannot silently drift from what its users are told.
  const deliverWebhooks = createWebhookDispatcher({
    logger: deps.logger,
    fetchImpl: deps.fetchImpl,
  });

  return async function processNotify(job: Job<NotifyJobData>): Promise<Record<string, unknown>> {
    const tenantId = String(job.data.tenantId ?? '');
    const ctx = createJobContext({
      jobId: String(job.id),
      tenantId,
      queue: 'notify',
      payload: job.data,
      attempt: attemptOf(job),
      maxAttempts: job.opts.attempts ?? 1,
    });

    const { event, recipientIds, title, body, metadata } = job.data;
    if (!event) throw new Error('notify job is missing its event name');

    await ctx.markActive();

    try {
      const created = await withTenant(tenantId, async (db) => {
        const recipients =
          recipientIds && recipientIds.length > 0
            ? recipientIds
            : // With no explicit recipients, the people who can act on the event are the
              // ones who need to know: administrators and reviewers.
              (
                await db.user.findMany({
                  where: {
                    tenantId,
                    status: 'active',
                    roles: { some: { role: { name: { in: ['TenantAdmin', 'SuperAdmin'] } } } },
                  },
                  select: { id: true },
                  take: 50,
                })
              ).map((user) => user.id);

        if (recipients.length === 0) return 0;

        await db.notification.createMany({
          data: recipients.map((userId) => ({
            tenantId,
            userId,
            type: event,
            // The model stores one JSON payload; the UI renders title/body from it and
            // keeps the rest for deep links (asset id, decision, …).
            payload: {
              title: (title ?? defaultTitle(event)).slice(0, 200),
              body: (body ?? '').slice(0, 1000),
              event,
              ...(metadata ?? {}),
            } as never,
          })),
        });

        return recipients.length;
      });

      // FR-11.4 — the webhook runs after the in-app rows are committed, and outside the tenant
      // transaction: an external HTTP call inside a database transaction is how a slow third
      // party turns into a lock held for its timeout.
      //
      // Its outcome is reported but never thrown. See the note at the top of `lib/webhook.ts`
      // for why a dead endpoint must not fail the notification job (NFR-REL.1).
      const deliveries = await deliverWebhooks({
        tenantId,
        event,
        payload: {
          title: title ?? defaultTitle(event),
          body: body ?? '',
          entityType: job.data.entityType,
          entityId: job.data.entityId,
          ...(metadata ?? {}),
        },
      });

      const failed = deliveries.filter((delivery) => !delivery.ok).length;
      if (deliveries.length > 0) {
        deps.logger.info(
          { event, delivered: deliveries.length - failed, failed },
          'webhooks dispatched',
        );
      }

      await ctx.succeed({ recipients: created, event, webhooks: deliveries.length });
      deps.logger.info({ event, recipients: created }, 'notifications queued');

      return { recipients: created, webhooks: deliveries.length };
    } catch (error) {
      // Terminal when the policy is spent *or* the error is unrecoverable — see
      // isTerminalFailure, which also keeps the row out of a permanent "will retry".
      const terminal = isTerminalFailure(error, ctx);
      await ctx.fail(error, terminal);
      deps.logger.warn({ err: error, event, terminal }, 'notification fan-out failed');
      throw error;
    }
  };
}

/** Human-readable titles for the events the platform emits (FR-12.2). */
function defaultTitle(event: string): string {
  switch (event) {
    case 'asset.published':
      return 'An asset was published';
    case 'asset.revoked':
      return 'A licence was revoked';
    case 'asset.submitted':
      return 'An asset is waiting for review';
    case 'review.approved':
      return 'Your asset was approved';
    case 'review.rejected':
      return 'Your asset was rejected';
    case 'review.revision':
      return 'Changes were requested on your asset';
    case 'ai.enrichment_failed':
      return 'An asset needs manual classification';
    default:
      return 'Platform activity';
  }
}
