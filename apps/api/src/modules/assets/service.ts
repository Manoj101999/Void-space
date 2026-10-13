/**
 * Asset service (SRS FR-3.x, FR-4.x, §5.1 lifecycle, §5.3 RLS).
 *
 * Responsibilities:
 *  - persist an asset plus its first version from a staged upload;
 *  - enforce the §5.1 lifecycle on every status change;
 *  - enqueue the async work (§3.10) and mirror each job into the `jobs` table;
 *  - project the `AssetDetail` the UI needs from several tables at once.
 *
 * Everything runs inside `withTenant`, so RLS is the backstop: even a query missing a
 * `tenantId` filter cannot read another workspace's assets.
 */
import { randomUUID } from 'node:crypto';

import { recordAudit, withTenant, type Prisma } from '@void-space/db';
import {
  canTransition,
  DELETABLE_STATUSES,
  isDeletable,
  METADATA_EDITABLE_STATUSES,
  MUTABLE_STATUSES,
  QUEUE_POLICIES,
  type AiSuggestionSummary,
  type AssetDetail,
  type AssetListQuery,
  type AssetStatus,
  type AssetSummary,
  type AssetVersionSummary,
  type AuthPrincipal,
  type CreateAssetMetadataInput,
  type LicenseSummary,
  type Paginated,
  type QueueName,
  queueNameFromDb,
  type ReviewCommentSummary,
} from '@void-space/types';

import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors';
import { readGlbMetadata } from '@void-space/db';
import type { JobProducer } from '../../lib/jobs';
import type { StagedFile, StagingStorage } from '../../lib/storage';

type TenantDb = Prisma.TransactionClient;

/** The Prisma enum spelling of a queue name (`ipfs-pin` → `ipfs_pin`). */
const JOB_QUEUE_ENUM: Record<QueueName, string> = {
  'ai-enrichment': 'ai_enrichment',
  'ipfs-pin': 'ipfs_pin',
  'blender-optimize': 'blender_optimize',
  'chain-license': 'chain_license',
  'xr-publish': 'xr_publish',
  notify: 'notify',
};

export interface AssetServiceDeps {
  readonly storage: StagingStorage;
  readonly producer: JobProducer;
}

export interface CreateAssetParams {
  readonly metadata: CreateAssetMetadataInput;
  readonly file: StagedFile;
  /** Pre-allocated id, so the staging directory exists before the row does. */
  readonly versionId: string;
}

export interface AssetService {
  create(principal: AuthPrincipal, params: CreateAssetParams): Promise<AssetDetail>;
  list(principal: AuthPrincipal, query: AssetListQuery): Promise<Paginated<AssetSummary>>;
  detail(principal: AuthPrincipal, assetId: string): Promise<AssetDetail>;
  updateMetadata(
    principal: AuthPrincipal,
    assetId: string,
    input: Partial<CreateAssetMetadataInput>,
  ): Promise<AssetDetail>;
  addVersion(
    principal: AuthPrincipal,
    assetId: string,
    params: { file: StagedFile; versionId: string; metadata?: Partial<CreateAssetMetadataInput> },
  ): Promise<AssetDetail>;
  submit(principal: AuthPrincipal, assetId: string): Promise<AssetDetail>;
  remove(principal: AuthPrincipal, assetId: string): Promise<void>;
}

/** Everything a summary needs, in one round trip. */
const assetInclude = {
  creator: { select: { id: true, fullName: true, email: true } },
  currentVersion: true,
  licenses: {
    where: { status: 'active' as const },
    orderBy: { mintedAt: 'desc' as const },
    take: 1,
  },
} satisfies Prisma.AssetInclude;

type AssetRow = Prisma.AssetGetPayload<{ include: typeof assetInclude }>;

/**
 * A version row, derived from the asset projection so the type can never drift from
 * the Prisma model (the earlier hand-written version named columns that do not exist).
 */
type VersionRow = NonNullable<AssetRow['currentVersion']>;
type LicenseRow = AssetRow['licenses'][number];

export function createAssetService(deps: AssetServiceDeps): AssetService {
  // ---------------------------------------------------------------- projections

  /** FR-8.3 — reads go through the nginx-cached gateway, never the raw node. */
  function gatewayUrl(cid: string | null): string | null {
    return cid ? `/ipfs/${cid}` : null;
  }

  /**
   * The rendered preview for a version, keyed by its content address.
   *
   * `asset_versions.ipfs_cid` is the *only* thing that identifies a thumbnail. The worker renders
   * `.thumbnails/<cid>.jpg` as part of ingest (`apps/worker/src/lib/thumbnail.ts`) and the
   * `/thumbnails/[cid]` route serves it, so the URL is a pure function of state we already persist.
   * Deriving it rather than storing a second copy matters: a stored path can drift out of step with
   * the file on disk — the failure mode that made thumbnails depend on a `public/` directory Next
   * enumerates once at boot — whereas a content address cannot go stale.
   *
   * Null exactly when there is no CID yet, i.e. the version has not been pinned, so there is
   * nothing to key a render by. This was a literal `null` on every asset, which told every API
   * consumer that no preview existed even for assets whose render was already on disk.
   */
  function thumbnailUrl(cid: string | null): string | null {
    return cid ? `/thumbnails/${cid}` : null;
  }

/**
 * Reads the measured extent out of `meshMetadata`, for display.
 *
 * The bounding box is stored on ingest, so the interface can report scale without downloading the
 * model first — and without inventing a plausible-looking number.
 */
function dimensionsFrom(meshMetadata: Prisma.JsonValue | null): { x: number; y: number; z: number } | null {
  const box = (meshMetadata as { boundingBox?: { min?: number[]; max?: number[] } } | null)
    ?.boundingBox;
  if (!box?.min || !box?.max || box.min.length < 3 || box.max.length < 3) return null;

  const [minX = 0, minY = 0, minZ = 0] = box.min;
  const [maxX = 0, maxY = 0, maxZ = 0] = box.max;
  return {
    x: Number((maxX - minX).toFixed(3)),
    y: Number((maxY - minY).toFixed(3)),
    z: Number((maxZ - minZ).toFixed(3)),
  };
}

  function toVersionSummary(version: VersionRow, currentVersionId: string | null): AssetVersionSummary {
    return {
      id: version.id,
      versionNumber: version.versionNumber,
      format: version.format,
      sizeBytes: Number(version.sizeBytes),
      polycount: version.polycount,
      ipfsCid: version.ipfsCid,
      pinStatus: version.pinStatus as AssetVersionSummary['pinStatus'],
      sourceTool: version.sourceTool,
      sourceLicense: version.sourceLicense,
      sourceAttribution: version.sourceAttribution,
      createdAt: version.createdAt.toISOString(),
      gatewayUrl: gatewayUrl(version.ipfsCid),
      isCurrent: version.id === currentVersionId,
      stats: {
        vertices: version.vertices,
        materials: version.materials,
        textures: version.textures,
        animations: version.animations,
      },
      dimensions: dimensionsFrom(version.meshMetadata),
    };
  }

  function toLicenseSummary(license: LicenseRow): LicenseSummary {
    return {
      id: license.id,
      tokenId: license.tokenId.toString(),
      contractAddress: license.contractAddress,
      txHash: license.txHash,
      blockNumber: license.blockNumber?.toString() ?? null,
      gasUsed: license.gasUsed?.toString() ?? null,
      ipfsMetadataCid: license.ipfsMetadataCid,
      licenseTermsHash: license.licenseTermsHash,
      status: license.status as LicenseSummary['status'],
      revokedReason: license.revokedReason,
      revokedAt: license.revokedAt?.toISOString() ?? null,
      mintedAt: license.mintedAt.toISOString(),
      // The token URI is derived on-chain from baseURI + tokenId (ERC-721 metadata),
      // so the API composes it from the contract rather than storing a copy.
      tokenUri: null,
    };
  }

  /**
   * What the caller may do with this asset. Computed here rather than in the UI so the
   * buttons and the guards can never disagree (§3.6 "reflected in the Next.js UI").
   */
  function capabilities(principal: AuthPrincipal, asset: AssetRow) {
    const owns = asset.creatorId === principal.userId;
    const mayUpload = principal.permissions.includes('asset:upload-own');
    const mayDecide = principal.permissions.includes('review:decide');
    const mayPublish = principal.permissions.includes('asset:publish');
    const mayRevoke = principal.permissions.includes('asset:revoke-license');

    return {
      canDelete:
        isDeletable(asset.status) &&
        principal.permissions.includes('asset:delete-own-unpublished') &&
        (owns || mayDecide),
      canPublish: mayPublish && asset.status === 'approved',
      canRevoke: mayRevoke && asset.status === 'published',
      // The editor opens for the asset's creator and for admins in any lifecycle state;
      // §5.1 still refuses the save itself outside METADATA_EDITABLE_STATUSES (409).
      canEdit: mayUpload && (owns || mayDecide),
      canSubmit: canTransition(asset.status, 'pending') && (owns || mayDecide),
    };
  }

  function toSummary(principal: AuthPrincipal, asset: AssetRow): AssetSummary {
    const capabilitiesOf = capabilities(principal, asset);
    const current = asset.currentVersion;

    return {
      id: asset.id,
      name: asset.name,
      description: asset.description,
      category: asset.category,
      tags: asset.tags,
      status: asset.status,
      createdAt: asset.createdAt.toISOString(),
      updatedAt: asset.updatedAt.toISOString(),
      creator: asset.creator
        ? { id: asset.creator.id, fullName: asset.creator.fullName, email: asset.creator.email }
        : null,
      currentVersion: current ? toVersionSummary(current, asset.currentVersionId) : null,
      license: asset.licenses[0] ? toLicenseSummary(asset.licenses[0]) : null,
      xrModuleUrl: asset.manifestUrl,
      xrManifestRef: asset.xrManifestRef,
      thumbnailUrl: thumbnailUrl(current?.ipfsCid ?? null),
      canDelete: capabilitiesOf.canDelete,
      canPublish: capabilitiesOf.canPublish,
      canRevoke: capabilitiesOf.canRevoke,
      canEdit: capabilitiesOf.canEdit,
    };
  }

  // ------------------------------------------------------------------ job mirror

  /**
   * Enqueues one job and records it in `jobs` (FR-11.2). A Redis outage must not fail
   * the upload: the row is written as `failed` with the reason, so the UI can offer a
   * retry instead of losing the asset (NFR-REL.1).
   */
  async function enqueue(
    db: TenantDb,
    params: {
      readonly tenantId: string;
      readonly queue: QueueName;
      readonly entityType: string;
      readonly entityId: string;
      readonly payload: Record<string, unknown>;
    },
  ): Promise<void> {
    const jobId = randomUUID();
    // Attempt budget comes from the shared §3.10 policy, so the row and BullMQ agree.
    const maxAttempts = QUEUE_POLICIES[params.queue].attempts;

    await db.job.create({
      data: {
        id: jobId,
        tenantId: params.tenantId,
        queue: JOB_QUEUE_ENUM[params.queue] as never,
        status: 'queued',
        entityType: params.entityType,
        entityId: params.entityId,
        payload: { ...params.payload, tenantId: params.tenantId } as Prisma.InputJsonValue,
        maxAttempts,
      },
    });

    const outcome = await deps.producer.enqueue({
      id: jobId,
      queue: params.queue,
      tenantId: params.tenantId,
      entityType: params.entityType,
      entityId: params.entityId,
      // The worker must be told which tenant to open its RLS context in, so the tenant id
      // travels in the payload rather than being inferred.
      payload: { ...params.payload, tenantId: params.tenantId },
      maxAttempts,
    });

    if (!outcome.enqueued) {
      await db.job.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          error: `Could not reach the queue: ${outcome.error ?? 'unknown error'}`,
          finishedAt: new Date(),
        },
      });
    }
  }

  /** Reads the tenant's staging/production defaults (FR-14.3). */
  async function tenantDefaults(db: TenantDb, tenantId: string) {
    const settings = await db.tenantSettings.findUnique({ where: { tenantId } });
    return {
      polycountBudget: settings?.defaultPolycountBudget ?? null,
      requiredMetadataFields: settings?.requiredMetadataFields ?? [],
      allowedCategories: settings?.allowedCategories ?? [],
    };
  }

  async function loadAsset(db: TenantDb, tenantId: string, assetId: string): Promise<AssetRow> {
    const asset = await db.asset.findFirst({ where: { id: assetId, tenantId }, include: assetInclude });
    if (!asset) throw new NotFoundError('Asset');
    return asset;
  }

  /** GUARD: a Creator may only touch their own assets (§3.6 "own assets"). */
  function assertMayEdit(principal: AuthPrincipal, asset: AssetRow): void {
    const owns = asset.creatorId === principal.userId;
    const mayDecide = principal.permissions.includes('review:decide');
    if (owns || mayDecide || principal.isSuperAdmin) return;

    throw new ForbiddenError(
      'You can only modify assets you created',
      'NOT_ASSET_OWNER',
      { assetId: asset.id },
    );
  }

  // ------------------------------------------------------------------------ create

  /**
   * FR-3.2/FR-3.3 — persist the asset, its first version, the audit rows and the async
   * work in one tenant transaction. `submitForReview` decides whether the asset lands as
   * `draft` (saved for later) or `pending` (in the review queue).
   */
  async function create(principal: AuthPrincipal, params: CreateAssetParams): Promise<AssetDetail> {
    const { metadata, file, versionId } = params;
    const assetId = randomUUID();
    const targetStatus: AssetStatus = metadata.submitForReview ? 'pending' : 'draft';

    // §6.3 — parse mesh metadata at ingest; failures are non-fatal by design.
    const meshMetadata = file.extension === '.glb' ? await readGlbMetadata(file.path) : null;
    const actorLabel = `${principal.fullName} <${principal.email}>`;

    await withTenant(principal.tenantId, async (db) => {
      const defaults = await tenantDefaults(db, principal.tenantId);
      if (
        defaults.allowedCategories.length > 0 &&
        !defaults.allowedCategories.includes(metadata.category)
      ) {
        throw new ConflictError(
          `Category "${metadata.category}" is not allowed in this workspace`,
          'CATEGORY_NOT_ALLOWED',
          { allowed: defaults.allowedCategories },
        );
      }

      await db.asset.create({
        data: {
          id: assetId,
          tenantId: principal.tenantId,
          creatorId: principal.userId,
          name: metadata.name,
          description: metadata.description ?? null,
          category: metadata.category,
          tags: metadata.tags,
          metadata: (metadata.metadata ?? undefined) as never,
          status: targetStatus,
        },
      });

      const version = await db.assetVersion.create({
        data: {
          id: versionId,
          tenantId: principal.tenantId,
          assetId,
          versionNumber: 1,
          format: file.extension,
          sizeBytes: BigInt(file.sizeBytes),
          // FR-8.1 — the CID is unknown until the pin worker has run.
          pinStatus: 'pending',
          stagingPath: file.path,
          createdById: principal.userId,
          sourceTool: metadata.sourceTool ?? null,
          sourceLicense: metadata.sourceLicense ?? null,
          sourceAttribution: metadata.sourceAttribution ?? null,
          sourceUrl: metadata.sourceUrl ?? null,
          polycount: meshMetadata?.polycount ?? null,
          vertices: meshMetadata?.vertices ?? null,
          materials: meshMetadata?.materials ?? null,
          animations: meshMetadata?.animations ?? null,
          textures: meshMetadata?.textures ?? null,
          meshMetadata: meshMetadata ? (meshMetadata as unknown as Prisma.InputJsonValue) : undefined,
        },
        select: { id: true },
      });

      await db.asset.update({
        where: { id: assetId },
        data: { currentVersionId: version.id },
      });

      await recordAudit(
        {
          action: 'asset.created',
          entityType: 'asset',
          entityId: assetId,
          actorId: principal.userId,
          actorLabel,
          afterState: {
            name: metadata.name,
            category: metadata.category,
            status: targetStatus,
            version: 1,
            sizeBytes: file.sizeBytes,
            polycount: meshMetadata?.polycount ?? null,
          },
        },
        db,
      );

      // FR-3.1 — the bytes go to IPFS through the pin queue.
      await enqueue(db, {
        tenantId: principal.tenantId,
        queue: 'ipfs-pin',
        entityType: 'assetVersion',
        entityId: version.id,
        payload: { assetId, versionId: version.id, stagingPath: file.path },
      });

      if (targetStatus === 'pending') {
        await recordAudit(
          {
            action: 'asset.submitted',
            entityType: 'asset',
            entityId: assetId,
            actorId: principal.userId,
            actorLabel,
            beforeState: { status: 'draft' },
            afterState: { status: 'pending' },
          },
          db,
        );
        // §3.10 — AI enrichment runs once the asset is in the review path.
        await enqueue(db, {
          tenantId: principal.tenantId,
          queue: 'ai-enrichment',
          entityType: 'assetVersion',
          entityId: version.id,
          payload: { assetId, versionId: version.id },
        });
      }
    });

    return detail(principal, assetId);
  }

  // -------------------------------------------------------------------------- list

  /** FR-3.5 — filter/search within the active tenant; RLS guarantees the boundary. */
  async function list(
    principal: AuthPrincipal,
    query: AssetListQuery,
  ): Promise<Paginated<AssetSummary>> {
    return withTenant(principal.tenantId, async (db) => {
      const statuses = query.statuses ?? (query.status ? [query.status] : []);
      // §3.6 — the Viewer role holds only `catalog:view`, so it is narrowed to published
      // work here rather than being refused (FR-3.5 lists what a scoped read must support).
      const publishedOnly = query.publishedOnly || principal.readOnly;

      const where: Prisma.AssetWhereInput = {
        tenantId: principal.tenantId,
        ...(statuses.length > 0 ? { status: { in: statuses } } : {}),
        // FR-9.5/FR-9.6 — a listing means "published *and* licensed". Status alone is not enough:
        // revoking a licence is a takedown, and a takedown that leaves the asset on the shelf has
        // not happened. Without this an asset whose licence the contract reports as invalid stayed
        // in the catalogue, rendered with no licence at all because the card reads the active one.
        // The asset's own status stays `published` — §5.1 defines no transition out of it, and the
        // history of having been published is worth keeping — so the licence is the gate here.
        ...(publishedOnly ? { status: 'published', licenses: { some: { status: 'active' } } } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.tag ? { tags: { has: query.tag } } : {}),
        ...(query.creatorId ? { creatorId: query.creatorId } : {}),
        ...(query.q
          ? {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' } },
                { tags: { has: query.q } },
                { category: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
        ...(query.format ? { currentVersion: { format: query.format } } : {}),
      };

      const [total, rows] = await Promise.all([
        db.asset.count({ where }),
        db.asset.findMany({
          where,
          include: assetInclude,
          orderBy: { [query.sort]: query.order },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ]);

      return {
        items: rows.map((row) => toSummary(principal, row)),
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      };
    });
  }

  // ------------------------------------------------------------------------ detail

  /** FR-3.4 — the full picture: versions, AI suggestion, decisions, comments, jobs. */
  async function detail(principal: AuthPrincipal, assetId: string): Promise<AssetDetail> {
    return withTenant(principal.tenantId, async (db) => {
      const asset = await loadAsset(db, principal.tenantId, assetId);

      const versions = await db.assetVersion.findMany({
        where: { assetId },
        orderBy: { versionNumber: 'desc' },
      });
      const versionIds = versions.map((version) => version.id);

      const [suggestion, decisions, comments, jobs, auditTrail] = await Promise.all([
        // AISuggestion hangs off the *version*, not the asset (FR-7.4), so the newest
        // suggestion across this asset's versions is the current one.
        db.aISuggestion.findFirst({
          where: { assetVersionId: { in: versionIds } },
          orderBy: { createdAt: 'desc' },
        }),
        db.reviewDecision.findMany({
          where: { assetId },
          orderBy: { createdAt: 'desc' },
          include: { assessor: { select: { id: true, fullName: true } } },
        }),
        db.reviewComment.findMany({
          where: { assetId },
          orderBy: { createdAt: 'asc' },
          include: {
            author: {
              select: {
                id: true,
                fullName: true,
                roles: { select: { role: { select: { name: true } } } },
              },
            },
          },
        }),
        db.job.findMany({
          where: {
            tenantId: principal.tenantId,
            OR: [
              { entityType: 'assetVersion', entityId: { in: versionIds } },
              { entityType: 'asset', entityId: assetId },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: 25,
        }),
        db.auditLog.findMany({
          where: { tenantId: principal.tenantId, entityType: 'asset', entityId: assetId },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { id: true, action: true, actorId: true, createdAt: true, txHash: true },
        }),
      ]);

      const aiSuggestion: AiSuggestionSummary | null = suggestion
        ? {
            id: suggestion.id,
            assetVersionId: suggestion.assetVersionId,
            suggestedTags: suggestion.suggestedTags,
            suggestedDescription: suggestion.suggestedDescription,
            qualityFlags: suggestion.qualityFlags,
            confidence: suggestion.confidence,
            modelVersion: suggestion.modelVersion,
            promptVersion: suggestion.promptVersion,
            latencyMs: suggestion.latencyMs,
            createdAt: suggestion.createdAt.toISOString(),
            acceptedTags: suggestion.acceptedTags,
            acceptedDescription: suggestion.acceptedDescription,
          }
        : null;

      return {
        ...toSummary(principal, asset),
        versions: versions.map((version) => toVersionSummary(version, asset.currentVersionId)),
        aiSuggestion,
        decisions: decisions.map((decision) => ({
          id: decision.id,
          decision: decision.decision,
          comment: decision.comment,
          createdAt: decision.createdAt.toISOString(),
          assessor: decision.assessor,
          assetVersionId: decision.assetVersionId,
        })),
        comments: buildCommentTree(comments),
        jobs: jobs.map((job) => ({
          id: job.id,
          // §3.10 vocabulary, not the `jobs.queue` enum spelling — see `queueNameFromDb`.
          queue: queueNameFromDb(job.queue),
          status: job.status,
          attempts: job.attempts,
          error: job.error,
          createdAt: job.createdAt.toISOString(),
        })),
        auditTrail: auditTrail.map((entry) => ({
          id: entry.id,
          action: entry.action,
          actorId: entry.actorId,
          createdAt: entry.createdAt.toISOString(),
          txHash: entry.txHash,
        })),
      };
    });
  }

  /** Comments are flat rows with a parent pointer; the UI wants a tree (FR-4.6). */
  function buildCommentTree(
    rows: {
      id: string;
      assetId: string;
      parentId: string | null;
      body: string;
      createdAt: Date;
      author: { id: string; fullName: string; roles: { role: { name: string } }[] } | null;
    }[],
  ): ReviewCommentSummary[] {
    const byParent = new Map<string | null, ReviewCommentSummary[]>();

    for (const row of rows) {
      const summary: ReviewCommentSummary = {
        id: row.id,
        assetId: row.assetId,
        parentId: row.parentId,
        body: row.body,
        createdAt: row.createdAt.toISOString(),
        author: row.author
          ? {
              id: row.author.id,
              fullName: row.author.fullName,
              roles: row.author.roles.map((membership) => membership.role.name),
            }
          : null,
        replies: [],
      };
      const bucket = byParent.get(row.parentId) ?? [];
      bucket.push(summary);
      byParent.set(row.parentId, bucket);
    }

    const attach = (parentId: string | null): ReviewCommentSummary[] =>
      (byParent.get(parentId) ?? []).map((comment) => ({
        ...comment,
        replies: attach(comment.id),
      }));

    return attach(null);
  }

  // ------------------------------------------------------------------ metadata edit

  /**
   * FR-3.2/FR-4.5 — the asset's creator and admins may refine metadata in any mutable
   * state and also while the asset is still in review, before a decision has landed.
   * Once the pipeline passes review (approved, published) the asset is immutable and
   * only revocation applies (§5.1).
   */
  async function updateMetadata(
    principal: AuthPrincipal,
    assetId: string,
    input: Partial<CreateAssetMetadataInput>,
  ): Promise<AssetDetail> {
    const actorLabel = `${principal.fullName} <${principal.email}>`;

    await withTenant(principal.tenantId, async (db) => {
      const asset = await loadAsset(db, principal.tenantId, assetId);
      assertMayEdit(principal, asset);

      // assertMayEdit above has already restricted the caller to the asset's creator
      // or an admin, so admitting an in-review save here cannot widen who may edit.
      if (!METADATA_EDITABLE_STATUSES.includes(asset.status)) {
        throw new ConflictError(
          `An asset in "${asset.status}" cannot be edited`,
          'ASSET_NOT_EDITABLE',
          { status: asset.status, editable: METADATA_EDITABLE_STATUSES },
        );
      }

      const defaults = await tenantDefaults(db, principal.tenantId);
      if (
        input.category &&
        defaults.allowedCategories.length > 0 &&
        !defaults.allowedCategories.includes(input.category)
      ) {
        throw new ConflictError(
          `Category "${input.category}" is not allowed in this workspace`,
          'CATEGORY_NOT_ALLOWED',
          { allowed: defaults.allowedCategories },
        );
      }

      const before = { name: asset.name, category: asset.category, tags: asset.tags };

      await db.asset.update({
        where: { id: assetId },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.category ? { category: input.category } : {}),
          ...(input.tags ? { tags: input.tags } : {}),
          ...(input.metadata ? { metadata: input.metadata as never } : {}),
        },
      });

      // FR-8.4 — provenance fields live on the version and stay immutable.
      if (input.sourceTool || input.sourceLicense || input.sourceAttribution) {
        await db.assetVersion.updateMany({
          where: { assetId, id: asset.currentVersionId ?? undefined },
          data: {
            ...(input.sourceTool ? { sourceTool: input.sourceTool } : {}),
            ...(input.sourceLicense ? { sourceLicense: input.sourceLicense } : {}),
            ...(input.sourceAttribution
              ? { sourceAttribution: input.sourceAttribution }
              : {}),
          },
        });
      }

      await recordAudit(
        {
          action: 'asset.created',
          entityType: 'asset',
          entityId: assetId,
          actorId: principal.userId,
          actorLabel,
          beforeState: before,
          afterState: { name: input.name ?? asset.name, category: input.category ?? asset.category, tags: input.tags ?? asset.tags },
        },
        db,
      );
    });

    return detail(principal, assetId);
  }

  // ------------------------------------------------------------------ new version

  /**
   * FR-3.4 — uploading a new version supersedes the current one. Earlier versions stay
   * immutable (they may already be referenced by a review decision or a minted licence),
   * and the asset returns to the review path.
   */
  async function addVersion(
    principal: AuthPrincipal,
    assetId: string,
    params: { file: StagedFile; versionId: string; metadata?: Partial<CreateAssetMetadataInput> },
  ): Promise<AssetDetail> {
    const { file, versionId, metadata } = params;
    const meshMetadata = file.extension === '.glb' ? await readGlbMetadata(file.path) : null;
    const actorLabel = `${principal.fullName} <${principal.email}>`;

    await withTenant(principal.tenantId, async (db) => {
      const asset = await loadAsset(db, principal.tenantId, assetId);
      assertMayEdit(principal, asset);

      if (!MUTABLE_STATUSES.includes(asset.status)) {
        throw new ConflictError(
          `A new version cannot be added while the asset is "${asset.status}"`,
          'ASSET_NOT_EDITABLE',
          { status: asset.status, editable: MUTABLE_STATUSES },
        );
      }

      const latest = await db.assetVersion.findFirst({
        where: { assetId },
        orderBy: { versionNumber: 'desc' },
        select: { versionNumber: true },
      });
      const versionNumber = (latest?.versionNumber ?? 0) + 1;

      await db.assetVersion.create({
        data: {
          id: versionId,
          tenantId: principal.tenantId,
          assetId,
          versionNumber,
          format: file.extension,
          sizeBytes: BigInt(file.sizeBytes),
          pinStatus: 'pending',
          stagingPath: file.path,
          createdById: principal.userId,
          sourceTool: metadata?.sourceTool ?? null,
          sourceLicense: metadata?.sourceLicense ?? null,
          sourceAttribution: metadata?.sourceAttribution ?? null,
          polycount: meshMetadata?.polycount ?? null,
          vertices: meshMetadata?.vertices ?? null,
          materials: meshMetadata?.materials ?? null,
          animations: meshMetadata?.animations ?? null,
          textures: meshMetadata?.textures ?? null,
          meshMetadata: meshMetadata ? (meshMetadata as unknown as Prisma.InputJsonValue) : undefined,
        },
      });

      // A new version restarts the review cycle. `revision` and `rejected` both go back
      // through the queue rather than jumping straight to `approved` (§5.1).
      const nextStatus: AssetStatus = 'pending';

      await db.asset.update({
        where: { id: assetId },
        data: {
          currentVersionId: versionId,
          status: nextStatus,
          ...(metadata?.name ? { name: metadata.name } : {}),
          ...(metadata?.category ? { category: metadata.category } : {}),
          ...(metadata?.tags ? { tags: metadata.tags } : {}),
        },
      });

      await recordAudit(
        {
          action: 'asset.version_created',
          entityType: 'asset',
          entityId: assetId,
          actorId: principal.userId,
          actorLabel,
          beforeState: { version: versionNumber - 1, status: asset.status },
          afterState: {
            version: versionNumber,
            status: nextStatus,
            sizeBytes: file.sizeBytes,
            polycount: meshMetadata?.polycount ?? null,
          },
        },
        db,
      );

      await enqueue(db, {
        tenantId: principal.tenantId,
        queue: 'ipfs-pin',
        entityType: 'assetVersion',
        entityId: versionId,
        payload: { assetId, versionId, stagingPath: file.path },
      });

      await enqueue(db, {
        tenantId: principal.tenantId,
        queue: 'ai-enrichment',
        entityType: 'assetVersion',
        entityId: versionId,
        payload: { assetId, versionId },
      });
    });

    return detail(principal, assetId);
  }

  // ------------------------------------------------------------------------- submit

  /**
   * FR-3.3 — move a draft (or a returned revision) into the review queue, which is also
   * what triggers AI enrichment (§3.10).
   */
  async function submit(principal: AuthPrincipal, assetId: string): Promise<AssetDetail> {
    const actorLabel = `${principal.fullName} <${principal.email}>`;

    await withTenant(principal.tenantId, async (db) => {
      const asset = await loadAsset(db, principal.tenantId, assetId);
      assertMayEdit(principal, asset);

      // §5.1 — the shared transition table is the single source of truth.
      if (!canTransition(asset.status, 'pending')) {
        throw new ConflictError(
          `An asset in "${asset.status}" cannot be submitted for review`,
          'INVALID_TRANSITION',
          { from: asset.status, to: 'pending' },
        );
      }
      if (!asset.currentVersionId) {
        throw new ConflictError('The asset has no version to review', 'NO_VERSION');
      }

      // FR-14.3 — tenant-required metadata must be present before submission.
      const defaults = await tenantDefaults(db, principal.tenantId);
      const missing = defaults.requiredMetadataFields.filter((field) => {
        if (field === 'tags') return asset.tags.length === 0;
        if (field === 'sourceTool') return !asset.currentVersion?.sourceTool;
        if (field === 'license') {
          return !asset.currentVersion?.sourceLicense && !asset.currentVersion?.sourceAttribution;
        }
        return false;
      });
      if (missing.length > 0) {
        throw new ConflictError(
          `This workspace requires ${missing.join(', ')} before submission`,
          'REQUIRED_METADATA_MISSING',
          { missing },
        );
      }

      await db.asset.update({ where: { id: assetId }, data: { status: 'pending' } });

      await recordAudit(
        {
          action: 'asset.submitted',
          entityType: 'asset',
          entityId: assetId,
          actorId: principal.userId,
          actorLabel,
          beforeState: { status: asset.status },
          afterState: { status: 'pending' },
        },
        db,
      );

      await enqueue(db, {
        tenantId: principal.tenantId,
        queue: 'ai-enrichment',
        entityType: 'assetVersion',
        entityId: asset.currentVersionId,
        payload: { assetId, versionId: asset.currentVersionId },
      });
    });

    return detail(principal, assetId);
  }

  // ------------------------------------------------------------------------- delete

  /**
   * FR-3.6 — a Creator deletes their own *unpublished* asset; anything approved or
   * published is refused by the lifecycle (§5.1). Staged binaries are removed too, so a
   * deleted upload leaves no orphaned bytes behind.
   */
  async function remove(principal: AuthPrincipal, assetId: string): Promise<void> {
    const actorLabel = `${principal.fullName} <${principal.email}>`;
    let stagedPaths: string[] = [];

    await withTenant(principal.tenantId, async (db) => {
      const asset = await loadAsset(db, principal.tenantId, assetId);
      assertMayEdit(principal, asset);

      if (!isDeletable(asset.status)) {
        throw new ConflictError(
          `A "${asset.status}" asset cannot be deleted`,
          'ASSET_NOT_DELETABLE',
          { status: asset.status, deletable: DELETABLE_STATUSES },
        );
      }
      if (asset.licenses.length > 0) {
        // Defence in depth: a live licence must never be orphaned by a delete.
        throw new ConflictError(
          'This asset carries an active licence and cannot be deleted',
          'ASSET_HAS_LICENSE',
        );
      }

      const versions = await db.assetVersion.findMany({
        where: { assetId },
        select: { stagingPath: true, ipfsCid: true },
      });
      stagedPaths = versions
        .map((version) => version.stagingPath)
        .filter((path): path is string => Boolean(path));

      await db.asset.delete({ where: { id: assetId } });

      await recordAudit(
        {
          action: 'asset.deleted',
          entityType: 'asset',
          entityId: assetId,
          actorId: principal.userId,
          actorLabel,
          beforeState: {
            name: asset.name,
            status: asset.status,
            versions: versions.length,
            pinned: versions.filter((version) => version.ipfsCid).length,
          },
        },
        db,
      );
    });

    // Binaries live outside the transaction on purpose: a disk error must not roll back
    // the (already audited) deletion, and the CID remains on IPFS as provenance.
    for (const path of stagedPaths) {
      if (deps.storage.owns(path)) await deps.storage.remove(path);
    }
  }

  return { create, list, detail, updateMetadata, addVersion, submit, remove };
}

