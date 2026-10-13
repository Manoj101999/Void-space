/**
 * Role-Based Access Control model (SRS §3.6).
 *
 * Roles are platform-defined (fixed for this release) and assigned per user
 * *per tenant*: the same person can be a Creator in one tenant and an Assessor
 * in another. The API enforces permissions in a Fastify preHandler; the web app
 * uses the same matrix to hide actions the caller cannot perform.
 */

export const ROLES = [
  'SuperAdmin',
  'TenantAdmin',
  'Creator',
  'Assessor',
  'Developer',
  'Viewer',
] as const;

export type Role = (typeof ROLES)[number];

/** Admin roles operate at platform level rather than inside one tenant (§2.3). */
export const PLATFORM_ROLES: readonly Role[] = ['SuperAdmin'];

export const PERMISSIONS = [
  /** Manage tenants (create/suspend) — SuperAdmin only. */
  'tenant:manage',
  /** Manage tenant users & roles. */
  'tenant:manage-users',
  /** Upload / edit own assets. */
  'asset:upload-own',
  /** Delete own unpublished assets. */
  'asset:delete-own-unpublished',
  /** View review queue. */
  'review:view-queue',
  /** Approve / reject / request revision. */
  'review:decide',
  /** Publish approved asset (mint license + push to EoN). */
  'asset:publish',
  /** Revoke a published asset's license (FR-9.5, TenantAdmin). */
  'asset:revoke-license',
  /** Create/rotate API keys. */
  'apikey:manage',
  /** Call REST API (scoped). */
  'api:call',
  /** View published catalog. */
  'catalog:view',
  /** View tenant audit log. */
  'audit:view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Transcribed from the §3.6 permission matrix. `true` in the SRS table is
 * represented as membership here; the empty cells ("—") are simply absent.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  SuperAdmin: [
    'tenant:manage',
    'tenant:manage-users',
    'asset:upload-own',
    'asset:delete-own-unpublished',
    'review:view-queue',
    'review:decide',
    'asset:publish',
    'asset:revoke-license',
    'apikey:manage',
    'api:call',
    'catalog:view',
    'audit:view',
  ],
  TenantAdmin: [
    'tenant:manage-users',
    'asset:upload-own',
    'asset:delete-own-unpublished',
    'review:view-queue',
    'review:decide',
    'asset:publish',
    'asset:revoke-license',
    'apikey:manage',
    'api:call',
    'catalog:view',
    'audit:view',
  ],
  Creator: ['asset:upload-own', 'asset:delete-own-unpublished', 'api:call', 'catalog:view'],
  Assessor: ['review:view-queue', 'review:decide', 'asset:publish', 'api:call', 'catalog:view'],
  Developer: ['apikey:manage', 'api:call', 'catalog:view'],
  // Viewer's REST API access is read-only: it may call GET endpoints only.
  Viewer: ['api:call', 'catalog:view'],
};

/** Roles whose API access is restricted to idempotent reads (SRS §3.6). */
export const READ_ONLY_API_ROLES: readonly Role[] = ['Viewer'];

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** True if any of the caller's roles in the active tenant grant the permission. */
export function anyRoleHasPermission(
  roles: readonly Role[],
  permission: Permission,
): boolean {
  return roles.some((role) => roleHasPermission(role, permission));
}

/**
 * Rank used for "Assessor (or higher)" style checks (FR-4.3): a TenantAdmin or
 * SuperAdmin implicitly satisfies an Assessor-gated action; a Creator does not.
 */
export const ROLE_RANK: Readonly<Record<Role, number>> = {
  SuperAdmin: 0,
  TenantAdmin: 1,
  Assessor: 2,
  Creator: 3,
  Developer: 4,
  Viewer: 5,
};

export function isAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] <= ROLE_RANK[minimum];
}

/** Shape of the RBAC matrix as rendered in the admin console / docs. */
export interface RoleMatrixRow {
  readonly permission: Permission;
  readonly label: string;
  readonly grants: Readonly<Record<Role, boolean>>;
}

export const ROLE_MATRIX_LABELS: Readonly<Record<Permission, string>> = {
  'tenant:manage': 'Manage tenants (create/suspend)',
  'tenant:manage-users': 'Manage tenant users & roles',
  'asset:upload-own': 'Upload / edit own assets',
  'asset:delete-own-unpublished': 'Delete own unpublished assets',
  'review:view-queue': 'View review queue',
  'review:decide': 'Approve / reject / request revision',
  'asset:publish': 'Publish approved asset (mint license + push to EoN)',
  'asset:revoke-license': 'Revoke a published license (takedown)',
  'apikey:manage': 'Create/rotate API keys',
  'api:call': 'Call REST API (scoped)',
  'catalog:view': 'View published catalog',
  'audit:view': 'View tenant audit log',
};

export function buildRoleMatrix(): RoleMatrixRow[] {
  return PERMISSIONS.map((permission) => ({
    permission,
    label: ROLE_MATRIX_LABELS[permission],
    grants: Object.fromEntries(
      ROLES.map((role) => [role, roleHasPermission(role, permission)]),
    ) as Record<Role, boolean>,
  }));
}
