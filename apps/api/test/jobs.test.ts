/**
 * FR-6.5 — asynchronous job status polling.
 *
 *   GET /api/v1/jobs/{id}
 *
 * The `jobs` table has been written since the async platform landed, but this endpoint did not
 * exist, so a caller handed a job id — the publish response returns `chainLicenseJobId` for
 * exactly this purpose — had no way to poll it.
 *
 * Two behaviours carry the weight here: the queue name comes back in §3.10 vocabulary rather
 * than the Prisma enum spelling, and a job on an asset the caller cannot read is a **404**. The
 * endpoint must not become an existence oracle for another workspace's work.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '@void-space/db';

import {
  DEMO,
  DEMO_TENANT_IDS,
  cookieHeader,
  createTestApp,
  login,
  type TestApp,
} from './helpers';

let context: TestApp;

beforeAll(async () => {
  context = await createTestApp();
});

afterAll(async () => {
  await context?.close();
});

/** Polls a job as a demo user and returns the raw response. */
async function poll(
  email: string,
  id: string,
): Promise<{ statusCode: number; body: Record<string, unknown>; headers: Record<string, unknown> }> {
  const session = await login(context.app, email);
  const response = await context.app.inject({
    method: 'GET',
    url: `/api/v1/jobs/${id}`,
    headers: { cookie: cookieHeader(session.cookies, 'vs_access', 'vs_refresh') },
  });
  return {
    statusCode: response.statusCode,
    body: response.json() as Record<string, unknown>,
    headers: response.headers as Record<string, unknown>,
  };
}

/** Inserts a job row directly: the point is the read path, not how the job got there. */
async function seedJob(params: {
  readonly tenantId: string;
  readonly queue: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly status?: string;
}): Promise<string> {
  const id = randomUUID();
  await withTenant(params.tenantId, (db) =>
    db.job.create({
      data: {
        id,
        tenantId: params.tenantId,
        queue: params.queue as never,
        status: (params.status ?? 'active') as never,
        entityType: params.entityType,
        entityId: params.entityId,
        payload: {} as never,
        maxAttempts: 3,
      },
    }),
  );
  return id;
}

async function dropJob(tenantId: string, id: string): Promise<void> {
  await withTenant(tenantId, (db) => db.job.delete({ where: { id } }));
}


describe('FR-6.5 job status polling', () => {
  it('returns the §3.10 queue name, not the database enum spelling', async () => {
    const tenantId = DEMO_TENANT_IDS.aurora;
    // The column stores `chain_license`; the API must speak `chain-license` — the same token the
    // enqueue response and the SRS §3.10 table use.
    const id = await seedJob({ tenantId, queue: 'chain_license', entityType: null, entityId: null });
    try {
      const { statusCode, body } = await poll(DEMO.users.auroraCreator, id);

      expect(statusCode).toBe(200);
      expect(body.queue).toBe('chain-license');
      expect(body.status).toBe('active');
      expect(body.inProgress).toBe(true);
      expect(body.maxAttempts).toBe(3);
      // The internal job envelope is not on the wire.
      expect(JSON.stringify(body)).not.toContain('tenantId');
    } finally {
      await dropJob(tenantId, id);
    }
  });

  it('tells an in-progress job to retry, then stops once it is terminal', async () => {
    const tenantId = DEMO_TENANT_IDS.aurora;

    const running = await seedJob({
      tenantId,
      queue: 'ai_enrichment',
      entityType: null,
      entityId: null,
    });
    const done = await seedJob({
      tenantId,
      queue: 'ipfs_pin',
      entityType: null,
      entityId: null,
      status: 'completed',
    });

    try {
      // Retry-After is the same header FR-12.4 uses for its 429, so a client that already
      // honours rate limits needs no new code to honour this.
      const inFlight = await poll(DEMO.users.auroraCreator, running);
      expect(inFlight.headers['retry-after']).toBe('2');

      const finished = await poll(DEMO.users.auroraCreator, done);
      expect(finished.statusCode).toBe(200);
      expect(finished.body.inProgress).toBe(false);
      expect(finished.headers['retry-after']).toBeUndefined();
    } finally {
      await dropJob(tenantId, running);
      await dropJob(tenantId, done);
    }
  });

  it("treats another workspace's job as absent, not as forbidden", async () => {
    // A Northwind job, polled by an Aurora admin who holds every permission Aurora grants.
    const id = await seedJob({
      tenantId: DEMO_TENANT_IDS.northwind,
      queue: 'ipfs_pin',
      entityType: null,
      entityId: null,
    });

    try {
      const { statusCode } = await poll(DEMO.users.auroraAdmin, id);
      // 404 rather than 403: confirming that the id exists somewhere would itself be the leak.
      expect(statusCode).toBe(404);
    } finally {
      await dropJob(DEMO_TENANT_IDS.northwind, id);
    }
  });

  it('hides a job on an asset the caller has no business reading', async () => {
    const tenantId = DEMO_TENANT_IDS.aurora;

    // An asset in a state only its owner and reviewers may see.
    const asset = await withTenant(tenantId, (db) =>
      db.asset.findFirst({ where: { tenantId, status: 'draft' }, select: { id: true } }),
    );
    if (!asset) throw new Error('Seed the database first (pnpm db:seed) — no draft asset found');

    const id = await seedJob({
      tenantId,
      queue: 'ipfs_pin',
      entityType: 'asset',
      entityId: asset.id,
    });

    try {
      // A Viewer holds `catalog:view` and nothing else. It may call GET endpoints, but a draft is
      // not in its catalogue, so the job behind that draft must not be either.
      const hidden = await poll(DEMO.users.auroraViewer, id);
      expect(hidden.statusCode).toBe(404);

      // An Assessor can see the draft, so the same id resolves for them.
      const visible = await poll(DEMO.users.auroraAssessor, id);
      expect(visible.statusCode).toBe(200);
    } finally {
      await dropJob(tenantId, id);
    }
  });

  it('requires a credential and a well-formed id', async () => {
    const anonymous = await context.app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${randomUUID()}`,
    });
    expect(anonymous.statusCode).toBe(401);

    const creator = await login(context.app, DEMO.users.auroraCreator);
    const malformed = await context.app.inject({
      method: 'GET',
      url: '/api/v1/jobs/not-a-uuid',
      headers: { cookie: cookieHeader(creator.cookies, 'vs_access', 'vs_refresh') },
    });
    // Rejected at the edge of the handler rather than reaching a database lookup.
    expect(malformed.statusCode).toBe(400);
  });
});

