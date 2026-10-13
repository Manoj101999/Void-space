/**
 * Demo seed (SRS §9.1 `pnpm db:seed`).
 *
 * Creates demo tenants with a Creator, an Assessor, a TenantAdmin, a Developer
 * and a Viewer, plus sample assets in *every* lifecycle state so the review,
 * licensing and audit flows can be explored immediately (NFR-USE.1).
 *
 * Design notes
 * ------------
 * - Idempotent: every demo row uses a deterministic UUID derived from its name,
 *   so re-running the seed upserts instead of duplicating.
 * - Tenant-scoped writes go through `withTenant(...)` — the same path the API
 *   uses. If RLS were misconfigured the seed would fail rather than write
 *   unscoped rows.
 * - Cross-tenant work (the fixed role list) goes through the platform client,
 *   mirroring how the API resolves identity at login.
 * - Managed publisher wallets are deliberately NOT created here: a wallet
 *   address must be derived from PLATFORM_SIGNER_SEED with secp256k1 +
 *   keccak256, which belongs to the chain client in api/worker (§3.9.3/§3.9.4).
 *   The API creates a tenant's managed wallet when the tenant is created.
 *
 * Demo password for every seeded user: `VoidSpace!2026`
 */
import { RoleName, TenantStatus, UserStatus } from '../generated/client';
import { generateApiKey } from './apikey';
import { platformPrisma } from './client';
import { demoId } from './demo-ids';
import { loadRootEnv } from './env';
import { hashPassword } from './password';
import { DEMO_ASSETS, seedTenantAssets } from './seed-assets';
import { withTenant } from './tenant';

const DEMO_PASSWORD = 'VoidSpace!2026';

const DEMO_TENANTS = {
  platform: {
    id: demoId('tenant:platform'),
    name: 'VOID·SPACE Platform',
    slug: 'void-space-platform',
  },
  aurora: {
    id: demoId('tenant:aurora'),
    name: 'Aurora Industrial Training',
    slug: 'aurora-industrial',
  },
  northwind: {
    id: demoId('tenant:northwind'),
    name: 'Northwind Safety XR',
    slug: 'northwind-safety',
  },
} as const;

interface DemoUserSpec {
  readonly key: string;
  readonly tenantId: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: RoleName;
}

const DEMO_USERS: readonly DemoUserSpec[] = [
  {
    key: 'user:superadmin',
    tenantId: DEMO_TENANTS.platform.id,
    email: 'superadmin@void-space.dev',
    fullName: 'Sasha Platform',
    role: RoleName.SuperAdmin,
  },
  {
    key: 'user:aurora-admin',
    tenantId: DEMO_TENANTS.aurora.id,
    email: 'admin@aurora.dev',
    fullName: 'Amara Osei',
    role: RoleName.TenantAdmin,
  },
  {
    key: 'user:aurora-creator',
    tenantId: DEMO_TENANTS.aurora.id,
    email: 'creator@aurora.dev',
    fullName: 'Chen Wei',
    role: RoleName.Creator,
  },
  {
    key: 'user:aurora-assessor',
    tenantId: DEMO_TENANTS.aurora.id,
    email: 'assessor@aurora.dev',
    fullName: 'Ravi Menon',
    role: RoleName.Assessor,
  },
  {
    key: 'user:aurora-developer',
    tenantId: DEMO_TENANTS.aurora.id,
    email: 'developer@aurora.dev',
    fullName: 'Dana Iyer',
    role: RoleName.Developer,
  },
  {
    key: 'user:aurora-viewer',
    tenantId: DEMO_TENANTS.aurora.id,
    email: 'viewer@aurora.dev',
    fullName: 'Vikram Rao',
    role: RoleName.Viewer,
  },
  {
    key: 'user:northwind-admin',
    tenantId: DEMO_TENANTS.northwind.id,
    email: 'admin@northwind.dev',
    fullName: 'Nora Lindqvist',
    role: RoleName.TenantAdmin,
  },
  // The same person in two tenants — demonstrates the workspace switcher (FR-1.4).
  {
    key: 'user:multi:aurora',
    tenantId: DEMO_TENANTS.aurora.id,
    email: 'priya@void-space.dev',
    fullName: 'Priya Nair',
    role: RoleName.Creator,
  },
  {
    key: 'user:multi:northwind',
    tenantId: DEMO_TENANTS.northwind.id,
    email: 'priya@void-space.dev',
    fullName: 'Priya Nair',
    role: RoleName.Assessor,
  },
];

/** The fixed, platform-defined role set (§3.6). */
const ROLE_DEFINITIONS: readonly { name: RoleName; description: string }[] = [
  {
    name: RoleName.SuperAdmin,
    description: 'Platform operator; manages tenants and global configuration.',
  },
  {
    name: RoleName.TenantAdmin,
    description: 'Manages one organization: users, roles, API keys and settings.',
  },
  {
    name: RoleName.Creator,
    description: 'Produces or sources 3D assets and submits them for review.',
  },
  {
    name: RoleName.Assessor,
    description: 'Reviews assets and approves, rejects or requests revisions.',
  },
  { name: RoleName.Developer, description: 'Consumes the REST API programmatically.' },
  { name: RoleName.Viewer, description: 'Read-only access to the published catalogue.' },
];

export interface SeedSummary {
  readonly tenants: number;
  readonly users: number;
  readonly assets: number;
  /** Licences present after seeding. Zero on a fresh seed by design — see the note below. */
  readonly licenses: number;
  readonly auditEntries: number;
  readonly apiKey: { readonly label: string; readonly key: string } | null;
}

async function seedRoles(): Promise<Map<RoleName, string>> {
  const roles = new Map<RoleName, string>();
  for (const definition of ROLE_DEFINITIONS) {
    const role = await platformPrisma.role.upsert({
      where: { name: definition.name },
      update: { description: definition.description },
      create: { id: demoId(`role:${definition.name}`), ...definition },
      select: { id: true },
    });
    roles.set(definition.name, role.id);
  }
  return roles;
}

async function seedTenantRow(spec: { id: string; name: string; slug: string }): Promise<void> {
  // The active-tenant context must equal the row id: the tenants policy (§5.3)
  // permits inserting/reading only the tenant it is currently acting as.
  await withTenant(spec.id, async (db) => {
    await db.tenant.upsert({
      where: { id: spec.id },
      update: { name: spec.name, slug: spec.slug },
      create: { id: spec.id, name: spec.name, slug: spec.slug, status: TenantStatus.active },
    });
    await db.tenantSettings.upsert({
      where: { tenantId: spec.id },
      update: {},
      create: {
        id: demoId(`settings:${spec.slug}`),
        tenantId: spec.id,
        defaultPolycountBudget: 50_000,
        requiredMetadataFields: ['tags'],
        allowedCategories: ['Machinery', 'Safety Equipment', 'Environment', 'Prop', 'Vehicle', 'Anatomy'],
      },
    });

    // FR-13.1 — tenant lifecycle is part of the audit trail too.
    await db.auditLog.upsert({
      where: { id: demoId(`audit:tenant:${spec.slug}:created`) },
      update: {},
      create: {
        id: demoId(`audit:tenant:${spec.slug}:created`),
        tenantId: spec.id,
        actorLabel: 'platform-provisioning',
        action: 'tenant.created',
        entityType: 'tenant',
        entityId: spec.id,
        afterState: { name: spec.name, slug: spec.slug, status: 'active' },
      },
    });
  });
}

/** Maps a demo user to the short key used by the asset fixtures. */
function userKeyFor(role: RoleName): string {
  switch (role) {
    case RoleName.SuperAdmin:
      return 'superadmin';
    case RoleName.TenantAdmin:
      return 'admin';
    case RoleName.Creator:
      return 'creator';
    case RoleName.Assessor:
      return 'assessor';
    case RoleName.Developer:
      return 'developer';
    case RoleName.Viewer:
      return 'viewer';
  }
}

/**
 * Creates one Developer API key for the demo tenant.
 *
 * The raw key is printed once (NFR-SEC.7); only the salted scrypt hash is stored.
 * Re-running the seed keeps the existing key rather than silently rotating it,
 * because the raw value cannot be recovered from the hash — unless the stored
 * prefix shows the key predates the current format (which embeds the tenant id),
 * in which case it is replaced so the printed demo key actually works.
 */
async function seedApiKey(
  tenantId: string,
  userId: string,
  label: string,
): Promise<{ label: string; key: string } | null> {
  const id = demoId(`apikey:${tenantId}:${label}`);
  const generated = generateApiKey(tenantId, 'demo');

  const existing = await withTenant(tenantId, (db) =>
    db.apiKey.findUnique({ where: { id }, select: { id: true, prefix: true } }),
  );

  if (existing?.prefix === generated.prefix) return null;

  if (existing) {
    // Legacy/partial key from an older seed run: replace it.
    await withTenant(tenantId, (db) => db.apiKey.delete({ where: { id } }));
  }

  await withTenant(tenantId, (db) =>
    db.apiKey.create({
      data: {
        id,
        tenantId,
        userId,
        label,
        prefix: generated.prefix,
        hashedKey: generated.hashedKey,
      },
    }),
  );
  return { label, key: generated.key };
}

/** Seeds the whole demo dataset. Returns counters for the CLI summary. */
export async function runSeed(): Promise<SeedSummary> {
  loadRootEnv();

  const roleIds = await seedRoles();
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  await seedTenantRow(DEMO_TENANTS.platform);
  await seedTenantRow(DEMO_TENANTS.aurora);
  await seedTenantRow(DEMO_TENANTS.northwind);

  // Short user keys per tenant ('creator', 'assessor', 'admin', …). First user
  // with a given role wins, so dedicated demo accounts take precedence over the
  // multi-tenant persona.
  const usersByTenant = new Map<string, Record<string, string>>();
  for (const spec of DEMO_USERS) {
    const userId = await seedUser(spec, roleIds, passwordHash);
    const bucket = usersByTenant.get(spec.tenantId) ?? {};
    const shortKey = userKeyFor(spec.role);
    bucket[shortKey] ??= userId;
    usersByTenant.set(spec.tenantId, bucket);
  }

  const auroraUsers = usersByTenant.get(DEMO_TENANTS.aurora.id) ?? {};
  const northwindUsers = usersByTenant.get(DEMO_TENANTS.northwind.id) ?? {};

  const aurora = await seedTenantAssets(
    DEMO_TENANTS.aurora.id,
    DEMO_ASSETS.aurora,
    auroraUsers,
  );
  const northwind = await seedTenantAssets(
    DEMO_TENANTS.northwind.id,
    DEMO_ASSETS.northwind,
    northwindUsers,
  );

  const developerId = auroraUsers.developer;
  const apiKey =
    developerId !== undefined
      ? await seedApiKey(DEMO_TENANTS.aurora.id, developerId, 'Demo developer key')
      : null;

  // Counted rather than assumed: the seed creates no licences (a licence mirrors an on-chain
  // token, and only a real mint may create one), so this reports what is actually there when
  // seeding on top of an existing database.
  //
  // Counted per tenant, inside each tenant's context: `licenses` is a content table, so the
  // platform role is denied it by design (§5.3) — a cross-tenant count is not something this
  // process is allowed to do, and it should not be.
  const licenses =
    (await withTenant(DEMO_TENANTS.aurora.id, (db) => db.license.count())) +
    (await withTenant(DEMO_TENANTS.northwind.id, (db) => db.license.count()));

  return {
    tenants: 3,
    users: DEMO_USERS.length,
    assets: aurora.assets + northwind.assets,
    licenses,
    auditEntries: aurora.auditEntries + northwind.auditEntries,
    apiKey,
  };
}

export function printSummary(summary: SeedSummary): void {
  const lines = [
    '',
    '  VOID·SPACE demo data ready',
    '  ─────────────────────────────────────────────────────────────',
    `  tenants        ${summary.tenants}`,
    `  users          ${summary.users}`,
    `  assets         ${summary.assets}`,
    `  licences       ${summary.licenses}`,
    `  audit entries  ${summary.auditEntries}`,
    ...(summary.licenses === 0
      ? [
          '',
          '  No licences yet — the catalogue is empty until something is published,',
          '  because a licence mirrors a real on-chain token. Mint them with:',
          '    pnpm demo:publish      (or click PUBLISH in the console)',
        ]
      : []),
    '',
    '  Sign in at https://localhost with any of:',
    `    admin@aurora.dev        TenantAdmin  (Aurora)`,
    `    creator@aurora.dev      Creator      (Aurora)`,
    `    assessor@aurora.dev     Assessor     (Aurora)`,
    `    developer@aurora.dev    Developer    (Aurora)`,
    `    viewer@aurora.dev       Viewer       (Aurora)`,
    `    admin@northwind.dev     TenantAdmin  (Northwind)`,
    `    priya@void-space.dev    Creator in Aurora + Assessor in Northwind`,
    `    superadmin@void-space.dev  SuperAdmin (platform)`,
    `  password: ${DEMO_PASSWORD}`,
  ];
  if (summary.apiKey) {
    lines.push('', `  API key (${summary.apiKey.label}) — shown once:`, `    ${summary.apiKey.key}`);
  } else {
    lines.push('', '  API key: an existing demo key was kept (rotate it from the UI).');
  }
  lines.push('');
  console.log(lines.join('\n'));
}

async function seedUser(
  spec: DemoUserSpec,
  roleIds: Map<RoleName, string>,
  passwordHash: string,
): Promise<string> {
  const userId = demoId(spec.key);
  await withTenant(spec.tenantId, async (db) => {
    await db.user.upsert({
      where: { id: userId },
      update: { fullName: spec.fullName, status: UserStatus.active },
      create: {
        id: userId,
        tenantId: spec.tenantId,
        email: spec.email,
        fullName: spec.fullName,
        passwordHash,
        status: UserStatus.active,
      },
    });

    const roleId = roleIds.get(spec.role);
    if (!roleId) throw new Error(`[seed] role ${spec.role} was not seeded`);

    await db.userRole.upsert({
      where: { userId_tenantId: { userId, tenantId: spec.tenantId } },
      update: { roleId },
      create: { id: demoId(`userrole:${spec.key}`), tenantId: spec.tenantId, userId, roleId },
    });
  });
  return userId;
}

// The CLI entry point lives in ./seed-cli.ts, which loads the root .env before
// importing this module (Prisma clients are built at module-evaluation time).

