/**
 * Minimal root-.env loader shared by the db package's Node/tsx scripts.
 *
 * Prisma only loads a `.env` sitting next to the schema, but this monorepo keeps
 * one .env at the repository root (SRS §9.4), so scripts read it explicitly.
 * Values already present in the environment always win.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function parseEnvFile(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

/** Loads the repository-root .env (if present) without clobbering real env vars. */
export function loadRootEnv(): Record<string, string> {
  const envPath = resolve(REPO_ROOT, '.env');
  if (!existsSync(envPath)) return {};

  const parsed = parseEnvFile(readFileSync(envPath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return parsed;
}

/**
 * Returns the migration connection string (schema owner). Falls back to
 * DATABASE_URL so the package still works in single-role environments.
 */
export function migrateDatabaseUrl(): string {
  loadRootEnv();
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'MIGRATE_DATABASE_URL (or DATABASE_URL) must be set — see .env.example (SRS §9.4)',
    );
  }
  return url;
}
