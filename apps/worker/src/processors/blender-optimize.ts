/**
 * `blender-optimize` processor (SRS FR-6.3, §3.10).
 *
 * A `.blend` source cannot be previewed, measured or licensed as a deliverable — it is a working
 * file. This queue is what turns one into an exported, decimated glTF the rest of the pipeline can
 * treat like any other version: measured, pinned, reviewed, licensed.
 *
 * Until now the queue existed with **no processor**: `apps/worker/src/main.ts` registered a no-op
 * consumer that logged a warning and completed, so a `blender-optimize` job looked like it had run.
 * That is the worst shape of incompleteness this codebase can have — the failure is silent.
 *
 * ## How the two containers talk
 *
 * The runner is a service on the Compose network, not a CLI the worker execs. The worker has no
 * Docker socket, deliberately: a worker that could start sibling processes would make every
 * container in the stack a container-escaping primitive. So the *job* arrives over HTTP.
 *
 * The *files* do not. Both containers mount the same `blenderjobs` volume, so the worker writes the
 * source, names it in the request, and reads the derivative back from the same path. Pushing a
 * 200 MB `.blend` through a JSON body would be a slow way to avoid a volume.
 *
 * ## The simulated mode
 *
 * With no `BLENDER_RUNNER_URL` configured — the default, because the image is ~1 GB — the processor
 * records a **labelled simulation**: the derivative version is created and its audit row carries
 * `simulated: true`, but no bytes are invented and no CID is pinned. The alternative, silently
 * failing or silently succeeding, would leave an operator unable to tell "Blender is not configured"
 * from "Blender is broken".
 *
 * This is the same shape as the `xr-publish` processor (FR-10.1), deliberately: a simulation that
 * announces itself is an honest placeholder, and one that does not is a lie with good uptime.
 */
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { recordAudit, withTenant } from '@void-space/db';
import { UnrecoverableError, type Job } from 'bullmq';
import type { Logger } from 'pino';

import { attemptOf, createJobContext, isTerminalFailure, type JobPayload } from '../lib/job-tracking';

export interface BlenderOptimizeDeps {
  readonly logger: Logger;
  /** e.g. `http://blender-runner:8090`. Absent means simulate. */
  readonly runnerUrl: string | undefined;
  /** Directory both this worker and the runner mount, for handing files across. */
  readonly jobDir: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface OptimizePayload extends JobPayload {
  readonly assetId?: string;
  readonly assetVersionId?: string;
  readonly stagedPath?: string;
  readonly polycountBudget?: number;
  readonly targetFormat?: 'glb' | 'gltf';
  readonly generateLods?: boolean;
}

/** The shape `docker/scripts/blender-optimize.py` prints on its `VOID_SPACE_RESULT` line. */
interface OptimizerResult {
  readonly ok: boolean;
  readonly output?: string;
  readonly format?: string;
  readonly trianglesBefore?: number;
  readonly trianglesAfter?: number;
  readonly budget?: number;
  readonly error?: string;
}

/** Bytes on disk, or 0 when the runner reported success without leaving a file. */
async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

export function createBlenderOptimizeProcessor(deps: BlenderOptimizeDeps) {
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 900_000;

  return async function processBlenderOptimize(
    job: Job<OptimizePayload>,
  ): Promise<Record<string, unknown>> {
    const tenantId = String(job.data.tenantId ?? '');
    const ctx = createJobContext({
      jobId: String(job.id),
      tenantId,
      queue: 'blender-optimize',
      payload: job.data,
      attempt: attemptOf(job),
      maxAttempts: job.opts.attempts ?? 1,
    });

    const { assetId, assetVersionId, stagedPath } = job.data;
    if (!assetId || !assetVersionId || !stagedPath) {
      throw new Error('blender-optimize job needs assetId, assetVersionId and stagedPath');
    }

    await ctx.markActive();

    try {
      const source = await withTenant(tenantId, (db) =>
        db.assetVersion.findUnique({
          where: { id: assetVersionId },
          select: { id: true, assetId: true, format: true, stagingPath: true },
        }),
      );
      if (!source) {
        // The asset was deleted while this job sat in the queue. Retrying cannot conjure it back,
        // so the retry policy is not spent on it — the same reasoning the `ipfs-pin` processor
        // applies to a vanished version.
        throw new UnrecoverableError(
          `AssetVersion ${assetVersionId} no longer exists (tenant ${tenantId})`,
        );
      }

      const format = job.data.targetFormat ?? 'glb';
      const budget = job.data.polycountBudget ?? 0;
      // Prefer what the database recorded; fall back to what the job carried. They are the same
      // file, and either can be the more current answer.
      const sourcePath = source.stagingPath ?? stagedPath;

      // Named from the version id, so two concurrent jobs on one asset cannot collide, and located
      // inside the shared volume so the runner can write it.
      await mkdir(deps.jobDir, { recursive: true });
      const outputPath = join(deps.jobDir, `${source.id}-optimized.${format}`);

      let result: OptimizerResult;
      let simulated: boolean;

      if (deps.runnerUrl) {
        // The runner reads its input from the same volume, so it needs a copy under a name it is
        // permitted to open. A copy, not a move: a retry must still find the original, and the
        // runner must never hold the only reference to the source bytes.
        const sourceCopy = join(deps.jobDir, `${source.id}-source${extname(sourcePath)}`);
        await copyFile(sourcePath, sourceCopy);

        const response = await doFetch(`${deps.runnerUrl.replace(/\/$/, '')}/optimize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Filenames, not paths. The runner resolves them against its own job directory, so the two
          // containers do not have to mount the shared volume at the same path — see the runner's
          // module docstring for the bug that came of assuming they did.
          body: JSON.stringify({
            input: basename(sourceCopy),
            output: basename(outputPath),
            budget,
            format,
            generateLods: job.data.generateLods ?? false,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        result = (await response.json()) as OptimizerResult;
        if (!response.ok || !result.ok) {
          throw new Error(
            `Blender runner failed (HTTP ${response.status}): ${result.error ?? 'no detail'}`,
          );
        }
        simulated = false;
      } else {
        // No runner configured. Do not claim bytes were produced — see the note at the top.
        result = { ok: true, format, budget };
        simulated = true;
      }

      const sizeBytes = simulated ? 0 : await sizeOf(outputPath);
      const trianglesAfter = result.trianglesAfter ?? null;

      const derivative = await withTenant(tenantId, async (db) => {
        // The next free version number. Read inside the transaction, and the unique index on
        // (assetId, versionNumber) is the real guard — this read makes a collision unlikely, not
        // impossible.
        const latest = await db.assetVersion.findFirst({
          where: { assetId, tenantId },
          orderBy: { versionNumber: 'desc' },
          select: { versionNumber: true },
        });

        const created = await db.assetVersion.create({
          data: {
            tenantId,
            assetId,
            versionNumber: (latest?.versionNumber ?? 0) + 1,
            format: `.${format}`,
            sizeBytes: BigInt(sizeBytes),
            polycount: trianglesAfter,
            // FR-6.3 — the two columns that make this a derivative rather than a new upload.
            isDerivative: true,
            derivativeOfVersionId: source.id,
            // Only a real run has bytes to hand the pin job. A simulation leaves both null, so
            // nothing downstream can mistake it for content that exists.
            ...(simulated ? {} : { stagingPath: outputPath, pinStatus: 'pending' as const }),
            sourceTool: 'Blender (headless)',
            meshMetadata: {
              trianglesBefore: result.trianglesBefore ?? null,
              trianglesAfter: result.trianglesAfter ?? null,
              budget,
              simulated,
            } as never,
          },
          select: { id: true, versionNumber: true },
        });

        await recordAudit(
          {
            action: 'asset.optimized',
            entityType: 'assetVersion',
            entityId: created.id,
            actorLabel: 'worker:blender-optimize',
            beforeState: { triangles: result.trianglesBefore ?? null, sourceVersionId: source.id },
            afterState: {
              versionNumber: created.versionNumber,
              format,
              budget,
              triangles: result.trianglesAfter ?? null,
              // The same rule FR-10.x applies to the EoN push: a simulation must be visible.
              simulated,
            },
          },
          db,
        );

        return created;
      });

      if (simulated) {
        deps.logger.warn(
          { assetId, versionId: derivative.id },
          'BLENDER_RUNNER_URL is not set — recorded a simulated derivative with no bytes; bring the ' +
            'runner up with `docker compose --profile blender up -d blender-runner`',
        );
      } else {
        deps.logger.info(
          { assetId, versionId: derivative.id, trianglesAfter },
          'blender derivative produced',
        );
      }

      await ctx.succeed({
        derivativeVersionId: derivative.id,
        versionNumber: derivative.versionNumber,
        simulated,
        trianglesAfter,
      });

      return {
        derivativeVersionId: derivative.id,
        versionNumber: derivative.versionNumber,
        simulated,
      };
    } catch (error) {
      const terminal = isTerminalFailure(error, ctx);
      await ctx.fail(error, terminal);
      deps.logger.warn({ err: error, assetId, terminal }, 'blender optimisation failed');
      throw error;
    }
  };
}
