/**
 * Deterministic identifiers for demo data, shared by the seed modules.
 *
 * Using derived (rather than random) ids keeps `pnpm db:seed` idempotent: running
 * it repeatedly upserts the same rows instead of duplicating the demo tenant.
 */
import { createHash } from 'node:crypto';

/** Stable UUIDv5-style id derived from a demo name. */
export function demoId(name: string): string {
  const hex = createHash('sha256').update(`void-space-demo:${name}`).digest('hex').slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `a${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** Deterministic, well-formed-looking CID (real ones come from the pin worker). */
export function demoCid(name: string): string {
  return `bafybei${createHash('sha256').update(`cid:${name}`).digest('base64url').slice(0, 52)}`;
}

/** Deterministic 32-byte hex string, used for demo transaction hashes. */
export function demoHash(name: string): string {
  return `0x${createHash('sha256').update(`hash:${name}`).digest('hex')}`;
}

/** Deterministic transaction hash for demo chain rows. */
export function demoTxHash(name: string): string {
  return `0x${createHash('sha256').update(`tx:${name}`).digest('hex')}`;
}
