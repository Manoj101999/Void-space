#!/usr/bin/env bash
#
# Bootstrap PostgreSQL roles, executed once by the postgres image's initdb on the
# very first volume initialisation (SRS §3.5, §5.3).
#
# Three roles exist, each with a distinct privilege envelope:
#   $POSTGRES_USER   (default voidspace) — schema owner: migrations + RLS DDL only
#   void_app                             — runtime role for api + worker, fully
#                                          subject to Row-Level Security
#   void_platform                        — SuperAdmin role; BYPASSRLS so it can
#                                          administer Tenant/Role rows. The RLS
#                                          script revokes its access to every
#                                          tenant-scoped table (§3.5).
#
# Idempotent: safe to re-run. packages/db/prisma/sql/rls.sql applies the same
# grants after every migration, so this file only has to create the roles.
set -euo pipefail

APP_PASSWORD="${APP_DB_PASSWORD:-void_app_pw}"
PLATFORM_PASSWORD="${PLATFORM_DB_PASSWORD:-void_platform_pw}"

psql -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  -v app_password="${APP_PASSWORD}" \
  -v platform_password="${PLATFORM_PASSWORD}" <<EOSQL
-- \gexec executes the generated statement only when the role is missing.
SELECT 'CREATE ROLE void_app LOGIN PASSWORD ' || quote_literal(:'app_password') || ' NOSUPERUSER NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'void_app')
\gexec

SELECT 'CREATE ROLE void_platform LOGIN PASSWORD ' || quote_literal(:'platform_password') || ' NOSUPERUSER BYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'void_platform')
\gexec

GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO void_app, void_platform;
GRANT USAGE ON SCHEMA public TO void_app, void_platform;

-- Applies to tables/sequences created later by this role (i.e. by Prisma
-- migrations), so new models are reachable by the runtime without extra grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO void_app, void_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO void_app, void_platform;
EOSQL

echo "[postgres-init] roles void_app and void_platform ready"
