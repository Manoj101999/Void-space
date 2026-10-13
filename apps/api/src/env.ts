/**
 * Environment validation for the API (SRS §9.4).
 *
 * The process refuses to start on a missing or malformed configuration, so a
 * mis-set DATABASE_URL can never silently disable tenant isolation.
 */
import { z } from 'zod';

const booleanish = z
  .string()
  .optional()
  .transform((value) => value === 'true' || value === '1');

/**
 * An empty string in the environment means "not configured".
 *
 * `VAR=` is how a blank value is written in a `.env` file, and zod cannot tell it from a real one: an
 * empty string is *present*, so `.optional()` does not apply and `.url()` rejects it. That turns a
 * line an operator believes is inert into a hard boot failure, reported as
 * `EON_API_URL: Invalid url` — a message that names the variable but not the empty assignment that
 * caused it, and the fix ("delete the line") is not guessable from it.
 *
 * It is safe to read empty as absent here because no setting in this file has a meaningful empty
 * value: every one of them either has a default or is an optional integration whose whole contract is
 * "absent means degrade gracefully" (NFR-REL.1).
 */
const blankAsUnset = (value: unknown) => (value === '' ? undefined : value);

/** An optional string, where `VAR=` is the same as not defining `VAR`. */
const optionalString = z.preprocess(blankAsUnset, z.string().optional());

/** An optional URL, where `VAR=` is the same as not defining `VAR`. */
const optionalUrl = z.preprocess(blankAsUnset, z.string().url().optional());

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** Comma-separated allow-list for browser calls (the edge proxy in front of us). */
  CORS_ORIGINS: z
    .string()
    .default('https://localhost,http://localhost:3000,https://localhost:3000')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  // --- data tier -----------------------------------------------------------
  DATABASE_URL: z.string().url(),
  PLATFORM_DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  IPFS_API_URL: z.string().url(),
  IPFS_GATEWAY_URL: z.string().url(),
  ANVIL_RPC_URL: z.string().url(),

  // --- auth (FR-2.3) -------------------------------------------------------
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  /**
   * FR-2.3 requires Secure cookies; that is the default. A developer who chooses
   * to browse the plain-http origin locally can set COOKIE_SECURE=false.
   */
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((value) => value !== 'false' && value !== '0'),

  // --- optional integrations (absent => graceful degradation, NFR-REL.1) ---
  ANTHROPIC_API_KEY: optionalString,
  /**
   * Block explorer base (e.g. https://sepolia.etherscan.io). Absent means no
   * explorer links are emitted — Anvil has no explorer UI, so a self-link
   * against the RPC port only ever 404s.
   */
  CHAIN_EXPLORER_URL: optionalUrl,
  /**
   * §4.6 third-party sourcing. All optional: absent means the adapter reports itself offline and
   * returns no results, rather than inventing listings. See `modules/tools/service.ts`.
   */
  SKETCHFAB_API_TOKEN: optionalString,
  POLY_PIZZA_API_KEY: optionalString,
  MESHY_API_KEY: optionalString,
  /** The headless Blender runner on the Compose network (FR-6.3). */
  BLENDER_RUNNER_URL: optionalUrl,
  /** EoN Reality in real mode; absent means the documented labelled simulation. */
  EON_API_URL: optionalUrl,
  EON_API_KEY: optionalString,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_REDIRECT_URI: optionalUrl,
  /**
   * Optional blocks 2.6 / EIP-4361 parameters. When SIWE is enabled the signed
   * message's domain and uri must match these, so a message minted for another
   * origin can never be replayed here.
   */
  SIWE_ENABLED: booleanish,
  SIWE_DOMAIN: z.string().default('localhost'),
  SIWE_URI: z.string().default('https://localhost'),

  /** Contract address published by dev-up (§9.3) ------------------------- */
  CONTRACT_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  CONTRACT_STATE_PATH: z.string().optional(),

  // --- uploads (FR-3.1) ----------------------------------------------------
  /**
   * Where an in-flight upload is staged before the `ipfs-pin` worker streams it to
   * IPFS. Kept out of the database for the file bytes themselves: Postgres holds the
   * CID, never the binary (FR-8.1).
   */
  STAGING_DIR: z.string().default('.staging'),
  /** Hard ceiling on total bytes the staging area may hold (NFR-SCAL.3). */
  STAGING_MAX_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024 * 1024),

  // --- AI enrichment (FR-7.x, optional) ------------------------------------
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5-20250929'),
  ANTHROPIC_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

export type ApiEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `[api] invalid environment configuration:\n${details}\n` +
        'Check your .env against .env.example (SRS §9.4).',
    );
  }
  return parsed.data;
}
