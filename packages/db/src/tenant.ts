/**
 * Tenant context: the single way application code reaches tenant-scoped data
 * (SRS §3.5, FR-1.6, NFR-SEC.5).
 *
 * How it works
 * ------------
 * 1. `withTenant(tenantId, fn)` opens an interactive transaction on the
 *    `void_app` pool.
 * 2. It sets the transaction-local session variable `app.current_tenant_id`
 *    (via `set_config(..., is_local => true)`, which is transaction-scoped and
 *    therefore safe with connection pooling — it can never leak to the next
 *    request that borrows the same connection).
 * 3. PostgreSQL RLS policies compare each row's `tenant_id` against that
 *    variable, so cross-tenant reads and writes are impossible even if a query
 *    forgets its WHERE clause.
 * 4. The transaction client is published on AsyncLocalStorage, so every helper
 *    (audit logging, notification fan-out, …) automatically runs in the same
 *    tenant context. Calling `tenantDb()` outside a context throws instead of
 *    silently issuing an unscoped query.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { Prisma } from '../generated/client';
import { platformPrisma, prisma } from './client';

export type TenantClient = Prisma.TransactionClient;

interface TenantStore {
  readonly tenantId: string;
  readonly db: TenantClient;
}

const storage = new AsyncLocalStorage<TenantStore>();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantContextMissingError extends Error {
  constructor(operation: string) {
    super(
      `[db] "${operation}" was called without an active tenant context. ` +
        'Wrap tenant-scoped work in withTenant(tenantId, fn) — a query issued ' +
        'outside that wrapper would be rejected by Row-Level Security anyway.',
    );
    this.name = 'TenantContextMissingError';
  }
}

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function assertUuid(tenantId: string): void {
  if (!isUuid(tenantId)) {
    throw new Error(`[db] withTenant() requires a UUID tenantId (received: ${tenantId})`);
  }
}

export interface WithTenantOptions {
  /** Interactive-transaction timeout in ms (default 20 s; uploads may need more). */
  readonly timeoutMs?: number;
  /** Max time to wait for a pooled connection (default 5 s). */
  readonly maxWaitMs?: number;
}

/**
 * Runs `fn` with tenant isolation enforced by the database.
 *
 * @example
 *   const assets = await withTenant(tenantId, (db) =>
 *     db.asset.findMany({ where: { status: 'pending' } }),
 *   );
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (db: TenantClient) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  assertUuid(tenantId);

  return prisma.$transaction(
    async (tx) => {
      // is_local = true → the setting is discarded when the transaction ends.
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      return storage.run({ tenantId, db: tx }, () => fn(tx));
    },
    {
      maxWait: options.maxWaitMs ?? 5_000,
      timeout: options.timeoutMs ?? 20_000,
    },
  );
}

/**
 * Runs `fn` with the administrative (BYPASSRLS) client.
 *
 * Only for operations that are inherently cross-tenant or platform-level:
 *  - identity resolution during authentication (a user's email must be matched
 *    before any tenant is known),
 *  - listing the tenants a user belongs to for the workspace switcher (FR-1.4),
 *  - SuperAdmin tenant administration (FR-1.5, FR-14.1).
 *
 * It cannot touch asset/review/licence/audit data — that is denied at the
 * database-permission level (§5.3), not by convention.
 */
export async function withPlatform<T>(
  fn: (db: typeof platformPrisma) => Promise<T>,
): Promise<T> {
  return fn(platformPrisma);
}

/** The tenant-scoped transaction client for the current async context. */
export function tenantDb(): TenantClient {
  const store = storage.getStore();
  if (!store) throw new TenantContextMissingError('tenantDb()');
  return store.db;
}

/** The active tenant id, or a thrown error when there is no context. */
export function currentTenantId(): string {
  const store = storage.getStore();
  if (!store) throw new TenantContextMissingError('currentTenantId()');
  return store.tenantId;
}

/** Non-throwing variant, for code paths that adapt to the presence of a context. */
export function tryCurrentTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}

/** True when the current async context is tenant-scoped. */
export function hasTenantContext(): boolean {
  return storage.getStore() !== undefined;
}
