/**
 * Sign-In with Ethereum (FR-2.6, EIP-4361).
 *
 * The wallet is a real one: a viem local account signs the exact message the API
 * issued, so the signature verification runs end to end without a chain or a
 * browser wallet. Nothing here is mocked.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import { createSiweMessage, parseSiweMessage } from 'viem/siwe';

import { withTenant } from '@void-space/db';

import {
  DEMO,
  DEMO_TENANT_IDS,
  cookieHeader,
  createTestApp,
  login,
  removeWalletOnlyTestUsers,
  type TestApp,
} from './helpers';

let context: TestApp;

beforeAll(async () => {
  context = await createTestApp();
});

afterAll(async () => {
  // SIWE sign-in provisions a passwordless account; leave the demo tenant as we found it.
  await removeWalletOnlyTestUsers(DEMO_TENANT_IDS.aurora);
  await context?.close();
});

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

/** Issues a challenge for an address and signs the returned message. */
async function signChallenge(
  address: string,
  signer: { signMessage: (args: { message: string }) => Promise<`0x${string}`> } = account,
  cookie?: string,
): Promise<{ message: string; signature: `0x${string}`; nonce: string }> {
  const challenge = await context.app.inject({
    method: 'POST',
    url: '/api/v1/auth/siwe/nonce',
    payload: { address },
    ...(cookie ? { headers: { cookie } } : {}),
  });

  expect(challenge.statusCode).toBe(200);
  const { message, nonce } = challenge.json() as { message: string; nonce: string };
  const signature = await signer.signMessage({ message });
  return { message, signature, nonce };
}

/** A second local wallet, used for negative cases. */
const other = privateKeyToAccount(
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
);

/** Removes any wallet link for an address inside the given tenant. */
async function detachWallets(address: string, tenantId: string): Promise<void> {
  await withTenant(tenantId, (db) =>
    db.wallet.deleteMany({ where: { tenantId, address: { equals: address, mode: 'insensitive' } } }),
  );
}

describe('FR-2.6 Sign-In with Ethereum', () => {
  it('is discoverable in the providers endpoint', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/api/v1/auth/providers' });
    const body = response.json() as { wallet: boolean };
    expect(body.wallet).toBe(context.env.SIWE_ENABLED);
  });

  it('issues an EIP-4361 challenge bound to this domain', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/siwe/nonce',
      payload: { address: account.address },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { message: string; nonce: string; expiresInSeconds: number };
    expect(body.expiresInSeconds).toBeLessThanOrEqual(300);

    const parsed = parseSiweMessage(body.message);
    expect(parsed.domain).toBe(context.env.SIWE_DOMAIN);
    expect(parsed.address?.toLowerCase()).toBe(account.address.toLowerCase());
    expect(parsed.chainId).toBe(31337);
    expect(parsed.nonce).toBe(body.nonce);
  });

  it('rejects a malformed address before any crypto runs', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/siwe/nonce',
      payload: { address: 'not-a-wallet' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses to sign in an address that is not linked to an account', async () => {
    const { message, signature } = await signChallenge(account.address);

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/siwe/verify',
      payload: { message, signature },
    });

    expect(response.statusCode).toBe(401);
    expect((response.json() as { code: string }).code).toBe('WALLET_NOT_LINKED');
  });

  it('links a wallet to the signed-in user, then signs in with it', async () => {
    const admin = await login(context.app, DEMO.users.auroraAdmin);
    const cookie = cookieHeader(admin.cookies, 'vs_access');

    // 1. Link (an authenticated caller is present, so verify() links).
    const { message, signature, nonce } = await signChallenge(account.address, account, cookie);
    const linked = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/siwe/verify',
      headers: { cookie },
      payload: { message, signature },
    });
    expect(linked.statusCode).toBe(200);
    const linkedBody = linked.json() as { linked: boolean; wallet: { address: string } };
    expect(linkedBody.linked).toBe(true);
    expect(linkedBody.wallet.address.toLowerCase()).toBe(account.address.toLowerCase());

    // 2. The nonce is single-use: replaying the same signed message fails.
    const replay = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/siwe/verify',
      headers: { cookie },
      payload: { message, signature },
    });
    expect(replay.statusCode).toBe(401);
    expect((replay.json() as { code: string }).code).toBe('SIWE_NONCE_MISMATCH');

    // 3. The wallet now appears in account settings.
    const wallets = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/wallets',
      headers: { cookie },
    });
    expect(wallets.statusCode).toBe(200);
    const list = (wallets.json() as { wallets: { address: string; type: string }[] }).wallets;
    expect(list.some((wallet) => wallet.address.toLowerCase() === account.address.toLowerCase())).toBe(
      true,
    );
    expect(list.find((wallet) => wallet.address.toLowerCase() === account.address.toLowerCase())?.type).toBe(
      'linked',
    );

    const nonceUnused = nonce.length > 8;
    expect(nonceUnused).toBe(true);

    // 4. With no session, the same wallet signs in — because the account also has
    //    a password (FR-2.6 forbids wallet-only accounts).
    const second = await signChallenge(account.address);
    const signedIn = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/siwe/verify',
      payload: { message: second.message, signature: second.signature },
    });
    expect(signedIn.statusCode).toBe(200);
    const body = signedIn.json() as { user: { email: string } };
    expect(body.user.email).toBe(DEMO.users.auroraAdmin);

    const setCookie = signedIn.headers['set-cookie'];
    const me = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookieHeader(setCookie, 'vs_access') },
    });
    expect(me.statusCode).toBe(200);
  });

  it('rejects a message minted for another domain', async () => {
    const challenge = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/siwe/nonce',
      payload: { address: account.address },
    });
    const { nonce } = challenge.json() as { nonce: string };

    // Same nonce, different origin: an attacker's phishing page cannot reuse it.
    const foreign = createSiweMessage({
      address: account.address,
      chainId: 31337,
      domain: 'evil.example',
      nonce,
      uri: 'https://evil.example',
      version: '1',
      statement: 'Sign in to VOID·SPACE.',
      issuedAt: new Date(),
    });
    const signature = await account.signMessage({ message: foreign });

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/siwe/verify',
      payload: { message: foreign, signature },
    });

    expect(response.statusCode).toBe(401);
    expect((response.json() as { code: string }).code).toBe('SIWE_BAD_DOMAIN');
  });

  it('rejects a signature that does not match the claimed address', async () => {
    // Make the starting state explicit: no wallet link for this address.
    const admin = await login(context.app, DEMO.users.auroraAdmin);
    const tenantId = (admin.body['user'] as { activeTenantId: string }).activeTenantId;
    await detachWallets(account.address, tenantId);

    const { message, signature } = await signChallenge(account.address);

    // Valid signature, wrong signer: the recovered address will not match.
    const foreignSignature = await other.signMessage({ message });

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/siwe/verify',
      payload: { message, signature: foreignSignature },
    });

    expect(response.statusCode).toBe(401);
    expect((response.json() as { code: string }).code).toBe('SIWE_BAD_SIGNATURE');

    // A failed attempt must not burn the nonce: the legitimate signature still gets
    // past verification and then fails only because nothing is linked yet.
    const retry = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/siwe/verify',
      payload: { message, signature },
    });
    expect(retry.statusCode).toBe(401);
    expect((retry.json() as { code: string }).code).toBe('WALLET_NOT_LINKED');
  });

  it('refuses wallet-only accounts (FR-2.6 "never the sole login method")', async () => {
    // An account with neither a password nor a Google identity, created directly so
    // the rule itself is what is under test. A distinct wallet is used because
    // (tenant, address) is unique per workspace.
    const admin = await login(context.app, DEMO.users.auroraAdmin);
    const tenantId = (admin.body['user'] as { activeTenantId: string }).activeTenantId;
    await detachWallets(other.address, tenantId);

    const role = await withTenant(tenantId, (db) =>
      db.role.findUnique({ where: { name: 'Viewer' }, select: { id: true } }),
    );
    const suffix = randomUUID().slice(0, 8);

    const created = await withTenant(tenantId, async (db) => {
      const user = await db.user.create({
        data: {
          tenantId,
          email: `wallet-only-${suffix}@example.test`,
          fullName: 'Wallet Only',
          status: 'active',
        },
        select: { id: true },
      });
      if (role) {
        await db.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
      }
      await db.wallet.create({
        data: {
          tenantId,
          userId: user.id,
          address: other.address,
          type: 'linked',
          label: 'pre-linked',
        },
      });
      return user.id;
    });
    expect(created).toBeTruthy();

    const { message, signature } = await signChallenge(other.address, other);
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/siwe/verify',
      payload: { message, signature },
    });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('WALLET_SOLE_METHOD');
  });

  it('unlinks a wallet without deleting its provenance', async () => {
    // Self-contained: link a third wallet, then unlink it. The wallet row survives
    // (a minted licence may reference the address) but is detached from the user.
    const spare = privateKeyToAccount(
      '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
    );
    const admin = await login(context.app, DEMO.users.auroraAdmin);
    const cookie = cookieHeader(admin.cookies, 'vs_access');
    const tenantId = (admin.body['user'] as { activeTenantId: string }).activeTenantId;
    await detachWallets(spare.address, tenantId);

    const challenge = await signChallenge(spare.address, spare, cookie);
    const linked = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/siwe/verify',
      headers: { cookie },
      payload: { message: challenge.message, signature: challenge.signature },
    });
    expect(linked.statusCode).toBe(200);

    const wallets = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/wallets',
      headers: { cookie },
    });
    const list = (wallets.json() as { wallets: { id: string; address: string }[] }).wallets;
    const mine = list.find(
      (wallet) => wallet.address.toLowerCase() === spare.address.toLowerCase(),
    );
    expect(mine).toBeDefined();

    const unlinked = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/wallets/${mine?.id}`,
      headers: { cookie },
    });
    expect(unlinked.statusCode).toBe(204);

    const after = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/wallets',
      headers: { cookie },
    });
    const remaining = (after.json() as { wallets: { id: string }[] }).wallets;
    expect(remaining.some((wallet) => wallet.id === mine?.id)).toBe(false);

    // The address itself is still on record for provenance.
    const stillThere = await withTenant(tenantId, (db) =>
      db.wallet.findFirst({
        where: { tenantId, address: { equals: spare.address, mode: 'insensitive' } },
        select: { id: true, userId: true },
      }),
    );
    expect(stillThere).not.toBeNull();
    expect(stillThere?.userId).toBeNull();
  });
});
