/**
 * Password hashing (SRS NFR-SEC.1: salted one-way hash, bcrypt cost factor ≥ 12).
 *
 * Lives in the db package so the seed script and the API's authentication
 * service hash and verify with exactly the same parameters — a drift here would
 * lock users out.
 */
import bcrypt from 'bcryptjs';

/** NFR-SEC.1 — cost factor must be at least 12. */
export const BCRYPT_COST = 12;

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length < 12) {
    throw new Error('[db] password must be at least 12 characters (FR-2.1 policy)');
  }
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

export async function verifyPassword(plaintext: string, hash: string | null): Promise<boolean> {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}

/** True when a stored hash uses the required cost factor (used by tests/audits). */
export function bcryptCostOf(hash: string): number {
  const match = /^\$2[aby]\$(\d{2})\$/.exec(hash);
  return match?.[1] ? Number.parseInt(match[1], 10) : 0;
}
