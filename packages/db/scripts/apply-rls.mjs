#!/usr/bin/env node
/**
 * Applies the Row-Level Security policies, runtime grants and audit-log
 * append-only rule (SRS §3.5, §5.3, FR-13.3, NFR-SEC.5).
 *
 * Run with:  pnpm db:rls
 *
 * Steps:
 *   1. create the runtime roles (void_app, void_platform) if they are missing,
 *      using the passwords from APP_DB_PASSWORD / PLATFORM_DB_PASSWORD
 *   2. execute every statement in prisma/sql/rls.sql as the schema owner
 *   3. print a per-table summary of RLS enablement so drift is visible
 *
 * Idempotent: safe to run after each migration.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, '..');
const repoRoot = resolve(packageDir, '../..');
const rlsPath = resolve(packageDir, 'prisma/sql/rls.sql');
const STATEMENT_SEPARATOR = '-- @statement';

function loadRootEnv() {
  const envPath = resolve(repoRoot, '.env');
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
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

function splitStatements(sql) {
  // Only a line that is *exactly* the marker separates statements, so the
  // marker can be discussed in comments without breaking the split.
  const chunks = [];
  let current = [];

  for (const line of sql.split('\n')) {
    if (line.trim() === STATEMENT_SEPARATOR) {
      chunks.push(current.join('\n'));
      current = [];
      continue;
    }
    current.push(line);
  }
  chunks.push(current.join('\n'));

  return chunks
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((chunk) => chunk.length > 0);
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

loadRootEnv();

const migrateUrl = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!migrateUrl) {
  console.error('[rls] MIGRATE_DATABASE_URL (or DATABASE_URL) must be set — see .env.example');
  process.exit(2);
}

const appPassword = process.env.APP_DB_PASSWORD ?? 'void_app_pw';
const platformPassword = process.env.PLATFORM_DB_PASSWORD ?? 'void_platform_pw';

const require = createRequire(import.meta.url);
const { PrismaClient } = require(resolve(packageDir, 'generated/client/index.js'));

const prisma = new PrismaClient({ datasources: { db: { url: migrateUrl } } });

async function ensureRole(name, password, { bypassRls }) {
  const [{ exists }] = await prisma.$queryRawUnsafe(
    'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
    name,
  );
  if (exists) {
    // Keep the password in sync with the environment so DATABASE_URL always works.
    await prisma.$executeRawUnsafe(
      `ALTER ROLE ${name} WITH LOGIN PASSWORD ${quoteLiteral(password)} NOSUPERUSER ${
        bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS'
      }`,
    );
    console.log(`[rls] role ${name} already exists (password re-synced)`);
    return;
  }
  await prisma.$executeRawUnsafe(
    `CREATE ROLE ${name} LOGIN PASSWORD ${quoteLiteral(password)} NOSUPERUSER ${
      bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS'
    }`,
  );
  console.log(`[rls] created role ${name}`);
}

async function main() {
  await ensureRole('void_app', appPassword, { bypassRls: false });
  await ensureRole('void_platform', platformPassword, { bypassRls: true });

  const statements = splitStatements(readFileSync(rlsPath, 'utf8'));
  console.log(`[rls] applying ${statements.length} statements from prisma/sql/rls.sql`);

  let summary = [];
  for (const [index, statement] of statements.entries()) {
    const head = statement.split('\n')[0].slice(0, 72).replace(/\s+/g, ' ');
    if (/^select/i.test(statement)) {
      summary = await prisma.$queryRawUnsafe(statement);
      console.log(`[rls] ${index + 1}/${statements.length} ${head} … (${summary.length} rows)`);
    } else {
      await prisma.$executeRawUnsafe(statement);
      console.log(`[rls] ${index + 1}/${statements.length} ${head} …`);
    }
  }

  const tenantScoped = summary.filter((row) => row.rls_enabled);
  const unprotected = summary.filter(
    (row) => row.rls_enabled && Number(row.policy_count) === 0,
  );
  console.log(
    `[rls] ${tenantScoped.length} tables have RLS enabled; ${summary.length} tables inspected`,
  );
  if (unprotected.length > 0) {
    console.error(
      `[rls] ERROR: RLS enabled but no policy on: ${unprotected.map((r) => r.table_name).join(', ')}`,
    );
    process.exitCode = 1;
  }
  console.log('[rls] done');
}

main()
  .catch((error) => {
    console.error('[rls] failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
