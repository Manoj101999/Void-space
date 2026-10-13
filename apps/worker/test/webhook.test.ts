/**
 * Outbound webhook delivery (SRS FR-11.4, NFR-REL.1).
 *
 * The properties under test are the ones that make a webhook safe to switch on: the payload is
 * signed with the tenant's secret, a subscription is honoured, and **a failing endpoint never
 * fails the caller**. That last one is NFR-REL.1, and it is the reason delivery lives in its own
 * module rather than inline in the notify processor.
 *
 * `loadHooks` is injected, so these stay unit tests in the same style as the rest of this suite
 * — no Postgres, no HTTP server.
 */
import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  createWebhookDispatcher,
  signPayload,
  webhookWants,
  type WebhookRecord,
} from '../src/lib/webhook';

/** A logger that records nothing but satisfies the interface. */
function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

function hook(overrides: Partial<WebhookRecord> = {}): WebhookRecord {
  return {
    id: 'hook-1',
    url: 'https://receiver.test/hook',
    secret: 'shared-secret',
    events: [],
    ...overrides,
  };
}

describe('FR-11.4 webhook dispatch', () => {
  it('signs the body so a receiver can tell a real delivery from a forged one', () => {
    const secret = 'a-tenant-signing-secret';
    const body = JSON.stringify({ event: 'asset.published' });

    const signature = signPayload(secret, body);
    const expected = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

    expect(signature).toBe(expected);
    // A different secret must not produce the same signature — that is the whole point of it.
    expect(signPayload('another-secret', body)).not.toBe(signature);
  });

  it('treats an empty subscription as "everything", and filters otherwise', () => {
    expect(webhookWants([], 'asset.published')).toBe(true);
    expect(webhookWants(['asset.published'], 'asset.published')).toBe(true);
    expect(webhookWants(['asset.revoked'], 'asset.published')).toBe(false);
  });

  it('POSTs a signed envelope and reports success', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const dispatch = createWebhookDispatcher({
      logger: silentLogger(),
      fetchImpl,
      loadHooks: async () => [hook()],
    });

    const outcomes = await dispatch({
      tenantId: 'tenant-1',
      event: 'asset.published',
      payload: { assetId: 'abc', title: 'An asset was published' },
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.ok).toBe(true);
    expect(outcomes[0]?.status).toBe(200);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://receiver.test/hook');
    const init = calls[0]?.init as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-void-space-event']).toBe('asset.published');

    // The signature must verify against the bytes actually sent — a receiver recomputes it over
    // the raw body it received, so signing a re-serialised copy would not verify.
    const raw = init.body as string;
    expect(headers['x-void-space-signature']).toBe(signPayload('shared-secret', raw));

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.event).toBe('asset.published');
    expect(parsed.tenantId).toBe('tenant-1');
    expect(parsed.deliveryId).toBeDefined();
    expect(parsed.occurredAt).toBeDefined();
    expect((parsed.data as Record<string, unknown>).assetId).toBe('abc');
  });

  it('does not send to an endpoint that did not subscribe to the event', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const dispatch = createWebhookDispatcher({
      logger: silentLogger(),
      fetchImpl,
      loadHooks: async () => [hook({ events: ['asset.revoked'] })],
    });

    const outcomes = await dispatch({
      tenantId: 'tenant-1',
      event: 'asset.published',
      payload: {},
    });

    expect(outcomes).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('swallows a network failure, because the workflow must survive it (NFR-REL.1)', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const dispatch = createWebhookDispatcher({
      logger: silentLogger(),
      fetchImpl,
      loadHooks: async () => [hook()],
    });

    // Resolves with a failure record rather than throwing, so the notify job still completes and
    // the Creator is still told what happened to their asset.
    const outcomes = await dispatch({
      tenantId: 'tenant-1',
      event: 'asset.approved',
      payload: {},
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.error).toContain('ECONNREFUSED');
  });

  it('treats a non-2xx response as a failed delivery, not as success', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 500 })) as unknown as typeof fetch;

    const dispatch = createWebhookDispatcher({
      logger: silentLogger(),
      fetchImpl,
      loadHooks: async () => [hook()],
    });

    const outcomes = await dispatch({
      tenantId: 'tenant-1',
      event: 'asset.published',
      payload: {},
    });

    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.status).toBe(500);
  });

  it('sends to every subscribed endpoint and reports them individually', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = String(url);
      seen.push(target);
      // One healthy receiver, one unhappy one. A partial success is a real state, so the
      // dispatcher must not collapse them into a single boolean.
      return new Response('{}', { status: target.includes('broken') ? 503 : 200 });
    }) as unknown as typeof fetch;

    const dispatch = createWebhookDispatcher({
      logger: silentLogger(),
      fetchImpl,
      loadHooks: async () => [
        hook({ id: 'a', url: 'https://receiver.test/ok' }),
        hook({ id: 'b', url: 'https://receiver.test/broken' }),
      ],
    });

    const outcomes = await dispatch({
      tenantId: 'tenant-1',
      event: 'asset.published',
      payload: {},
    });

    expect(seen).toHaveLength(2);
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, false]);
  });

  it('sends nothing when the tenant has no endpoint configured', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const dispatch = createWebhookDispatcher({
      logger: silentLogger(),
      fetchImpl,
      loadHooks: async () => [],
    });

    expect(
      await dispatch({ tenantId: 'tenant-1', event: 'asset.published', payload: {} }),
    ).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

