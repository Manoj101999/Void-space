/**
 * Security-contract tests for the shared domain types.
 *
 * These assertions are the *executable copy* of two SRS tables — §3.6 (RBAC matrix)
 * and §5.1 (asset lifecycle). If a future edit widens a role's permissions or adds a
 * transition the SRS does not allow, this suite fails; that is what makes the
 * hand-transcription in `src/roles.ts` and `src/assets.ts` trustworthy.
 */
import { describe, expect, it } from 'vitest';

import { canTransition, commentRequiredFor, isDeletable, type AssetStatus } from '../src/assets';
import {
  PERMISSIONS,
  READ_ONLY_API_ROLES,
  ROLE_MATRIX_LABELS,
  ROLE_PERMISSIONS,
  ROLES,
  anyRoleHasPermission,
  buildRoleMatrix,
  isAtLeast,
  roleHasPermission,
  type Permission,
  type Role,
} from '../src/roles';
import { BULLMQ_STATE_TO_JOB_STATUS, JOB_STATUSES, QUEUE_NAMES, QUEUE_POLICIES } from '../src/queues';

/**
 * Transcribed from the SRS §3.6 table row by row: `true` = the cell contains ✔.
 * Keeping the expectation in this literal form (rather than re-deriving it from
 * ROLE_PERMISSIONS) is the point — it is an independent statement of the spec.
 */
const MATRIX: Record<Permission, Record<Role, boolean>> = {
  'tenant:manage': {
    SuperAdmin: true,
    TenantAdmin: false,
    Creator: false,
    Assessor: false,
    Developer: false,
    Viewer: false,
  },
  'tenant:manage-users': {
    SuperAdmin: true,
    TenantAdmin: true,
    Creator: false,
    Assessor: false,
    Developer: false,
    Viewer: false,
  },
  'asset:upload-own': {
    SuperAdmin: true,
    TenantAdmin: true,
    Creator: true,
    Assessor: false,
    Developer: false,
    Viewer: false,
  },
  'asset:delete-own-unpublished': {
    SuperAdmin: true,
    TenantAdmin: true,
    Creator: true,
    Assessor: false,
    Developer: false,
    Viewer: false,
  },
  'review:view-queue': {
    SuperAdmin: true,
    TenantAdmin: true,
    Creator: false,
    Assessor: true,
    Developer: false,
    Viewer: false,
  },
  'review:decide': {
    SuperAdmin: true,
    TenantAdmin: true,
    Creator: false,
    Assessor: true,
    Developer: false,
    Viewer: false,
  },
  'asset:publish': {
    SuperAdmin: true,
    TenantAdmin: true,
    Creator: false,
    Assessor: true,
    Developer: false,
    Viewer: false,
  },
  'asset:revoke-license': {
    SuperAdmin: true,
    TenantAdmin: true,
    Creator: false,
    Assessor: false,
    Developer: false,
    Viewer: false,
  },
  'apikey:manage': {
    SuperAdmin: true,
    TenantAdmin: true,
    Creator: false,
    Assessor: false,
    Developer: true,
    Viewer: false,
  },
  'api:call': {
    SuperAdmin: true,
    TenantAdmin: true,
    Creator: true,
    Assessor: true,
    Developer: true,
    Viewer: true,
  },
  'catalog:view': {
    SuperAdmin: true,
    TenantAdmin: true,
    Creator: true,
    Assessor: true,
    Developer: true,
    Viewer: true,
  },
  'audit:view': {
    SuperAdmin: true,
    TenantAdmin: true,
    Creator: false,
    Assessor: false,
    Developer: false,
    Viewer: false,
  },
};

describe('§3.6 RBAC matrix', () => {
  it('covers every permission and every role in the SRS table', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...PERMISSIONS].sort());
    for (const cells of Object.values(MATRIX)) {
      expect(Object.keys(cells).sort()).toEqual([...ROLES].sort());
    }
  });

  it.each(Object.entries(MATRIX))('%s matches the SRS table for every role', (permission, cells) => {
    for (const role of ROLES) {
      expect(roleHasPermission(role, permission as Permission)).toBe(cells[role]);
    }
  });

  it('grants SuperAdmin every permission (§3.5 platform operator)', () => {
    expect([...ROLE_PERMISSIONS.SuperAdmin].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('withholds tenant management from every non-SuperAdmin role', () => {
    for (const role of ROLES.filter((candidate) => candidate !== 'SuperAdmin')) {
      expect(roleHasPermission(role, 'tenant:manage')).toBe(false);
    }
  });

  it('keeps the Viewer out of every write permission', () => {
    const writes: Permission[] = [
      'tenant:manage',
      'tenant:manage-users',
      'asset:upload-own',
      'asset:delete-own-unpublished',
      'review:decide',
      'asset:publish',
      'asset:revoke-license',
      'apikey:manage',
    ];
    for (const permission of writes) {
      expect(roleHasPermission('Viewer', permission)).toBe(false);
    }
  });

  it('treats Viewer as the only read-only API role (§3.6)', () => {
    expect(READ_ONLY_API_ROLES).toEqual(['Viewer']);
  });

  it('unions permissions across a multi-role membership without inventing any', () => {
    expect(anyRoleHasPermission(['Creator', 'Assessor'], 'review:decide')).toBe(true);
    expect(anyRoleHasPermission(['Creator', 'Developer'], 'apikey:manage')).toBe(true);
    expect(anyRoleHasPermission(['Creator', 'Assessor'], 'tenant:manage')).toBe(false);
    expect(anyRoleHasPermission([], 'catalog:view')).toBe(false);
  });

  it('orders roles for "or higher" checks (FR-4.3)', () => {
    expect(isAtLeast('SuperAdmin', 'Viewer')).toBe(true);
    expect(isAtLeast('TenantAdmin', 'Assessor')).toBe(true);
    expect(isAtLeast('Viewer', 'SuperAdmin')).toBe(false);
    expect(isAtLeast('Creator', 'Creator')).toBe(true);
  });

  it('labels every permission for the admin console and renders the matrix', () => {
    for (const permission of PERMISSIONS) {
      expect(ROLE_MATRIX_LABELS[permission].length).toBeGreaterThan(5);
    }

    const rows = buildRoleMatrix();
    expect(rows).toHaveLength(PERMISSIONS.length);
    const audit = rows.find((entry) => entry.permission === 'audit:view');
    expect(audit?.grants.SuperAdmin).toBe(true);
    expect(audit?.grants.Creator).toBe(false);
    // The rendered matrix must agree with the guard used at request time.
    for (const row of rows) {
      for (const role of ROLES) {
        expect(row.grants[role]).toBe(roleHasPermission(role, row.permission));
      }
    }
  });
});

describe('§5.1 asset lifecycle', () => {
  it('follows the documented transitions exactly', () => {
    const allowed: [AssetStatus, AssetStatus][] = [
      ['draft', 'pending'],
      ['draft', 'needs_manual_review'],
      ['pending', 'approved'],
      ['pending', 'rejected'],
      ['pending', 'revision'],
      ['pending', 'needs_manual_review'],
      ['needs_manual_review', 'approved'],
      ['needs_manual_review', 'rejected'],
      ['needs_manual_review', 'revision'],
      ['approved', 'published'],
      ['approved', 'revision'],
      ['rejected', 'pending'],
      ['revision', 'pending'],
    ];

    for (const [from, to] of allowed) {
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it('refuses the shortcuts the SRS does not allow', () => {
    const denied: [AssetStatus, AssetStatus][] = [
      // Nothing is published without passing approval (FR-4.6, FR-6.x).
      ['draft', 'published'],
      ['pending', 'published'],
      ['needs_manual_review', 'published'],
      ['draft', 'approved'],
      ['rejected', 'approved'],
      ['rejected', 'published'],
      ['revision', 'published'],
      // The lifecycle does not run backwards.
      ['approved', 'pending'],
      ['published', 'draft'],
      // `published` is terminal: a published asset is revoked, never edited (§5.1).
      ['published', 'published'],
      ['published', 'revision'],
    ];

    for (const [from, to] of denied) {
      expect(canTransition(from, to)).toBe(false);
    }
  });

  it('allows deletion only before approval (FR-3.6)', () => {
    expect(isDeletable('draft')).toBe(true);
    expect(isDeletable('pending')).toBe(true);
    expect(isDeletable('revision')).toBe(true);
    expect(isDeletable('rejected')).toBe(true);
    expect(isDeletable('needs_manual_review')).toBe(false);
    expect(isDeletable('approved')).toBe(false);
    expect(isDeletable('published')).toBe(false);
  });

  it('requires a comment when requesting changes or rejecting (FR-4.2)', () => {
    expect(commentRequiredFor('revision')).toBe(true);
    expect(commentRequiredFor('rejected')).toBe(true);
    expect(commentRequiredFor('approved')).toBe(false);
  });
});

describe('§3.10 queue policies', () => {
  it('defines exactly one policy per queue', () => {
    expect(Object.keys(QUEUE_POLICIES).sort()).toEqual([...QUEUE_NAMES].sort());
    for (const name of QUEUE_NAMES) {
      expect(QUEUE_POLICIES[name].name).toBe(name);
    }
  });

  it('gives every queue a sane attempt budget, backoff and concurrency', () => {
    for (const name of QUEUE_NAMES) {
      const policy = QUEUE_POLICIES[name];
      expect(policy.attempts).toBeGreaterThanOrEqual(1);
      expect(policy.backoff.delayMs).toBeGreaterThan(0);
      expect(policy.defaultConcurrency).toBeGreaterThan(0);
      expect(policy.policy.length).toBeGreaterThan(10);
    }
  });

  it('retries the queues that depend on an external service', () => {
    // Anvil, IPFS and EoN can all be briefly unavailable (NFR-REL.1).
    for (const name of ['ipfs-pin', 'chain-license', 'xr-publish', 'notify'] as const) {
      expect(QUEUE_POLICIES[name].attempts).toBeGreaterThanOrEqual(2);
    }
  });

  it('maps every BullMQ state onto a job status (FR-11.2)', () => {
    const mapped = Object.values(BULLMQ_STATE_TO_JOB_STATUS);
    for (const status of mapped) {
      expect(JOB_STATUSES).toContain(status);
    }
    // States the UI must be able to show for an in-flight job.
    expect(mapped).toContain('queued');
    expect(mapped).toContain('active');
    expect(mapped).toContain('completed');
    expect(mapped).toContain('failed');
  });
});
