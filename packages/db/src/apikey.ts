/**
 * API key generation and hashing (SRS FR-12.3, NFR-SEC.7).
 *
 * Keys are shown to the user exactly once, at creation; only a salted scrypt
 * hash is persisted. Format:
 *
 *   vs_<label>_<tenantId-hex>_<random>
 *
 * Embedding the tenant id lets the API resolve an incoming key to its tenant
 * *before* running a query. That matters because `api_keys` is tenant-scoped and
 * RLS-protected: a cross-tenant lookup would require exactly the platform-role
 * access §5.3 denies. The id is an opaque identifier, not a secret.
 *
 * Stored hash format: `v1$scrypt$<salt-base64>$<derived-key-base64>`, versioned so
 * the algorithm can be rotated without a data migration.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const API_KEY_PREFIX = 'vs_';
export const API_KEY_HASH_VERSION = 'v1';
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** scrypt cost parameters (N=2^15) — deliberately slow for an offline attack. */
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GeneratedApiKey {
  /** The raw key — return it to the caller once, then forget it. */
  readonly key: string;
  /** Short public identifier for the UI and logs (never secret). */
  readonly prefix: string;
  /** What gets stored in ApiKey.hashedKey. */
  readonly hashedKey: string;
}

export interface ParsedApiKey {
  readonly tenantId: string;
  readonly label: string;
  readonly prefix: string;
}

function scrypt(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, KEY_BYTES, SCRYPT_OPTIONS);
}

export function hashApiKey(rawKey: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scrypt(rawKey, salt);
  return [API_KEY_HASH_VERSION, 'scrypt', salt.toString('base64'), derived.toString('base64')].join(
    '$',
  );
}

export function verifyApiKey(rawKey: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 4) return false;

  const [version, algorithm, saltB64, hashB64] = parts;
  if (version !== API_KEY_HASH_VERSION || algorithm !== 'scrypt' || !saltB64 || !hashB64) {
    return false;
  }

  const expected = Buffer.from(hashB64, 'base64');
  const candidate = scrypt(rawKey, Buffer.from(saltB64, 'base64'));
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

/** Converts a 32-char hex string (a UUID without dashes) back into UUID form. */
function hexToUuid(hex: string): string | null {
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
  return UUID_PATTERN.test(uuid) ? uuid.toLowerCase() : null;
}

/**
 * Creates a new key for a tenant. `labelPrefix` is embedded so a key is
 * recognisable in logs, e.g. `vs_dev_0f5b…`.
 */
export function generateApiKey(tenantId: string, labelPrefix = 'dev'): GeneratedApiKey {
  if (!UUID_PATTERN.test(tenantId)) {
    throw new Error(`[db] generateApiKey requires a UUID tenantId (received: ${tenantId})`);
  }
  const tenantHex = tenantId.replace(/-/g, '').toLowerCase();
  const random = randomBytes(24).toString('base64url');
  const key = `${API_KEY_PREFIX}${labelPrefix}_${tenantHex}_${random}`;
  return {
    key,
    // Enough of the key to identify it in the UI without revealing the secret.
    prefix: `${API_KEY_PREFIX}${labelPrefix}_${tenantHex.slice(0, 8)}`,
    hashedKey: hashApiKey(key),
  };
}

/**
 * Parses a presented key. Returns null for anything malformed, so callers can
 * answer 401 without touching the database.
 */
export function parseApiKey(rawKey: string): ParsedApiKey | null {
  const match = /^vs_([A-Za-z0-9]+)_([0-9a-fA-F]{32})_([A-Za-z0-9_-]{16,})$/.exec(rawKey);
  if (!match) return null;

  const label = match[1] as string;
  const tenantId = hexToUuid(match[2] as string);
  if (!tenantId) return null;

  return {
    tenantId,
    label,
    prefix: `${API_KEY_PREFIX}${label}_${(match[2] as string).slice(0, 8).toLowerCase()}`,
  };
}

