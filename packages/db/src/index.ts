/**
 * @void-space/db — Prisma client, tenant-isolated data access, and the
 * append-only audit helper (SRS §5).
 *
 * Tenant-scoped data is reachable **only** through `withTenant(...)`; see
 * ./tenant.ts for the mechanics and the rationale.
 */
export {
  prisma,
  platformPrisma,
  inspectDatabaseRole,
  assertRlsEnforced,
  disconnectAll,
  type DatabaseRoleInfo,
} from './client';

export {
  withTenant,
  withPlatform,
  tenantDb,
  currentTenantId,
  tryCurrentTenantId,
  hasTenantContext,
  isUuid,
  TenantContextMissingError,
  type TenantClient,
  type WithTenantOptions,
} from './tenant';

export {
  recordAudit,
  recordStatusChange,
  type AuditEventInput,
  type AuditLogRow,
} from './audit';

/** Deterministic, valid GLB fixtures — used by the seed and, in tests, by the upload path. */
export { buildGlbFixture } from './glb-fixture';
export {
  buildShapeGlb,
  buildShapeParts,
  isShapeName,
  SHAPE_NAMES,
  type ShapeName,
  type ShapeStats,
} from './glb-shapes';

export {
  metadataFromGlbBuffer,
  metadataFromGltfJson,
  readGlbMetadata,
  exceedsPolycountBudget,
  type GltfDocument,
} from './glb-read';

/** Deterministic demo identifiers — shared by the seed, workers and the test harness. */
export { demoId, demoCid, demoHash } from './demo-ids';

export {
  generateApiKey,
  hashApiKey,
  parseApiKey,
  verifyApiKey,
  API_KEY_PREFIX,
  type GeneratedApiKey,
  type ParsedApiKey,
} from './apikey';

export { hashPassword, verifyPassword, bcryptCostOf, BCRYPT_COST } from './password';

export {
  syncPublicCatalogEntry,
  removePublicCatalogEntry,
  listPublicCatalog,
  getPublicCatalogEntry,
  publicCatalogFacets,
  toPublicCatalogItem,
  PUBLIC_CATALOG_SORTS,
  type PublicCatalogItem,
  type PublicCatalogSort,
} from './public-catalog';
export { loadRootEnv, migrateDatabaseUrl, REPO_ROOT } from './env';

// Prisma enums/types so consumers never import from the generated path directly.
export {
  AssetStatus,
  JobQueue,
  JobStatus,
  LicenseStatus,
  PinStatus,
  ReviewDecisionKind,
  RoleName,
  TenantStatus,
  UserStatus,
  WalletType,
  Prisma,
} from '../generated/client';

export type { PrismaClient } from '../generated/client';
