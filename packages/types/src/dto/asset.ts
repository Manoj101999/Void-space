import { z } from 'zod';
import {
  ALLOWED_ASSET_EXTENSIONS,
  ASSET_STATUSES,
  SOURCE_TOOLS,
  type AssetStatus,
  type PinStatus,
} from '../assets';
import { booleanishSchema, paginationQuerySchema } from './common';

/** FR-3.2: Name and Category are required; Tags and Source Tool are optional. */
export const createAssetMetadataSchema = z.object({
  name: z.string().min(1).max(200),
  /**
   * FR-3.2 — a short human summary. Optional at upload (the AI enricher proposes one), but the
   * marketplace and catalog render whatever ends up here, so it is capped to keep a card sane.
   */
  description: z.string().max(4000).optional(),
  category: z.string().min(1).max(60),
  tags: z.array(z.string().min(1).max(40)).max(25).default([]),
  /**
   * FR-3.2/FR-14.3 — tenant-defined structured attributes (e.g. `{ "scale": "1:1", "lod": 2 }`).
   * Stored as JSON and validated against the tenant's `requiredMetadataFields` on submit, so a
   * workspace can demand fields the schema was never told about.
   */
  metadata: z.record(z.unknown()).optional(),
  sourceTool: z.enum(SOURCE_TOOLS).optional(),
  /** FR-3.3: 'draft' when saved without submission, 'pending' when submitted. */
  submitForReview: booleanishSchema.default(true),
  /** NFR-COMP.1: imported third-party assets keep their source license. */
  sourceLicense: z.string().max(120).optional(),
  sourceAttribution: z.string().max(500).optional(),
  sourceUrl: z.string().url().max(1000).optional(),
});
export type CreateAssetMetadataInput = z.infer<typeof createAssetMetadataSchema>;

export const resubmitAssetSchema = z.object({
  submitForReview: booleanishSchema.default(true),
  /** Optional metadata refresh on resubmission; omitted fields are unchanged. */
  name: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(60).optional(),
  tags: z.array(z.string().min(1).max(40)).max(25).optional(),
  sourceTool: z.enum(SOURCE_TOOLS).optional(),
});

/**
 * FR-3.2/FR-4.5 — the metadata fields PATCH /assets/:id accepts. Every field is
 * optional so a caller can refine just one; an omitted field is left unchanged.
 * `description` and `metadata` live on the asset, unlike the provenance fields,
 * which stay immutable on the version (FR-8.4) and are therefore not editable.
 */
export const updateAssetMetadataSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  category: z.string().min(1).max(60).optional(),
  tags: z.array(z.string().min(1).max(40)).max(25).optional(),
  /** Tenant-defined structured attributes (FR-14.3), stored as JSON. */
  metadata: z.record(z.unknown()).optional(),
});
export type UpdateAssetMetadataInput = z.infer<typeof updateAssetMetadataSchema>;

export const assetListQuerySchema = paginationQuerySchema.extend({
  /** FR-3.5: filter/search own assets scoped to the active tenant. */
  q: z.string().max(120).optional(),
  status: z.enum(ASSET_STATUSES).optional(),
  statuses: z.array(z.enum(ASSET_STATUSES)).optional(),
  tag: z.string().max(40).optional(),
  category: z.string().max(60).optional(),
  creatorId: z.string().uuid().optional(),
  /** Viewer-role and catalog views restrict to published assets. */
  publishedOnly: booleanishSchema.default(false),
  format: z.enum(ALLOWED_ASSET_EXTENSIONS).optional(),
});
export type AssetListQuery = z.infer<typeof assetListQuerySchema>;

export interface AssetVersionSummary {
  readonly id: string;
  readonly versionNumber: number;
  readonly format: string;
  readonly sizeBytes: number;
  readonly polycount: number | null;
  readonly ipfsCid: string | null;
  readonly pinStatus: PinStatus;
  readonly sourceTool: string | null;
  readonly sourceLicense: string | null;
  readonly sourceAttribution: string | null;
  readonly createdAt: string;
  /** Gateway URL served through the Nginx cache (FR-8.3). */
  readonly gatewayUrl: string | null;
  readonly isCurrent: boolean;
  /** Meshes / textures / animations, as measured on ingest. */
  readonly stats: {
    readonly vertices: number | null;
    readonly materials: number | null;
    readonly textures: number | null;
    readonly animations: number | null;
  };
  /**
   * Extent of the geometry in model units, or null when the format could not be read.
   *
   * Shown in the interface because scale is the first thing anyone evaluating a 3D asset for XR
   * needs to know, and it is measured rather than guessed.
   */
  readonly dimensions: { readonly x: number; readonly y: number; readonly z: number } | null;
}

export interface AiSuggestionSummary {
  readonly id: string;
  readonly assetVersionId: string;
  readonly suggestedTags: readonly string[];
  readonly suggestedDescription: string;
  readonly qualityFlags: readonly string[];
  readonly confidence: number;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly latencyMs: number | null;
  readonly createdAt: string;
  readonly acceptedTags: readonly string[];
  readonly acceptedDescription: string | null;
}

export interface LicenseSummary {
  readonly id: string;
  readonly tokenId: string;
  readonly contractAddress: string;
  /** Null when the mint transaction was not observed (token adopted from chain state). */
  readonly txHash: string | null;
  readonly blockNumber: string | null;
  readonly gasUsed: string | null;
  readonly ipfsMetadataCid: string | null;
  readonly licenseTermsHash: string;
  readonly status: 'active' | 'revoked';
  readonly revokedReason: string | null;
  readonly revokedAt: string | null;
  readonly mintedAt: string;
  readonly tokenUri: string | null;
}

export interface AssetSummary {
  readonly id: string;
  readonly name: string;
  /** FR-3.2 — null until written at upload or promoted from an accepted AI suggestion. */
  readonly description: string | null;
  readonly category: string;
  readonly tags: readonly string[];
  readonly status: AssetStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly creator: { id: string; fullName: string; email: string } | null;
  readonly currentVersion: AssetVersionSummary | null;
  readonly license: LicenseSummary | null;
  readonly xrModuleUrl: string | null;
  readonly xrManifestRef: string | null;
  readonly thumbnailUrl: string | null;
  readonly canDelete: boolean;
  readonly canPublish: boolean;
  readonly canRevoke: boolean;
  /** FR-3.2/FR-4.5 — the asset's creator or an admin may open the editor; §5.1 gates the save by status. */
  readonly canEdit: boolean;
}

export interface AssetDetail extends AssetSummary {
  readonly versions: readonly AssetVersionSummary[];
  readonly aiSuggestion: AiSuggestionSummary | null;
  readonly decisions: readonly {
    id: string;
    decision: string;
    comment: string | null;
    createdAt: string;
    assessor: { id: string; fullName: string } | null;
    assetVersionId: string;
  }[];
  readonly comments: readonly ReviewCommentSummary[];
  readonly jobs: readonly {
    id: string;
    queue: string;
    status: string;
    attempts: number;
    error: string | null;
    createdAt: string;
  }[];
  readonly auditTrail: readonly {
    id: string;
    action: string;
    actorId: string | null;
    createdAt: string;
    txHash: string | null;
  }[];
}

/** FR-4.6: threaded comments on an asset's review history. */
export interface ReviewCommentSummary {
  readonly id: string;
  readonly assetId: string;
  readonly parentId: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly author: { id: string; fullName: string; roles: readonly string[] } | null;
  readonly replies: readonly ReviewCommentSummary[];
}

/** Polycount / format metadata parsed from the uploaded file. */
export interface MeshMetadata {
  readonly polycount: number | null;
  readonly vertices: number | null;
  readonly materials: number | null;
  readonly animations: number | null;
  readonly textures: number | null;
  readonly boundingBox: { min: [number, number, number]; max: [number, number, number] } | null;
}

/**
 * §6.1 "Public Catalog" — the anonymous marketplace contract.
 *
 * Mirrors `PublicCatalogItem` in @void-space/db but is declared separately on purpose: the
 * marketplace payload is an allow-list of fields, and sharing one interface with the tenant-side
 * asset view is exactly how a private field becomes public by accident.
 */
export interface PublicCatalogItem {
  readonly assetId: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string;
  readonly tags: readonly string[];
  /** Attribution visible to anonymous visitors — the workspace display name only. */
  readonly tenantName: string;
  readonly format: string;
  /** Bytes as a string: `BigInt` does not survive JSON. */
  readonly sizeBytes: string;
  readonly polycount: number | null;
  readonly vertices: number | null;
  readonly materials: number | null;
  readonly textures: number | null;
  readonly animations: number | null;
  /** FR-8.1 — content address, fetchable through `GET /ipfs/<cid>` on the edge. */
  readonly ipfsCid: string;
  readonly licenseType: string;
  readonly licenseTerms: string | null;
  readonly tokenId: string | null;
  readonly contractAddress: string | null;
  readonly txHash: string | null;
  readonly licenseMetadataCid: string | null;
  readonly xrManifestRef: string | null;
  /** NFR-COMP.1 — a third-party source licence stays visible to buyers. */
  readonly sourceLicense: string | null;
  readonly sourceAttribution: string | null;
  readonly sourceUrl: string | null;
  readonly publishedAt: string;
}

export interface PublicCatalogPage {
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly sort?: PublicCatalogSort;
  readonly items: readonly PublicCatalogItem[];
}

/**
 * The orders the catalogue accepts, shared by the API validator, the storefront and the console.
 *
 * Declared once, here, as a value: `PublicCatalogSort` is derived from it, the API's `z.enum` uses it
 * directly, and the storefront renders its options from it. A closed set rather than a free-text
 * field because the value reaches Prisma's `orderBy` — accepting arbitrary column names would turn a
 * public endpoint into a schema probe.
 */
export const PUBLIC_CATALOG_SORTS = [
  'newest',
  'oldest',
  'triangles-desc',
  'size-desc',
  'name',
] as const;

export type PublicCatalogSort = (typeof PUBLIC_CATALOG_SORTS)[number];

export interface PublicCatalogFacets {
  readonly total: number;
  readonly categories: readonly { value: string; count: number }[];
  readonly licenseTypes: readonly { value: string; count: number }[];
  readonly tags: readonly { value: string; count: number }[];
  readonly polygons: number;
  readonly bytes: string;
}

export interface PublicCatalogStats {
  readonly published: number;
  readonly polygons: number;
  readonly bytes: string;
  readonly categories: number;
}
