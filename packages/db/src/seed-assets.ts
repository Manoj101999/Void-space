/**
 * Demo asset fixtures for `pnpm db:seed` — one asset in every lifecycle state
 * from Figure 4, so review, licensing, IPFS metadata and audit views all have
 * realistic data to show.
 */
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AssetStatus,
  JobQueue,
  JobStatus,
  PinStatus,
  Prisma,
  ReviewDecisionKind,
} from '../generated/client';
import { demoCid, demoId } from './demo-ids';
import type { MeshMetadata } from '@void-space/types';

import { REPO_ROOT } from './env';
import { buildGlbFixture } from './glb-fixture';
import { buildShapeGlb, isShapeName, type ShapeName } from './glb-shapes';
import { metadataFromGlbBuffer } from './glb-read';
import { ipfsReachable, pinBuffer } from './ipfs-pin';
import { syncPublicCatalogEntry } from './public-catalog';
import { withTenant } from './tenant';

export interface DemoVersionSpec {
  readonly versionNumber: number;
  readonly format: string;
  readonly sizeBytes: number;
  readonly polycount: number;
  readonly derivative?: boolean;
  readonly sourceLicense?: string;
  readonly sourceAttribution?: string;
  /**
   * A model bundled in `models/` to use as this version's content.
   *
   * When set, the content is read from disk and *measured* — triangle count, materials,
   * textures, bounds — rather than declared. Declared numbers that disagree with the file are
   * exactly the kind of demo data that erodes trust in the rest of the interface.
   */
  readonly modelFile?: string;
}

export type DemoAssetStatus =
  'draft' | 'pending' | 'needs_manual_review' | 'approved' | 'rejected' | 'revision' | 'published';

export interface DemoAssetSpec {
  readonly key: string;
  readonly name: string;
  /** FR-3.2 — the summary the marketplace and catalog render for this asset. */
  readonly description: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly status: DemoAssetStatus;
  readonly createdByRole: 'Creator' | 'TenantAdmin';
  readonly versions: readonly DemoVersionSpec[];
  readonly currentVersionNumber: number;
  readonly sourceTool?: string;
  /**
   * The parametric shape this asset's generated fixture is built from.
   *
   * Without it every generated asset was the same sphere, so a catalogue of twelve different
   * industrial assets rendered as twelve identical yellow balls. An asset with a bundled
   * `modelFile` ignores this — the real file is the content.
   */
  readonly shape?: ShapeName;
  readonly ai?: {
    readonly tags: readonly string[];
    readonly description: string;
    readonly qualityFlags: readonly string[];
    readonly confidence: number;
    readonly needsManualReview?: boolean;
    readonly latencyMs: number;
  };
  readonly decision?: {
    readonly kind: 'approved' | 'rejected' | 'revision';
    readonly comment?: string;
  };
  readonly comments?: readonly {
    readonly body: string;
    readonly authorRole: 'Creator' | 'Assessor';
    readonly reply?: { readonly body: string; readonly authorRole: 'Creator' | 'Assessor' };
  }[];
  readonly jobs?: readonly {
    readonly queue: 'ai_enrichment' | 'ipfs_pin' | 'chain_license' | 'xr_publish';
    readonly status: 'completed' | 'failed' | 'active';
    readonly error?: string;
  }[];
  readonly publishToXr?: boolean;
}

/**
 * First token id used by fabricated demo licences.
 *
 * Chosen far above any plausible demo mint, so a freshly seeded registry can render
 * real-looking rows without ever occupying an id the chain is about to issue
 * (AssetLicenseRegistry starts at 1). Genuine licences minted through the UI always land
 * below this range, and the two sources stay distinguishable in the registry.
 */
export interface AssetSeedResult {
  readonly assets: number;
  readonly auditEntries: number;
}

/**
 * Writes one demo asset and all of its dependent rows inside a single tenant
 * context (so RLS applies exactly as it will for the API).
 */
export async function seedAsset(
  tenantId: string,
  spec: DemoAssetSpec,
  userIds: Record<string, string>,
): Promise<AssetSeedResult> {
  const assetId = demoId(`asset:${tenantId}:${spec.key}`);
  const creatorId = userIds[spec.createdByRole === 'Creator' ? 'creator' : 'admin'];
  const assessorId = userIds.assessor;
  if (!creatorId || !assessorId) throw new Error('[seed] creator/assessor user missing');

  let auditEntries = 0;

  await withTenant(
    tenantId,
    async (db) => {
      const currentVersionId = demoId(
        `assetversion:${tenantId}:${spec.key}:v${spec.currentVersionNumber}`,
      );

      // The seed establishes a starting state; it must not rewind live progress.
      //
      // An active licence is the platform's own definition of "live": it was minted by a decision,
      // a publish call and a confirmed transaction, and it points at the version it covers. So an
      // asset holding one is `published` — whether or not the spec says so — and an asset already
      // `published` stays that way. Setting the spec's status over either would leave an `approved`
      // asset holding a valid on-chain licence: a combination no workflow can produce, and one the
      // API will not even let you fix, because publishing refuses an already-licensed asset.
      const [existing, activeLicences] = await Promise.all([
        db.asset.findFirst({ where: { id: assetId }, select: { status: true } }),
        db.license.count({ where: { assetId, status: 'active' } }),
      ]);
      const isLive = existing?.status === AssetStatus.published || activeLicences > 0;
      const nextStatus = isLive ? AssetStatus.published : spec.status;

      await db.asset.upsert({
        where: { id: assetId },
        update: {
          name: spec.name,
          description: spec.description,
          category: spec.category,
          tags: [...spec.tags],
          status: nextStatus,
        },
        create: {
          id: assetId,
          tenantId,
          creatorId,
          name: spec.name,
          description: spec.description,
          category: spec.category,
          tags: [...spec.tags],
          status: spec.status,
        },
      });

      for (const version of spec.versions) {
        const versionId = demoId(`assetversion:${tenantId}:${spec.key}:v${version.versionNumber}`);
        // A .glb fixture is generated with exactly `polycount` triangles and pinned, so the
        // gateway link resolves and the viewer really renders something.
        const fixture = await buildFixture(spec, version);
        const ipfsCid = fixture.cid;
        await db.assetVersion.upsert({
          where: { id: versionId },
          // The fixture content is deterministic, so repairing these on reseed is a no-op for an
          // already-correct row and fixes a stale one (e.g. seeded before fixtures were pinned).
          update: {
            pinStatus: PinStatus.pinned,
            ipfsCid,
            ...measuredColumns(fixture, version),
          },
          create: {
            id: versionId,
            tenantId,
            assetId,
            versionNumber: version.versionNumber,
            format: version.format,
            ipfsCid,
            ...measuredColumns(fixture, version),
            pinStatus: PinStatus.pinned,
            sourceTool: spec.sourceTool ?? 'Blender',
            sourceLicense: version.sourceLicense ?? null,
            sourceAttribution: version.sourceAttribution ?? null,
            isDerivative: version.derivative ?? false,
            derivativeOfVersionId: version.derivative
              ? demoId(`assetversion:${tenantId}:${spec.key}:v1`)
              : null,
            createdById: creatorId,
          },
        });
      }

      await db.asset.update({
        where: { id: assetId },
        data: {
          currentVersionId,
          publishedAt: spec.status === 'published' ? new Date() : null,
          manifestUrl: spec.publishToXr ? `https://eon-reality.local/modules/${spec.key}` : null,
          xrManifestRef: spec.publishToXr ? `eon-manifest-${spec.key}` : null,
        },
      });

      if (spec.ai) {
        await db.aISuggestion.upsert({
          where: { assetVersionId: currentVersionId },
          update: {},
          create: {
            id: demoId(`ai:${tenantId}:${spec.key}`),
            tenantId,
            assetVersionId: currentVersionId,
            suggestedTags: [...spec.ai.tags],
            suggestedDescription: spec.ai.description,
            qualityFlags: [...spec.ai.qualityFlags],
            confidence: spec.ai.confidence,
            modelVersion: 'claude-sonnet-4-5',
            promptVersion: 'v1',
            latencyMs: spec.ai.latencyMs,
            needsManualReview: spec.ai.needsManualReview ?? false,
            rawResponse: { demo: true },
          },
        });
      }

      if (spec.decision) {
        const decisionId = demoId(`decision:${tenantId}:${spec.key}`);
        await db.reviewDecision.upsert({
          where: { id: decisionId },
          update: {},
          create: {
            id: decisionId,
            tenantId,
            assetId,
            assetVersionId: currentVersionId,
            assessorId,
            decision: spec.decision.kind as ReviewDecisionKind,
            comment: spec.decision.comment ?? null,
          },
        });
        auditEntries += 1;
      }

      // FR-4.6 — threaded review comments (one parent, optionally one reply).
      for (const [index, comment] of (spec.comments ?? []).entries()) {
        const parentId = demoId(`comment:${tenantId}:${spec.key}:${index}`);
        await db.reviewComment.upsert({
          where: { id: parentId },
          update: {},
          create: {
            id: parentId,
            tenantId,
            assetId,
            authorId: userIds[comment.authorRole === 'Creator' ? 'creator' : 'assessor'],
            body: comment.body,
          },
        });

        if (comment.reply) {
          const replyId = demoId(`comment:${tenantId}:${spec.key}:${index}:reply`);
          await db.reviewComment.upsert({
            where: { id: replyId },
            update: {},
            create: {
              id: replyId,
              tenantId,
              assetId,
              parentId,
              authorId: userIds[comment.reply.authorRole === 'Creator' ? 'creator' : 'assessor'],
              body: comment.reply.body,
            },
          });
        }
      }

      // NB: no licence rows are seeded. A `licences` row is the mirror of an on-chain token, and
      // inventing one here (with a made-up token id and transaction hash) would put fiction in the
      // record the platform exists to make verifiable. `pnpm demo:publish` drives the real flow:
      // approve -> publish -> the chain-license worker mints -> the row is written from the receipt.

      // §6.1 — keep the marketplace honest when re-seeding an existing database. An asset that is
      // already published *and* holds an active licence gets its projection refreshed; one that is
      // not published has any stale projection removed, so the seed cannot leave a listing behind
      // for something that is no longer live. The first publish writes it too (worker path).
      const projected = await syncPublicCatalogEntry(db, { tenantId, assetId });
      // Deleted through the same transaction that made it stale, so the seed is atomic per asset.
      if (!projected) await db.publicCatalogEntry.deleteMany({ where: { assetId } });

      // §3.10 — durable job mirror, including one deliberately failed job so the
      // job-status UI has a failure to render.
      for (const [index, job] of (spec.jobs ?? []).entries()) {
        const jobId = demoId(`job:${tenantId}:${spec.key}:${index}`);
        await db.job.upsert({
          where: { id: jobId },
          update: { status: job.status as JobStatus },
          create: {
            id: jobId,
            tenantId,
            queue: job.queue as JobQueue,
            status: job.status as JobStatus,
            entityType: 'asset',
            entityId: assetId,
            payload: { assetId, demo: true },
            error: job.error ?? null,
            attempts: job.status === 'failed' ? 2 : 1,
            maxAttempts: 3,
            startedAt: new Date(Date.now() - 60_000),
            finishedAt: job.status === 'active' ? null : new Date(Date.now() - 55_000),
          },
        });
      }

      // FR-13.1 — the audit trail for this asset's demo lifecycle.
      const auditPlan: { action: string; after?: Record<string, unknown>; txHash?: string }[] = [
        { action: 'asset.created' },
        { action: 'asset.version_created' },
      ];
      if (spec.status !== 'draft') {
        auditPlan.push({ action: 'asset.submitted', after: { status: 'pending' } });
      }
      if (spec.ai) auditPlan.push({ action: 'ai.enrichment_completed' });
      if (spec.decision) {
        auditPlan.push({ action: 'asset.status_changed', after: { status: spec.decision.kind } });
      }
      for (const [index, entry] of auditPlan.entries()) {
        const auditId = demoId(`audit:${tenantId}:${spec.key}:${index}`);
        const isAutomated = entry.action.startsWith('ai.');
        await db.auditLog.upsert({
          where: { id: auditId },
          update: {},
          create: {
            id: auditId,
            tenantId,
            actorId: isAutomated ? null : creatorId,
            actorLabel: isAutomated ? 'ai-enrichment-worker' : 'Chen Wei',
            action: entry.action,
            entityType: 'asset',
            entityId: assetId,
            beforeState: entry.after
              ? ({ status: 'pending' } as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            afterState: entry.after ? (entry.after as Prisma.InputJsonValue) : Prisma.JsonNull,
            txHash: entry.txHash ?? null,
            blockNumber: entry.txHash ? 42n : null,
            gasUsed: entry.txHash ? 118_432n : null,
          },
        });
        auditEntries += 1;
      }

      // FR-11 — a notification aimed at whoever the state most concerns.
      const notificationType =
        spec.status === 'needs_manual_review'
          ? 'asset.needs_manual_review'
          : spec.status === 'draft'
            ? 'asset.submitted'
            : `asset.${spec.status}`;
      await db.notification.upsert({
        where: { id: demoId(`notify:${tenantId}:${spec.key}`) },
        update: {},
        create: {
          id: demoId(`notify:${tenantId}:${spec.key}`),
          tenantId,
          userId:
            spec.status === 'pending' || spec.status === 'needs_manual_review'
              ? assessorId
              : creatorId,
          type: notificationType,
          payload: { assetId, assetName: spec.name, status: spec.status },
        },
      });
    },
    { timeoutMs: 60_000 },
  );

  return { assets: 1, auditEntries };
}
// ------------------------------------------------------------------ fixtures

/**
 * The version columns that describe the content, taken from the measured metadata.
 *
 * Declared numbers are only a fallback for formats we cannot read (`.fbx`, `.blend`): for those the
 * headless-Blender derivative fills the real counts later. `meshMetadata` keeps the whole measured
 * record — including the bounding box, which is what lets the viewer frame a model of any size
 * without the user hunting for the zoom.
 */
function measuredColumns(
  fixture: ResolvedFixture,
  version: DemoVersionSpec,
): {
  sizeBytes: bigint;
  polycount: number;
  vertices: number;
  materials: number;
  animations: number;
  textures: number;
  meshMetadata: Prisma.InputJsonValue;
} {
  const { metadata } = fixture;
  return {
    sizeBytes: BigInt(fixture.sizeBytes),
    polycount: metadata.polycount ?? version.polycount,
    vertices: metadata.vertices ?? version.polycount * 2,
    materials: metadata.materials ?? 0,
    animations: metadata.animations ?? 0,
    textures: metadata.textures ?? 0,
    meshMetadata: {
      ...metadata,
      formats: [version.format],
    } as Prisma.InputJsonValue,
  };
}

/** Measured description of a version's content, plus where it is pinned. */
interface ResolvedFixture {
  readonly cid: string;
  readonly sizeBytes: number;
  readonly metadata: MeshMetadata;
}

const EMPTY_METADATA: MeshMetadata = {
  polycount: null,
  vertices: null,
  materials: null,
  animations: null,
  textures: null,
  boundingBox: null,
};

/**
 * Reads a model bundled in `models/`.
 *
 * These are the real demo models, so they are read from disk rather than synthesised: seeding a
 * 7.5 MB scanned heart or a 13.6 MB whale skeleton into a bucket of generated cubes would make the
 * catalogue look populated while telling the user nothing about how the platform behaves with
 * actual production assets.
 */
function readBundledModel(fileName: string): Buffer {
  const path = resolve(REPO_ROOT, 'models', fileName);
  try {
    return readFileSync(path);
  } catch {
    throw new Error(
      `[seed] bundled model not found at models/${fileName}. ` +
        'The demo assets depend on it — restore it, or remove the spec that references it.',
    );
  }
}
/**
 * Builds a generated `.glb` for an asset: the named shape when the spec has one, otherwise the
 * exact-triangle-count sphere fixture.
 *
 * The shape recipes are authored at real-world scale, so their triangle counts follow from the
 * geometry rather than from the declared budget. That is the point: the seed stores what the file
 * *measures* (see `measuredColumns`), so the polycount shown in the interface is the artefact's own
 * number rather than a figure invented to fill a column.
 */
function buildGeneratedGlb(spec: DemoAssetSpec, version: DemoVersionSpec): Buffer {
  const shape = spec.shape;
  if (!shape || !isShapeName(shape)) return buildGlbFixture(version.polycount);
  return buildShapeGlb(shape);
}



/**
 * Resolves (and pins) the content one version points at.
 *
 * A bundled model is *measured* — triangle count, materials, textures, bounds — and those numbers
 * are what get stored, so the interface never claims something the file does not contain. Generated
 * `.glb` fixtures are constructed to match their declared count exactly. Non-previewable formats
 * get small placeholder bytes: pinning them still means every gateway link in the demo resolves.
 */
async function buildFixture(
  spec: DemoAssetSpec,
  version: DemoVersionSpec,
): Promise<ResolvedFixture> {
  const format = version.format.toLowerCase();
  const isGlb = format === '.glb' || format === '.gltf';

  // A bundled model is the real thing; otherwise a named shape is built parametrically so the
  // catalogue shows the object it claims to, falling back to the exact-count sphere fixture.
  const content = version.modelFile
    ? readBundledModel(version.modelFile)
    : isGlb
      ? buildGeneratedGlb(spec, version)
      : Buffer.from(`${spec.key} v${version.versionNumber} demo fixture (${version.format})\n`);

  const metadata = (isGlb ? metadataFromGlbBuffer(content) : null) ?? EMPTY_METADATA;
  const pinned = await pinFixture(spec, version, content);

  return { cid: pinned.cid, sizeBytes: pinned.sizeBytes, metadata };
}

/**
 * Pins content, falling back to the placeholder CID when IPFS is not running.
 *
 * Reachability is probed once per seed run: reseeding without the infra profile should warn and
 * carry on rather than fail part-way with tenants half-written.
 */
let ipfsAvailable: boolean | null = null;
let warnedAboutIpfs = false;

async function pinFixture(
  spec: DemoAssetSpec,
  version: DemoVersionSpec,
  content: Buffer,
): Promise<{ cid: string; sizeBytes: number }> {
  const apiUrl = process.env.IPFS_API_URL ?? 'http://127.0.0.1:5001';

  if (ipfsAvailable === null) {
    ipfsAvailable = await ipfsReachable(apiUrl);
  }

  if (ipfsAvailable) {
    try {
      const pinned = await pinBuffer(apiUrl, content);
      return { cid: pinned.cid, sizeBytes: pinned.bytes };
    } catch (error) {
      ipfsAvailable = false;
      console.warn(`[seed] IPFS pin failed for ${spec.key}:`, (error as Error).message);
    }
  }

  if (!warnedAboutIpfs) {
    warnedAboutIpfs = true;
    console.warn(
      `[seed] IPFS is not reachable at ${apiUrl}; storing placeholder CIDs. ` +
        'Start the stack with `pnpm dev:up` and reseed to pin real content.',
    );
  }

  return { cid: demoCid(`${spec.key}:v${version.versionNumber}`), sizeBytes: version.sizeBytes };
}

const GLB = '.glb';

/** Aurora: one asset in every lifecycle state, plus a revoked licence. */
const AURORA_ASSETS: readonly DemoAssetSpec[] = [
  {
    key: 'draft-conveyor-belt',
    shape: 'conveyor',
    description:
      'A modular conveyor belt run with side guards and adjustable legs, for line-layout planning and ' +
      'operator-sightline checks.',
    name: 'Conveyor Belt Section A',
    category: 'Machinery',
    tags: ['conveyor', 'industrial', 'lowpoly'],
    status: 'draft',
    createdByRole: 'Creator',
    sourceTool: 'Blender',
    versions: [{ versionNumber: 1, format: GLB, sizeBytes: 4_812_544, polycount: 18_420 }],
    currentVersionNumber: 1,
    jobs: [{ queue: 'ipfs_pin', status: 'completed' }],
  },
  {
    key: 'pending-excavator',
    shape: 'excavator',
    description:
      'A tracked hydraulic excavator with an articulated boom, bucket and enclosed cab, modelled at ' +
      'working scale for plant-induction scenes.',
    name: 'Hydraulic Excavator 320',
    category: 'Machinery',
    tags: ['excavator', 'heavy-equipment', 'vehicle'],
    status: 'pending',
    createdByRole: 'Creator',
    sourceTool: 'Blender',
    versions: [{ versionNumber: 1, format: GLB, sizeBytes: 18_204_672, polycount: 74_310 }],
    currentVersionNumber: 1,
    ai: {
      tags: ['excavator', 'construction', 'hydraulics', 'heavy-machinery'],
      description:
        'A tracked hydraulic excavator with an articulated boom, bucket and operator cab. Suitable for construction-site safety training modules.',
      qualityFlags: ['polycount-above-xr-budget'],
      confidence: 0.86,
      latencyMs: 3_940,
    },
    jobs: [
      { queue: 'ipfs_pin', status: 'completed' },
      { queue: 'ai_enrichment', status: 'completed' },
    ],
  },
  {
    key: 'manual-review-harness',
    shape: 'harness',
    description:
      'A full-body fall-arrest harness with leg, shoulder and chest straps and a dorsal D-ring, listed ' +
      'with its certified working load.',
    name: 'Full-Body Safety Harness',
    category: 'Safety Equipment',
    tags: ['harness', 'ppe', 'fall-protection'],
    status: 'needs_manual_review',
    createdByRole: 'Creator',
    sourceTool: 'ZBrush',
    versions: [{ versionNumber: 1, format: GLB, sizeBytes: 9_331_200, polycount: 42_880 }],
    currentVersionNumber: 1,
    ai: {
      tags: [],
      description: '',
      qualityFlags: ['schema-validation-failed'],
      confidence: 0,
      needsManualReview: true,
      latencyMs: 6_120,
    },
    jobs: [
      { queue: 'ipfs_pin', status: 'completed' },
      {
        queue: 'ai_enrichment',
        status: 'failed',
        error: 'Claude response was not valid JSON after the stricter retry (FR-7.3)',
      },
    ],
  },
  {
    key: 'approved-crane',
    shape: 'crane',
    description:
      'A tower crane mast, jib and counter-jib assembly for lift planning and site-access studies.',
    name: 'Tower Crane Assembly',
    category: 'Machinery',
    tags: ['crane', 'lifting', 'worksite'],
    status: 'approved',
    createdByRole: 'Creator',
    sourceTool: 'Maya',
    versions: [
      { versionNumber: 1, format: GLB, sizeBytes: 31_457_280, polycount: 128_400 },
      { versionNumber: 2, format: GLB, sizeBytes: 6_291_456, polycount: 46_200, derivative: true },
    ],
    currentVersionNumber: 1,
    ai: {
      tags: ['crane', 'lifting-operations', 'construction', 'rigging'],
      description:
        'A tower crane with jib, counter-jib, trolley and hook block, modelled for worksite lifting-procedure training.',
      qualityFlags: [],
      confidence: 0.91,
      latencyMs: 2_870,
    },
    decision: {
      kind: 'approved',
      comment: 'Geometry and scale verified against the site reference sheet.',
    },
    comments: [
      {
        body: 'Blender-optimised derivative (v2) is attached as a separate version for XR use.',
        authorRole: 'Creator',
        reply: {
          body: 'Noted — the approved licence will reference v1; v2 stays available as a derivative.',
          authorRole: 'Assessor',
        },
      },
    ],
    jobs: [
      { queue: 'ipfs_pin', status: 'completed' },
      { queue: 'ai_enrichment', status: 'completed' },
    ],
  },
  {
    key: 'revision-scaffold',
    shape: 'scaffold',
    description:
      'A modular scaffolding bay with standards, ledgers, transoms and a boarded working platform.',
    name: 'Modular Scaffolding Kit',
    category: 'Environment',
    tags: ['scaffolding', 'modular', 'worksite'],
    status: 'revision',
    createdByRole: 'Creator',
    sourceTool: 'Blender',
    versions: [{ versionNumber: 1, format: GLB, sizeBytes: 12_582_912, polycount: 61_750 }],
    currentVersionNumber: 1,
    ai: {
      tags: ['scaffolding', 'modular-kit', 'construction'],
      description:
        'A modular scaffolding kit with uprights, ledgers, transoms and base plates for assembly training.',
      qualityFlags: ['missing-uv-on-two-meshes'],
      confidence: 0.74,
      latencyMs: 4_310,
    },
    decision: {
      kind: 'revision',
      comment:
        'Two uprights are missing UVs, which will break texturing in the XR module. Please fix and resubmit.',
    },
    comments: [
      {
        body: 'Requesting a revision: upright meshes 3 and 7 have no UV layer.',
        authorRole: 'Assessor',
        reply: {
          body: 'Thanks — fixing the UVs and re-uploading as version 2 today.',
          authorRole: 'Creator',
        },
      },
    ],
    jobs: [
      { queue: 'ipfs_pin', status: 'completed' },
      { queue: 'ai_enrichment', status: 'completed' },
    ],
  },
  {
    key: 'rejected-signage',
    shape: 'sign',
    description:
      'A set of emergency exit signs: illuminated door plates and directional markers. Rejected for ' +
      'using superseded pictograms.',
    name: 'Emergency Exit Signage Set',
    category: 'Prop',
    tags: ['signage', 'emergency', 'exit'],
    status: 'rejected',
    createdByRole: 'Creator',
    sourceTool: 'Cinema 4D',
    versions: [{ versionNumber: 1, format: GLB, sizeBytes: 1_204_224, polycount: 3_120 }],
    currentVersionNumber: 1,
    decision: {
      kind: 'rejected',
      comment:
        'Signage legend does not match the ISO 7010 pictogram used on site. Not usable for compliance training.',
    },
    comments: [
      {
        body: 'Rejecting: the pictogram must match ISO 7010 for the compliance module.',
        authorRole: 'Assessor',
      },
    ],
    jobs: [{ queue: 'ipfs_pin', status: 'completed' }],
  },
  {
    key: 'published-drill',
    shape: 'drill',
    description:
      'A cordless impact drill with keyless chuck, battery pack and trigger, supplied as a handheld ' +
      'prop.',
    name: 'Cordless Impact Drill',
    category: 'Tooling',
    tags: ['drill', 'power-tool', 'handheld'],
    status: 'approved',
    createdByRole: 'Creator',
    sourceTool: 'Blender',
    versions: [{ versionNumber: 1, format: GLB, sizeBytes: 7_864_320, polycount: 28_640 }],
    currentVersionNumber: 1,
    ai: {
      tags: ['power-tool', 'drill', 'handheld', 'maintenance'],
      description:
        'A cordless impact drill with battery pack, chuck and trigger, modelled for tool-safety training.',
      qualityFlags: [],
      confidence: 0.93,
      latencyMs: 2_180,
    },
    decision: { kind: 'approved', comment: 'Approved — meets the XR polycount budget.' },
    publishToXr: true,
    jobs: [
      { queue: 'ipfs_pin', status: 'completed' },
      { queue: 'ai_enrichment', status: 'completed' },
    ],
  },
  {
    key: 'published-imported-cone',
    shape: 'cone',
    description:
      'A flexible traffic cone with a reflective collar, imported from a public-domain source and ' +
      're-licensed here for training use.',
    name: 'Traffic Cone (imported)',
    category: 'Prop',
    tags: ['traffic-cone', 'cc0', 'imported', 'worksite'],
    status: 'approved',
    createdByRole: 'Creator',
    sourceTool: 'Poly Pizza',
    versions: [
      {
        versionNumber: 1,
        format: GLB,
        sizeBytes: 524_288,
        polycount: 1_204,
        sourceLicense: 'CC0',
        sourceAttribution: 'Poly Pizza — “Traffic cone” by Poly by Google',
      },
    ],
    currentVersionNumber: 1,
    decision: {
      kind: 'approved',
      comment: 'CC0 provenance confirmed; licence retained in metadata (NFR-COMP.1).',
    },
    publishToXr: false,
    jobs: [{ queue: 'ipfs_pin', status: 'completed' }],
  },
  // ---------------------------------------------------------- bundled production models
  //
  // These are real scans from `models/`, pinned and measured at seed time: a 22k-triangle
  // anatomical heart and a 247k-triangle whale skeleton. They exist to prove the platform handles
  // genuine production assets — heavy geometry, dozens of textures, a 38-unit bounding box — and to
  // give the marketplace something worth looking at. State: approved, so publishing them is one
  // click and the mint happens for real.
  {
    key: 'model-heart',
    description:
      'A photogrammetry scan of a human heart with textured myocardium, visible great vessels and ' +
      'high-frequency surface detail, for cardiology teaching modules.',
    name: 'Anatomical Heart (scanned)',
    category: 'Anatomy',
    tags: ['anatomy', 'cardiology', 'heart', 'scan', 'education'],
    status: 'approved',
    createdByRole: 'Creator',
    sourceTool: 'Sketchfab',
    versions: [
      {
        versionNumber: 1,
        format: GLB,
        // Declared values are only a fallback: the file is measured on seed and those numbers win.
        sizeBytes: 7_555_412,
        polycount: 22_562,
        modelFile: 'heart.glb',
      },
    ],
    currentVersionNumber: 1,
    ai: {
      tags: ['anatomy', 'heart', 'cardiology', 'medical', 'scan'],
      description:
        'A scanned anatomical heart with textured myocardium and visible great vessels, suitable for cardiology training modules.',
      qualityFlags: [],
      confidence: 0.91,
      latencyMs: 2_640,
    },
    decision: {
      kind: 'approved',
      comment: 'Anatomy verified against the reference label; ready to publish.',
    },
    publishToXr: true,
    jobs: [
      { queue: 'ipfs_pin', status: 'completed' },
      { queue: 'ai_enrichment', status: 'completed' },
    ],
  },
  {
    key: 'model-whale-skeleton',
    description:
      'A museum-mounted blue whale skeleton with individual vertebrae, ribs and flippers, scanned at ' +
      'exhibition scale for anatomy study and gallery previews.',
    name: 'Blue Whale Skeleton',
    category: 'Anatomy',
    tags: ['anatomy', 'skeleton', 'whale', 'museum', 'education'],
    status: 'approved',
    createdByRole: 'Creator',
    sourceTool: 'Sketchfab',
    versions: [
      {
        versionNumber: 1,
        format: GLB,
        sizeBytes: 13_642_632,
        polycount: 247_170,
        modelFile: 'blue_whale_skeleton.glb',
      },
    ],
    currentVersionNumber: 1,
    ai: {
      tags: ['anatomy', 'skeleton', 'blue-whale', 'museum', 'education'],
      description:
        'A mounted blue whale skeleton with individual vertebrae, ribs and flippers, for exhibition and biology training.',
      qualityFlags: ['polycount-above-xr-budget'],
      confidence: 0.87,
      latencyMs: 4_120,
    },
    decision: {
      kind: 'approved',
      comment: 'High polycount accepted for the exhibition tier; a decimated derivative is queued.',
    },
    publishToXr: true,
    jobs: [
      { queue: 'ipfs_pin', status: 'completed' },
      { queue: 'ai_enrichment', status: 'completed' },
    ],
  },
];

/** Northwind: a second tenant, so cross-tenant isolation is visible in the UI. */
const NORTHWIND_ASSETS: readonly DemoAssetSpec[] = [
  {
    key: 'nw-pending-ladder',
    shape: 'ladder',
    description:
      'A three-section extension ladder with rung detail, locking pawls and rubber feet, awaiting ' +
      'review.',
    name: 'Extension Ladder 3-Section',
    category: 'Safety Equipment',
    tags: ['ladder', 'access', 'work-at-height'],
    status: 'pending',
    createdByRole: 'TenantAdmin',
    sourceTool: 'Blender',
    versions: [{ versionNumber: 1, format: GLB, sizeBytes: 5_242_880, polycount: 22_140 }],
    currentVersionNumber: 1,
    ai: {
      tags: ['ladder', 'work-at-height', 'access-equipment'],
      description:
        'A three-section extension ladder with stabiliser feet and rung locks, for working-at-height training.',
      qualityFlags: [],
      confidence: 0.88,
      latencyMs: 3_120,
    },
    jobs: [
      { queue: 'ipfs_pin', status: 'completed' },
      { queue: 'ai_enrichment', status: 'completed' },
    ],
  },
  {
    key: 'nw-published-anchor',
    shape: 'anchor',
    description:
      'A cast fall-arrest anchor point with a welded D-ring, for roof-edge and plant-room ' +
      'installations.',
    name: 'Fall-Arrest Anchor Point',
    category: 'Safety Equipment',
    tags: ['anchor-point', 'fall-arrest', 'roof'],
    status: 'approved',
    createdByRole: 'TenantAdmin',
    sourceTool: '3ds Max',
    versions: [{ versionNumber: 1, format: GLB, sizeBytes: 3_145_728, polycount: 12_880 }],
    currentVersionNumber: 1,
    decision: { kind: 'approved', comment: 'Approved for the roof-safety module.' },
    publishToXr: true,
    jobs: [
      { queue: 'ipfs_pin', status: 'completed' },
      { queue: 'ai_enrichment', status: 'completed' },
    ],
  },
];

export const DEMO_ASSETS = {
  aurora: AURORA_ASSETS,
  northwind: NORTHWIND_ASSETS,
} as const;

/** Seeds every fixture for one tenant and aggregates the counters. */
export async function seedTenantAssets(
  tenantId: string,
  specs: readonly DemoAssetSpec[],
  userIds: Record<string, string>,
): Promise<AssetSeedResult> {
  const totals = { assets: 0, auditEntries: 0 };
  for (const spec of specs) {
    const result = await seedAsset(tenantId, spec, userIds);
    totals.assets += result.assets;
    totals.auditEntries += result.auditEntries;
  }
  return totals;
}
