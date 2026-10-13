/**
 * Rate-limit bucket keys (SRS FR-12.4).
 *
 * FR-12.4 requires API-key-authenticated requests to be limited **per key**. The default
 * `@fastify/rate-limit` behaviour buckets by caller address, which is wrong for the machine
 * clients this API exists to serve: forty integrations behind one NAT would share a single
 * 300/minute budget, so the first busy one would 429 the rest. It is also evadable in the other
 * direction — a client wanting more budget need only change its source address.
 *
 * This lives in its own module rather than as an inline closure because the limiter is registered
 * *above* the auth plugin, so it cannot read `request.principal`: the only credential in scope is
 * the raw bearer token. Keeping the rule here makes it directly testable, which an inline closure
 * inside `buildApp` would not be — proving it there would take 300 requests.
 *
 * A *forged* token lands in its own bucket and then fails authentication outright, so varying it
 * buys nothing; a *replayed valid* token maps to the same bucket as its legitimate holder, which
 * is exactly the intent.
 */
import { createHash } from 'node:crypto';

/** How much of the token digest to use. Bucket keys are compared in memory, never stored. */
const KEY_CHARS = 32;

export function rateLimitKey(request: {
  readonly headers: { readonly authorization?: string | undefined };
  readonly ip?: string | undefined;
}): string {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    // Hashed rather than used directly, so a live credential never sits in the limiter's key
    // space — a heap dump or a debug log of the store would otherwise leak working tokens.
    const digest = createHash('sha256').update(header.slice(7), 'utf8').digest('hex');
    return `token:${digest.slice(0, KEY_CHARS)}`;
  }
  return `ip:${request.ip ?? 'unknown'}`;
}
