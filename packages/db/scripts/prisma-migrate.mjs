#!/usr/bin/env node
/**
 * Runs a Prisma CLI command against the *migration* role (schema owner).
 *
 * The runtime roles (void_app / void_platform) deliberately cannot run DDL, so
 * migrations, resets and `prisma studio` all go through MIGRATE_DATABASE_URL —
 * see .env.example and SRS §3.5 / §5.3.
 *
 * Usage: node scripts/prisma-migrate.mjs migrate deploy
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootEnvPath = resolve(here, '../../../.env');

// Prisma only auto-loads a .env next to the schema; this monorepo keeps a single
// .env at the repository root, so read it here (environment wins over the file).
if (existsSync(rootEnvPath)) {
  for (const rawLine of readFileSync(rootEnvPath, 'utf8').split('\n')) {
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
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('[db] usage: node scripts/prisma-migrate.mjs <prisma args...>');
  process.exit(2);
}

const migrateUrl = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!migrateUrl) {
  console.error('[db] MIGRATE_DATABASE_URL (or DATABASE_URL) must be set — see .env.example');
  process.exit(2);
}

// Resolve the local Prisma CLI directly so this script works whether it is run
// through a pnpm script (node_modules/.bin already on PATH) or via bare `node`.
const localBin = resolve(here, '../node_modules/.bin/prisma');
const windowsLocalBin = `${localBin}.CMD`;
const command = process.platform === 'win32' && existsSync(windowsLocalBin)
  ? windowsLocalBin
  : existsSync(localBin)
    ? localBin
    : 'prisma';

const result = spawnSync(command, args, {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: migrateUrl },
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(`[db] failed to run "${command}":`, result.error.message);
  process.exit(2);
}

process.exit(result.status ?? 1);

