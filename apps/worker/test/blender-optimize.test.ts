/**
 * `blender-optimize` processor (SRS FR-6.3).
 *
 * Two behaviours matter here, and they pull in opposite directions:
 *
 *  1. **With a runner configured**, a derivative must be recorded as a real version — bytes staged
 *     for the pin job, and the polycount the runner measured.
 *  2. **Without one**, the processor must still complete *and must say so*. A simulated derivative
 *     that claimed a triangle count would be a fabricated measurement in a product whose entire
 *     claim is that its measurements are real. That is why the assertion on `polycount === null`
 *     below is the most important line in this file.
 *
 * The database is the real one, because the thing worth checking is the *shape of the row* —
 * `isDerivative`, `derivativeOfVersionId`, a null staging path — and a mock would let all three be
 * wrong while the test passed.
 *
 * Expect `[jobs] no row for … — bookkeeping skipped` on stderr. These jobs are constructed here
 * rather than enqueued, so there is no `jobs` row for the context to mirror into, and
 * `lib/job-tracking` treats a missing subject as an obsolete job rather than a crash — which is its
 * documented behaviour and is worth seeing once.
 */
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { withPlatform, withTenant } from '@void-space/db';

import { createBlenderOptimizeProcessor } from '../src/processors/blender-optimize';

/** The workspace the seed puts the demo catalogue in. Resolved by slug, not by a derived id. */
let AURORA = '';
let jobDir = '';

beforeAll(async () => {
  const tenant = await withPlatform((db) =>
    db.tenant.findUnique({ where: { slug: 'aurora-industrial' }, select: { id: true } }),
  );
  if (!tenant) throw new Error('Seed the database first (pnpm db:seed) — Aurora not found');
  AURORA = tenant.id;
  jobDir = `/tmp/vs-blender-test-${process.pid}`;
});

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

/** A seeded version that still has its staged file, which is what the processor consumes. */
async function aVersion(): Promise<{
  assetId: string;
  versionId: string;
  stagingPath: string;
  versionNumber: number;
}> {
  const row = await withTenant(AURORA, (db) =>
    db.assetVersion.findFirst({
      where: { tenantId: AURORA, stagingPath: { not: null }, isDerivative: false },
      select: { id: true, assetId: true, stagingPath: true, versionNumber: true },
      orderBy: { versionNumber: 'desc' },
    }),
  );
  if (!row?.stagingPath) throw new Error('No staged, non-derivative version found in the seed');
  return {
    assetId: row.assetId,
    versionId: row.id,
    stagingPath: row.stagingPath,
    versionNumber: row.versionNumber,
  };
}

/** Removes the derivatives a test created, so a run leaves the fixtures as it found them. */
async function dropDerivatives(assetId: string, aboveVersionNumber: number): Promise<void> {
  await withTenant(AURORA, (db) =>
    db.assetVersion.deleteMany({
      where: { assetId, isDerivative: true, versionNumber: { gt: aboveVersionNumber } },
    }),
  );
}

/**
 * A job object carrying only the fields the processor reads.
 *
 * The id is a real UUID because `createJobContext` mirrors the job into the `jobs` table, whose
 * primary key is a UUID column — and in production it is one too, since the API generates ids with
 * `randomUUID()` before enqueueing. A readable `test-…` id would only be testing a state that
 * cannot occur.
 */
function jobFor(data: Record<string, unknown>) {
  return {
    id: randomUUID(),
    data: { tenantId: AURORA, ...data },
    opts: { attempts: 2 },
    attemptsMade: 0,
  } as never;
}


describe('FR-6.3 blender-optimize', () => {
  it('records a real derivative from what the runner reports', async () => {
    const version = await aVersion();

    // Capture the request so the *contract with the runner* can be asserted, not just the outcome.
    // The previous version of this test ignored the body entirely, which is why it passed while the
    // worker was sending absolute paths into a container that had mounted the same volume elsewhere.
    let sentBody: { input?: string; output?: string } = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body)) as typeof sentBody;
      return new Response(
        JSON.stringify({
          ok: true,
          output: 'out.glb',
          format: 'glb',
          trianglesBefore: 120_000,
          trianglesAfter: 48_210,
          budget: 50_000,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const process = createBlenderOptimizeProcessor({
      logger: silentLogger(),
      runnerUrl: 'http://blender-runner:8090',
      jobDir,
      fetchImpl,
    });

    try {
      const outcome = await process(
        jobFor({
          assetId: version.assetId,
          assetVersionId: version.versionId,
          stagedPath: version.stagingPath,
          polycountBudget: 50_000,
        }),
      );

      expect(outcome.simulated).toBe(false);

      /*
       * The runner resolves `input` and `output` against *its own* job directory, so these must be
       * bare filenames. A path here means the two containers are coupled to a shared mount point
       * again — which is the defect this assertion exists to prevent, because it fails silently:
       * the runner answers 400 and the job only ever fails on a real, non-simulated run.
       */
      expect(sentBody.input).toBeTruthy();
      expect(sentBody.output).toBeTruthy();
      for (const value of [sentBody.input, sentBody.output]) {
        expect(value).not.toContain('/');
        expect(value).not.toContain('..');
      }
      // Still names the file the worker will read back from its own job directory.
      expect(sentBody.output).toBe(`${version.versionId}-optimized.glb`);
      expect(sentBody.input).toBe(`${version.versionId}-source${extname(version.stagingPath)}`);

      const created = await withTenant(AURORA, (db) =>
        db.assetVersion.findUnique({
          where: { id: outcome.derivativeVersionId as string },
          select: {
            isDerivative: true,
            derivativeOfVersionId: true,
            polycount: true,
            format: true,
            stagingPath: true,
            pinStatus: true,
            meshMetadata: true,
          },
        }),
      );

      // The two columns that make it a derivative — the reason FR-6.3 needed a processor rather
      // than a second way to upload a file.
      expect(created?.isDerivative).toBe(true);
      expect(created?.derivativeOfVersionId).toBe(version.versionId);
      // The figure comes from the runner, not from the source version.
      expect(created?.polycount).toBe(48_210);
      expect(created?.format).toBe('.glb');
      // Staged for the pin job, because bytes exist.
      expect(created?.stagingPath).toBeTruthy();
      expect(created?.pinStatus).toBe('pending');
      expect((created?.meshMetadata as Record<string, unknown>).simulated).toBe(false);
    } finally {
      await dropDerivatives(version.assetId, version.versionNumber);
    }
  });

  it('without a runner, completes but invents no measurement and no bytes', async () => {
    const version = await aVersion();

    const process = createBlenderOptimizeProcessor({
      logger: silentLogger(),
      runnerUrl: undefined,
      jobDir,
    });

    try {
      const outcome = await process(
        jobFor({
          assetId: version.assetId,
          assetVersionId: version.versionId,
          stagedPath: version.stagingPath,
        }),
      );

      expect(outcome.simulated).toBe(true);

      const created = await withTenant(AURORA, (db) =>
        db.assetVersion.findUnique({
          where: { id: outcome.derivativeVersionId as string },
          select: { polycount: true, stagingPath: true, sizeBytes: true, meshMetadata: true },
        }),
      );

      // The whole product claim is that its figures are measured. A simulated run reporting a
      // triangle count would be the single worst bug this file could fail to catch.
      expect(created?.polycount).toBeNull();
      // No bytes, so nothing is staged and no CID will ever be pinned for this version.
      expect(created?.stagingPath).toBeNull();
      expect(created?.sizeBytes).toBe(0n);
      expect((created?.meshMetadata as Record<string, unknown>).simulated).toBe(true);
    } finally {
      await dropDerivatives(version.assetId, version.versionNumber);
    }
  });

  it('marks the simulation in the audit log, so the ledger cannot be misread', async () => {
    const version = await aVersion();

    const process = createBlenderOptimizeProcessor({
      logger: silentLogger(),
      runnerUrl: undefined,
      jobDir,
    });

    try {
      const outcome = await process(
        jobFor({
          assetId: version.assetId,
          assetVersionId: version.versionId,
          stagedPath: version.stagingPath,
        }),
      );

      const audit = await withTenant(AURORA, (db) =>
        db.auditLog.findFirst({
          where: { entityType: 'assetVersion', entityId: outcome.derivativeVersionId as string },
          select: { action: true, actorLabel: true, afterState: true },
        }),
      );

      expect(audit?.action).toBe('asset.optimized');
      expect(audit?.actorLabel).toBe('worker:blender-optimize');
      expect((audit?.afterState as Record<string, unknown>).simulated).toBe(true);
    } finally {
      await dropDerivatives(version.assetId, version.versionNumber);
    }
  });

  it('fails the job when the runner refuses, rather than recording a bad derivative', async () => {
    const version = await aVersion();

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'not a .blend file' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const process = createBlenderOptimizeProcessor({
      logger: silentLogger(),
      runnerUrl: 'http://blender-runner:8090',
      jobDir,
      fetchImpl,
    });

    try {
      await expect(
        process(
          jobFor({
            assetId: version.assetId,
            assetVersionId: version.versionId,
            stagedPath: version.stagingPath,
          }),
        ),
      ).rejects.toThrow(/not a \.blend file/);
    } finally {
      // A refused run must leave nothing behind.
      await dropDerivatives(version.assetId, version.versionNumber);
    }
  });

  it('rejects a job missing its identifiers, without touching the database', async () => {
    const process = createBlenderOptimizeProcessor({
      logger: silentLogger(),
      runnerUrl: undefined,
      jobDir,
    });

    await expect(process(jobFor({ assetId: 'incomplete' }))).rejects.toThrow(
      /needs assetId, assetVersionId and stagedPath/,
    );
  });
});

