/**
 * SIWE routes (FR-2.6).
 *
 *   POST   /api/v1/auth/siwe/nonce            EIP-4361 message to sign
 *   POST   /api/v1/auth/siwe/verify           verify → link (cookie) or sign in
 *   GET    /api/v1/auth/wallets               linked wallets for account settings
 *   DELETE /api/v1/auth/wallets/:id           unlink a wallet
 *
 * The verify route is intentionally dual-purpose: with a valid session cookie it
 * *links*; without one it *signs in* an already-linked wallet. Which of the two
 * happens is decided by the presence of an authenticated principal, never by a
 * client-supplied flag.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import type { ApiEnv } from '../../env';
import {
  clearOnboardingCookie,
  cookieSecurity,
  setAccessCookie,
  setRefreshCookie,
} from '../../lib/cookies';
import { parseDurationSeconds } from '../../lib/duration';
import { UnauthenticatedError } from '../../lib/errors';
import { parseBody, parseParams, requestContext } from '../../lib/http';
import { buildAuthService } from './service';
import { createSiweService } from './siwe';

const nonceSchema = z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/) });
const verifySchema = z.object({
  message: z.string().min(40).max(2000),
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
});
const idParams = z.object({ id: z.string().uuid() });

export interface SiweRoutesOptions {
  readonly env: ApiEnv;
}

export async function siweRoutes(app: FastifyInstance, options: SiweRoutesOptions): Promise<void> {
  const { env } = options;
  const secure = cookieSecurity(env);
  const accessMaxAgeSeconds = parseDurationSeconds(env.JWT_ACCESS_TTL, 900);
  const refreshMaxAgeSeconds = parseDurationSeconds(env.JWT_REFRESH_TTL, 604_800);

  const siwe = createSiweService({ env, auth: buildAuthService(app, env) });

  /** Resolves the caller when a session cookie is present, without requiring one. */
  async function optionalPrincipal(request: Parameters<typeof requestContext>[0]) {
    if (!request.cookies?.vs_access) return undefined;
    try {
      await app.authenticate(request);
      return request.principal;
    } catch {
      // A stale cookie must not block a wallet sign-in; treat it as anonymous.
      return undefined;
    }
  }

  app.post('/siwe/nonce', async (request, reply) => {
    const input = parseBody(nonceSchema, request.body);
    const principal = await optionalPrincipal(request);
    return reply.status(200).send(siwe.issueChallenge({ address: input.address, principal }));
  });

  app.post('/siwe/verify', async (request, reply) => {
    const input = parseBody(verifySchema, request.body);
    const principal = await optionalPrincipal(request);

    const outcome = await siwe.verify(
      { ...input, principal },
      requestContext(request),
    );

    if (outcome.kind === 'linked') {
      return reply.status(200).send({ linked: true, wallet: outcome.wallet });
    }

    const session = outcome.session;
    setAccessCookie(reply, session.accessToken, {
      secure,
      sameSite: 'lax',
      maxAgeSeconds: accessMaxAgeSeconds,
    });
    if (session.refreshToken) {
      setRefreshCookie(reply, session.refreshToken, {
        secure,
        sameSite: 'lax',
        maxAgeSeconds: refreshMaxAgeSeconds,
      });
    }
    clearOnboardingCookie(reply, secure);
    return reply.status(200).send({
      user: session.session,
      accessTokenExpiresIn: accessMaxAgeSeconds,
    });
  });

  app.get('/wallets', { preHandler: app.authenticate }, async (request, reply) => {
    const principal = request.principal;
    if (!principal) throw new UnauthenticatedError();
    return reply.status(200).send({ wallets: await siwe.listWallets(principal) });
  });

  app.delete('/wallets/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const principal = request.principal;
    if (!principal) throw new UnauthenticatedError();
    const { id } = parseParams(idParams, request.params);
    await siwe.unlink(principal, id);
    return reply.status(204).send();
  });
}
