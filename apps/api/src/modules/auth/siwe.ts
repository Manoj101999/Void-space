/**
 * Sign-In with Ethereum (SRS FR-2.6, EIP-4361, §3.7).
 *
 * Two rules from the SRS shape this module:
 *
 * 1. **"Never as the sole login method."** A wallet can be *linked* to an account
 *    that already has a password or a Google identity, and can then sign in. A
 *    wallet-only account is refused at verification time.
 * 2. **Additive and optional.** With SIWE_ENABLED=false the routes answer 503 and
 *    nothing else in the platform changes (NFR-REL.1).
 *
 * Nonces are single-use and short-lived. They live in process memory, which is
 * correct for the single-API-instance local stack; a horizontally scaled deployment
 * should move this map to Redis, which is already part of the compose stack.
 */
import { recordAudit, withPlatform, withTenant } from '@void-space/db';
import type { AuthPrincipal } from '@void-space/types';
import { recoverMessageAddress } from 'viem';
import {
  createSiweMessage,
  generateSiweNonce,
  parseSiweMessage,
} from 'viem/siwe';

import type { ApiEnv } from '../../env';
import {
  ForbiddenError,
  ServiceUnavailableError,
  UnauthenticatedError,
} from '../../lib/errors';
import type { AuthService, AuthenticatedResult } from './service';
import type { SessionRequestContext } from './sessions';

const NONCE_TTL_MS = 5 * 60 * 1000;
const WALLET_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
/** Anvil's chain id — the only chain in this stack (§3.9.1). */
const ANVIL_CHAIN_ID = 31337;

/**
 * Verifies an EIP-191 (`personal_sign`) signature over the SIWE message.
 *
 * `verifySiweMessage` from viem is the same check plus ENS resolution and optional
 * ABI assertions — both of which need an RPC client this route does not have. The
 * address is always hex here (enforced before parsing), so recovering the signer
 * and comparing it is the whole verification; domain, nonce and expiry are enforced
 * by the caller.
 */
async function verifySignature(params: {
  readonly message: string;
  readonly signature: string;
  readonly address: string;
}): Promise<boolean> {
  try {
    const recovered = await recoverMessageAddress({
      message: params.message,
      signature: params.signature as `0x${string}`,
    });
    return recovered.toLowerCase() === params.address.toLowerCase();
  } catch {
    // A malformed signature is a failed verification, not a server error.
    return false;
  }
}

interface NonceRecord {
  readonly nonce: string;
  readonly issuedAt: number;
}

/** address (lowercased) → outstanding nonce. */
const nonces = new Map<string, NonceRecord>();

function pruneExpired(): void {
  const cutoff = Date.now() - NONCE_TTL_MS;
  for (const [address, record] of nonces) {
    if (record.issuedAt < cutoff) nonces.delete(address);
  }
}

export interface SiweLinkResult {
  readonly address: string;
  readonly linkedAt: string;
}

export interface SiweService {
  isEnabled(): boolean;
  /** FR-2.6 step 1 — hand the client an EIP-4361 message to sign. */
  issueChallenge(params: {
    readonly address: string;
    readonly principal?: AuthPrincipal | undefined;
  }): { nonce: string; message: string; expiresInSeconds: number };
  /** FR-2.6 step 2 — verify the signature, then link or sign in. */
  verify(
    params: {
      readonly message: string;
      readonly signature: string;
      readonly principal?: AuthPrincipal | undefined;
    },
    context: SessionRequestContext,
  ): Promise<
    { kind: 'linked'; wallet: SiweLinkResult } | { kind: 'signed-in'; session: AuthenticatedResult }
  >;
  listWallets(principal: AuthPrincipal): Promise<
    { id: string; address: string; type: string; label: string | null; createdAt: string }[]
  >;
  unlink(principal: AuthPrincipal, walletId: string): Promise<void>;
}

export interface SiweDeps {
  readonly env: ApiEnv;
  readonly auth: AuthService;
}

/** Exposed for tests and for the web app's typed client. */
export const SIWE_NONCE_TTL_SECONDS = NONCE_TTL_MS / 1000;

export function createSiweService(deps: SiweDeps): SiweService {
  const enabled = deps.env.SIWE_ENABLED;
  const domain = deps.env.SIWE_DOMAIN;
  const uri = deps.env.SIWE_URI;

  function assertEnabled(): void {
    if (!enabled) {
      throw new ServiceUnavailableError(
        'Wallet sign-in is disabled on this deployment',
        'SIWE_DISABLED',
      );
    }
  }

  function issueChallenge(params: {
    readonly address: string;
    readonly principal?: AuthPrincipal | undefined;
  }): { nonce: string; message: string; expiresInSeconds: number } {
    assertEnabled();
    if (!WALLET_ADDRESS_PATTERN.test(params.address)) {
      throw new UnauthenticatedError('Malformed wallet address', 'SIWE_BAD_ADDRESS');
    }

    pruneExpired();
    const nonce = generateSiweNonce();
    const address = params.address as `0x${string}`;
    nonces.set(address.toLowerCase(), { nonce, issuedAt: Date.now() });

    const message = createSiweMessage({
      address,
      chainId: ANVIL_CHAIN_ID,
      domain,
      nonce,
      uri,
      version: '1',
      // The statement changes with intent, so a message signed to link a wallet
      // cannot be replayed as a sign-in (and vice versa, by policy in verify()).
      statement: params.principal
        ? `Link this wallet to ${params.principal.email} in ${params.principal.tenantName}.`
        : 'Sign in to VOID·SPACE. This request costs no gas and sends no transaction.',
      issuedAt: new Date(),
      expirationTime: new Date(Date.now() + NONCE_TTL_MS),
    });

    return { nonce, message, expiresInSeconds: SIWE_NONCE_TTL_SECONDS };
  }

  /** Resolves which tenant (if any) a wallet address belongs to. */
  async function findWalletOwner(address: string) {
    return withPlatform((db) =>
      db.wallet.findFirst({
        where: { address: { equals: address, mode: 'insensitive' } },
        select: {
          id: true,
          address: true,
          userId: true,
          tenantId: true,
          tenant: { select: { status: true } },
          user: {
            select: { id: true, email: true, status: true, passwordHash: true, googleId: true },
          },
        },
      }),
    );
  }

  async function verify(
    params: {
      readonly message: string;
      readonly signature: string;
      readonly principal?: AuthPrincipal | undefined;
    },
    context: SessionRequestContext,
  ): Promise<
    { kind: 'linked'; wallet: SiweLinkResult } | { kind: 'signed-in'; session: AuthenticatedResult }
  > {
    assertEnabled();

    const parsed = parseSiweMessage(params.message);
    if (!parsed.address || !parsed.nonce) {
      throw new UnauthenticatedError('The SIWE message is incomplete', 'SIWE_INVALID_MESSAGE');
    }
    if (parsed.domain !== domain) {
      // A message minted for another origin must never be accepted here.
      throw new UnauthenticatedError(
        'The SIWE message was issued for another domain',
        'SIWE_BAD_DOMAIN',
      );
    }

    const address = parsed.address;
    const record = nonces.get(address.toLowerCase());
    if (!record || record.nonce !== parsed.nonce) {
      throw new UnauthenticatedError(
        'This sign-in request is unknown or already used',
        'SIWE_NONCE_MISMATCH',
      );
    }
    if (parsed.expirationTime && parsed.expirationTime.getTime() <= Date.now()) {
      throw new UnauthenticatedError('The SIWE message has expired', 'SIWE_MESSAGE_EXPIRED');
    }

    const verified = await verifySignature({
      message: params.message,
      signature: params.signature,
      address,
    });

    if (!verified) {
      throw new UnauthenticatedError('The wallet signature is invalid', 'SIWE_BAD_SIGNATURE');
    }
    // Consumed only after a successful signature check, so a failed attempt can be
    // retried with the same nonce rather than forcing a new challenge.
    nonces.delete(address.toLowerCase());

    const existing = await findWalletOwner(address);
    return params.principal
      ? linkWallet(params.principal, existing, address)
      : signInWithWallet(existing, context, address);
  }

  /** Attaches a wallet to the signed-in caller's account (FR-2.6). */
  async function linkWallet(
    principal: AuthPrincipal,
    existing: Awaited<ReturnType<typeof findWalletOwner>>,
    address: string,
  ): Promise<{ kind: 'linked'; wallet: SiweLinkResult }> {
    if (existing && existing.userId && existing.userId !== principal.userId) {
      throw new ForbiddenError('That wallet is already linked to another account', 'WALLET_IN_USE');
    }

    const wallet = await withTenant(principal.tenantId, async (db) => {
      const row = existing
        ? await db.wallet.update({
            where: { id: existing.id },
            data: { userId: principal.userId },
            select: { id: true, address: true, createdAt: true },
          })
        : await db.wallet.create({
            data: {
              tenantId: principal.tenantId,
              userId: principal.userId,
              address,
              // `linked` = a wallet the user holds (browser wallet or hardware);
              // `managed` is reserved for the platform's own derived wallets (§3.9.3).
              type: 'linked',
              label: 'Linked via SIWE',
            },
            select: { id: true, address: true, createdAt: true },
          });

      await recordAudit(
        {
          action: 'auth.wallet_linked',
          entityType: 'wallet',
          entityId: row.id,
          actorId: principal.userId,
          actorLabel: `${principal.fullName} <${principal.email}>`,
          afterState: { address, type: 'external' },
        },
        db,
      );

      return row;
    });

    return {
      kind: 'linked',
      wallet: { address: wallet.address, linkedAt: wallet.createdAt.toISOString() },
    };
  }

  /** Signs in the owner of an already-linked wallet. */
  async function signInWithWallet(
    existing: Awaited<ReturnType<typeof findWalletOwner>>,
    context: SessionRequestContext,
    address: string,
  ): Promise<{ kind: 'signed-in'; session: AuthenticatedResult }> {
    if (!existing || !existing.userId || !existing.user) {
      throw new UnauthenticatedError(
        'This wallet is not linked to an account. Sign in with your password or Google, then link it.',
        'WALLET_NOT_LINKED',
      );
    }
    if (existing.tenant.status === 'suspended') {
      throw new ForbiddenError('This workspace has been suspended', 'TENANT_SUSPENDED');
    }
    if (existing.user.status !== 'active') {
      throw new ForbiddenError('Account is not active', 'ACCOUNT_INACTIVE');
    }

    // FR-2.6 — a wallet may never be the *sole* login method.
    if (!existing.user.passwordHash && !existing.user.googleId) {
      throw new ForbiddenError(
        'This account has no password or Google identity; add one before signing in with a wallet',
        'WALLET_SOLE_METHOD',
      );
    }

    const session = await deps.auth.loginWithTenant(
      existing.user.id,
      existing.tenantId,
      context,
      'google',
    );

    await withTenant(existing.tenantId, (db) =>
      recordAudit(
        {
          action: 'auth.login',
          entityType: 'wallet',
          entityId: existing.id,
          actorId: existing.user?.id ?? null,
          actorLabel: `SIWE ${address}`,
          afterState: { method: 'siwe', address },
        },
        db,
      ),
    );

    return { kind: 'signed-in', session };
  }

  async function listWallets(principal: AuthPrincipal) {
    const rows = await withTenant(principal.tenantId, (db) =>
      db.wallet.findMany({
        where: { tenantId: principal.tenantId, userId: principal.userId },
        select: { id: true, address: true, type: true, label: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    );

    return rows.map((row) => ({
      id: row.id,
      address: row.address,
      type: row.type as string,
      label: row.label,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async function unlink(principal: AuthPrincipal, walletId: string): Promise<void> {
    assertEnabled();

    await withTenant(principal.tenantId, async (db) => {
      const wallet = await db.wallet.findFirst({
        where: { id: walletId, tenantId: principal.tenantId, userId: principal.userId },
        select: { id: true, address: true },
      });
      if (!wallet) return; // Already gone: unlinking is idempotent.

      // Detach rather than delete: a minted licence may reference the address, and
      // provenance must survive (§3.9.2).
      await db.wallet.update({ where: { id: wallet.id }, data: { userId: null } });

      await recordAudit(
        {
          action: 'auth.wallet_unlinked',
          entityType: 'wallet',
          entityId: wallet.id,
          actorId: principal.userId,
          actorLabel: `${principal.fullName} <${principal.email}>`,
          beforeState: { address: wallet.address },
        },
        db,
      );
    });
  }

  return { isEnabled: () => enabled, issueChallenge, verify, listWallets, unlink };
}
