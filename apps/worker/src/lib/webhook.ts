/**
 * Outbound webhook delivery (SRS FR-11.4, NFR-REL.1).
 *
 * Fires a tenant's configured webhook on the same events as the in-app notifications. Until now
 * the `webhooks` table, the tenant settings form and the signing secret all existed, and nothing
 * ever sent a request — a configured webhook was stored and forgotten, which is the worst of the
 * available states because it looks like it works.
 *
 * Three decisions worth stating:
 *
 *  1. **A delivery failure never fails the caller.** NFR-REL.1 requires the core workflow to
 *     survive an unavailable external integration, and a webhook is exactly that: an external
 *     endpoint the platform does not control. Delivery is therefore attempted, logged, and
 *     dropped. A tenant's dead webhook must not stop a Creator from being told their asset was
 *     approved — the in-app notification is the system of record, the webhook is a copy.
 *
 *  2. **Every payload is signed.** The `secret` column was created for this. A receiver cannot
 *     otherwise tell a real delivery from anyone who learned the URL, and a webhook that cannot
 *     be authenticated is a data exfiltration path rather than an integration.
 *
 *  3. **No retry queue of its own.** The notify job already carries the §3.10 retry policy, and a
 *     second retry mechanism inside it would multiply attempts rather than share them. If this
 *     needs delivery guarantees later, the honest fix is a `webhook-deliver` queue with its own
 *     policy — not a hidden loop here.
 */
import { createHmac, randomUUID } from 'node:crypto';

import { withTenant } from '@void-space/db';
import type { Logger } from 'pino';

export interface WebhookRecord {
  readonly id: string;
  readonly url: string;
  readonly secret: string;
  readonly events: readonly string[];
}

export interface WebhookDelivery {
  readonly url: string;
  readonly ok: boolean;
  readonly status?: number;
  readonly error?: string;
}

export interface WebhookDeps {
  readonly logger: Logger;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /**
   * Where the tenant's active webhooks come from. The default reads `webhooks` through
   * `withTenant`, so the lookup is tenant-scoped by construction. It is injectable so the
   * delivery rules below — signing, filtering, failure handling — can be tested as the pure
   * functions they are, without a database.
   */
  readonly loadHooks?: (tenantId: string) => Promise<readonly WebhookRecord[]>;
}

/** The `X-Void-Space-Signature` header value for a payload. */
export function signPayload(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

/**
 * True when a webhook subscribed to this event.
 *
 * An empty `events` array means "everything", which is the useful default for a tenant that has
 * not narrowed its subscription yet.
 */
export function webhookWants(events: readonly string[], event: string): boolean {
  return events.length === 0 || events.includes(event);
}

/** Default lookup: the tenant's active endpoints, read inside a tenant-scoped transaction. */
async function loadHooksFromDb(tenantId: string): Promise<readonly WebhookRecord[]> {
  return withTenant(tenantId, (db) =>
    db.webhook.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, url: true, secret: true, events: true },
    }),
  );
}

export function createWebhookDispatcher(deps: WebhookDeps) {
  const sender = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 5_000;
  const loadHooks = deps.loadHooks ?? loadHooksFromDb;

  /**
   * Delivers one event to every matching webhook in the tenant.
   *
   * Returns a per-endpoint outcome rather than throwing, so the caller can log a partial
   * success. A tenant with three webhooks where one is down is a real state.
   */
  return async function deliver(params: {
    readonly tenantId: string;
    readonly event: string;
    readonly payload: Record<string, unknown>;
  }): Promise<readonly WebhookDelivery[]> {
    const hooks = await loadHooks(params.tenantId);

    const subscribed = hooks.filter((hook) => webhookWants(hook.events, params.event));
    if (subscribed.length === 0) return [];

    const body = JSON.stringify({
      // The envelope is explicit so a receiver can route without inspecting the payload's shape.
      event: params.event,
      tenantId: params.tenantId,
      deliveryId: randomUUID(),
      occurredAt: new Date().toISOString(),
      data: params.payload,
    });

    return Promise.all(
      subscribed.map(async (hook): Promise<WebhookDelivery> => {
        try {
          const response = await sender(hook.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'user-agent': 'void-space-webhook/1.0',
              'x-void-space-event': params.event,
              'x-void-space-signature': signPayload(hook.secret, body),
            },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });

          if (!response.ok) {
            deps.logger.warn(
              { event: params.event, url: hook.url, status: response.status },
              'webhook rejected the delivery',
            );
          }
          return { url: hook.url, ok: response.ok, status: response.status };
        } catch (error) {
          // Logged, never rethrown — see the note at the top of this file.
          const message = error instanceof Error ? error.message : String(error);
          deps.logger.warn({ event: params.event, url: hook.url, err: message }, 'webhook failed');
          return { url: hook.url, ok: false, error: message };
        }
      }),
    );
  };
}
