/**
 * Refresh-token sessions (SRS FR-2.3 rotating refresh token, FR-2.7 invalidation,
 * §3.7 session strategy).
 *
 * Design
 * ------
 * - The refresh token is `<tenantHex>.<secret>`. Embedding the tenant id means a
 *   presented token can be resolved to its tenant *before* any query, which is
 *   what keeps `sessions` tenant-scoped and RLS-protected (a cross-tenant lookup
 *   would require the platform-role access §5.3 denies).
 * - Only a SHA-256 hash of the secret is stored, so a database leak yields no
 *   usable sessions.
 * - Every refresh rotates: the old row is revoked with `replacedById` pointing at
 *   its successor. Presenting an already-revoked token means the cookie leaked,
 *   so the whole family for that user/tenant is revoked (reuse detection).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Prisma } from '@void-space/db';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_BYTES = 48;

export interface ParsedRefreshToken {
  readonly tenantId: string;
  readonly tokenHash: string;
}

export function hashRefreshSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Creates a new refresh token; only the hash is ever persisted. */
export function generateRefreshToken(tenantId: string): { token: string; tokenHash: string } {
  if (!UUID_PATTERN.test(tenantId)) {
    throw new Error(`[auth] generateRefreshToken requires a UUID tenantId (received: ${tenantId})`);
  }
  const tenantHex = tenantId.replace(/-/g, '').toLowerCase();
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return {
    token: `${tenantHex}.${secret}`,
    tokenHash: hashRefreshSecret(secret),
  };
}

/** Parses a presented refresh token; returns null when malformed. */
export function parseRefreshToken(token: string | undefined): ParsedRefreshToken | null {
  if (!token) return null;

  const separator = token.indexOf('.');
  if (separator === -1) return null;

  const hex = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (!/^[0-9a-f]{32}$/i.test(hex) || secret.length < 32) return null;

  const tenantId = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ]
    .join('-')
    .toLowerCase();

  if (!UUID_PATTERN.test(tenantId)) return null;

  return { tenantId, tokenHash: hashRefreshSecret(secret) };
}

export interface SessionRequestContext {
  readonly userAgent?: string | undefined;
  readonly ipAddress?: string | undefined;
}

/** Creates a session row inside an existing tenant context. */
export async function createSession(
  db: Prisma.TransactionClient,
  params: {
    readonly tenantId: string;
    readonly userId: string;
    readonly tokenHash: string;
    readonly ttlSeconds: number;
    readonly context: SessionRequestContext;
  },
): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000);
  const session = await db.session.create({
    data: {
      tenantId: params.tenantId,
      userId: params.userId,
      tokenHash: params.tokenHash,
      expiresAt,
      userAgent: params.context.userAgent?.slice(0, 300) ?? null,
      ipAddress: params.context.ipAddress?.slice(0, 64) ?? null,
    },
    select: { id: true, expiresAt: true },
  });
  return session;
}

export interface SessionLookupResult {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
}

/** Finds a session by token hash inside a tenant context. */
export async function findSessionByHash(
  db: Prisma.TransactionClient,
  tokenHash: string,
): Promise<SessionLookupResult | null> {
  return db.session.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tenantId: true,
      userId: true,
      expiresAt: true,
      revokedAt: true,
      revokedReason: true,
    },
  });
}

/**
 * Revokes every active session for a membership (FR-2.7): used on password
 * change, role change and tenant suspension.
 */
export async function revokeSessionsForUser(
  db: Prisma.TransactionClient,
  params: {
    readonly tenantId: string;
    readonly userId: string;
    readonly reason: string;
  },
): Promise<number> {
  const result = await db.session.updateMany({
    where: { tenantId: params.tenantId, userId: params.userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: params.reason.slice(0, 120) },
  });
  return result.count;
}

/** Revokes every active session in a tenant (FR-1.5 suspension). */
export async function revokeTenantSessions(
  db: Prisma.TransactionClient,
  params: { readonly tenantId: string; readonly reason: string },
): Promise<number> {
  const result = await db.session.updateMany({
    where: { tenantId: params.tenantId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: params.reason.slice(0, 120) },
  });
  return result.count;
}

/** Revokes a single session, recording what replaced it (rotation chain). */
export async function revokeSession(
  db: Prisma.TransactionClient,
  params: {
    readonly sessionId: string;
    readonly reason: string;
    readonly replacedById?: string | undefined;
  },
): Promise<void> {
  await db.session.update({
    where: { id: params.sessionId },
    data: {
      revokedAt: new Date(),
      revokedReason: params.reason.slice(0, 120),
      replacedById: params.replacedById ?? null,
    },
  });
}

/** Constant-time comparison helper for token-like secrets. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

/**
 * Invitation tokens (FR-2.6) use the same `<tenantHex>.<secret>` envelope as
 * refresh tokens so an invite can be resolved to its tenant before any query.
 */
export function parseInviteToken(token: string): ParsedRefreshToken | null {
  return parseRefreshToken(token);
}

/** Creates an invitation token and its stored hash. */
export function generateInviteToken(tenantId: string): { token: string; tokenHash: string } {
  return generateRefreshToken(tenantId);
}
