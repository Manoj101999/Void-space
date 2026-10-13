/**
 * Asset domain contracts (SRS §2.5, §4.3–§4.10, §5.1, Figure 4).
 */

/** SRS §5.1: status ∈ {draft, pending, needs_manual_review, approved, rejected, revision, published}. */
export const ASSET_STATUSES = [
  'draft',
  'pending',
  'needs_manual_review',
  'approved',
  'rejected',
  'revision',
  'published',
] as const;

export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const REVIEW_DECISIONS = ['approved', 'rejected', 'revision'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** §2.5: uploaded files are restricted to these formats, 200 MB ceiling per asset. */
export const ALLOWED_ASSET_EXTENSIONS = ['.glb', '.gltf', '.obj', '.fbx', '.stl', '.blend'] as const;
export type AssetExtension = (typeof ALLOWED_ASSET_EXTENSIONS)[number];

export const MAX_ASSET_SIZE_BYTES = 200 * 1024 * 1024; // 200 MB — FR-3.1

/** Accepted MIME types per extension (NFR-SEC.3 validates extension *and* MIME). */
export const ASSET_MIME_TYPES: Readonly<Record<AssetExtension, readonly string[]>> = {
  '.glb': ['model/gltf-binary', 'application/octet-stream'],
  '.gltf': ['model/gltf+json', 'application/json', 'text/plain', 'application/octet-stream'],
  '.obj': ['text/plain', 'application/octet-stream', 'model/obj'],
  '.fbx': ['application/octet-stream', 'model/fbx'],
  '.stl': ['model/stl', 'application/sla', 'application/octet-stream'],
  '.blend': ['application/octet-stream', 'application/x-blender'],
};

/**
 * Formats the browser viewer decodes directly, and therefore the formats a thumbnail can be
 * rendered from (FR-5.2).
 *
 * The viewer ships its own decoders — glTF via `GLTFLoader`, plus OBJ, STL and FBX — so a preview
 * (and a real, model-derived preview image) exists for every accepted upload except `.blend`,
 * which no browser decodes and which keeps its drawn fallback.
 */
export const NATIVELY_VIEWABLE_EXTENSIONS: readonly AssetExtension[] = [
  '.glb',
  '.gltf',
  '.obj',
  '.fbx',
  '.stl',
];

export const PIN_STATUSES = ['pending', 'pinning', 'pinned', 'failed'] as const;
export type PinStatus = (typeof PIN_STATUSES)[number];

export const LICENSE_STATUSES = ['active', 'revoked'] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

/**
 * Lifecycle state machine (Figure 4).
 *
 *   draft ──submit──▶ pending ──decision──▶ approved | rejected | revision
 *   pending ──ai-failure──▶ needs_manual_review
 *   revision ──resubmit──▶ pending        rejected ──new version──▶ pending
 *   approved ──publish──▶ published       published ──takedown──▶ (license revoked)
 *
 * A license mint is irreversible in the UI (FR-3.6/FR-9.4): once `published`,
 * an asset can only be taken down (FR-9.5), never deleted or reverted.
 */
export const ALLOWED_STATUS_TRANSITIONS: Readonly<Record<AssetStatus, readonly AssetStatus[]>> = {
  draft: ['pending', 'needs_manual_review'],
  pending: ['approved', 'rejected', 'revision', 'needs_manual_review'],
  needs_manual_review: ['approved', 'rejected', 'revision'],
  approved: ['published', 'revision'],
  rejected: ['pending'],
  revision: ['pending'],
  published: [],
};

export function canTransition(from: AssetStatus, to: AssetStatus): boolean {
  return ALLOWED_STATUS_TRANSITIONS[from].includes(to);
}

/** Statuses a Creator may delete (FR-3.6: unpublished only). */
export const DELETABLE_STATUSES: readonly AssetStatus[] = ['draft', 'pending', 'revision', 'rejected'];

export function isDeletable(status: AssetStatus): boolean {
  return DELETABLE_STATUSES.includes(status);
}

/** Statuses in which a Creator may still edit metadata or upload a new version (FR-3.2, §5.1). */
export const MUTABLE_STATUSES: readonly AssetStatus[] = ['draft', 'revision', 'rejected'];

/**
 * Statuses in which the asset's creator or an admin may edit metadata: the mutable
 * states plus an in-review asset, whose details the Creator may refine while a
 * decision is still pending (FR-3.2). Version uploads and submission keep following
 * MUTABLE_STATUSES; §5.1 still bars every other state.
 */
export const METADATA_EDITABLE_STATUSES: readonly AssetStatus[] = [
  ...MUTABLE_STATUSES,
  'pending',
];

export function isMetadataEditable(status: AssetStatus): boolean {
  return METADATA_EDITABLE_STATUSES.includes(status);
}

/** Statuses that put an asset in front of an Assessor (FR-4.1). */
export const REVIEWABLE_STATUSES: readonly AssetStatus[] = ['pending', 'needs_manual_review'];

/**
 * A comment is mandatory when rejecting or requesting a revision and optional
 * on approval (FR-4.2).
 */
export function commentRequiredFor(decision: ReviewDecision): boolean {
  return decision === 'rejected' || decision === 'revision';
}

/** Human-facing labels (§6.1 status pills). */
export const ASSET_STATUS_LABELS: Readonly<Record<AssetStatus, string>> = {
  draft: 'Draft',
  pending: 'Pending review',
  needs_manual_review: 'Needs manual review',
  approved: 'Approved',
  rejected: 'Rejected',
  revision: 'Revision requested',
  published: 'Published',
};

/** Source-tool designations offered at upload time (FR-3.2). */
export const SOURCE_TOOLS = [
  'Blender',
  'Maya',
  '3ds Max',
  'Cinema 4D',
  'ZBrush',
  'Sketchfab',
  'Poly Pizza',
  'Meshy AI',
  'Other',
] as const;
export type SourceTool = (typeof SOURCE_TOOLS)[number];

/** Default asset categories, overridable per tenant (FR-14.3). */
export const DEFAULT_ASSET_CATEGORIES = [
  'Machinery',
  'Safety Equipment',
  'Environment',
  'Character',
  'Prop',
  'Tooling',
  'Vehicle',
  'Architecture',
  'Other',
] as const;
