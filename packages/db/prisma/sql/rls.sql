-- ---------------------------------------------------------------------------
-- VOID·SPACE — Row-Level Security policies and runtime grants
-- (SRS §3.5 "Multi-Tenancy Strategy", §5.3 "Row-Level Security Summary",
--  FR-1.6, FR-13.3, NFR-SEC.5)
--
-- Applied by `pnpm db:rls` AFTER every migration, and safe to run repeatedly.
--
-- Statement separator: a line that contains only the "@statement" marker
-- (two dashes, a space, then the word). scripts/apply-rls.mjs uses it to execute
-- each chunk separately; the whole file is also valid `psql -f` input.
--
-- Security model
-- --------------
--   void_app        runtime role for api + worker. Every tenant-scoped table is
--                   protected by a policy comparing `tenant_id` to the session
--                   variable `app.current_tenant_id`, which the application sets
--                   inside a transaction (`withTenant()` in src/tenant.ts).
--                   The setting is read *without* the missing_ok flag, so a query
--                   that forgets to establish tenant context fails loudly instead
--                   of silently returning rows.
--   void_platform   SuperAdmin/administrative role (BYPASSRLS). It holds
--                   privileges ONLY on tenants, roles, users, user_roles and
--                   wallets — never on Asset, AssetVersion, AISuggestion,
--                   ReviewDecision, ReviewComment, License, ApiKey, Notification,
--                   Job or AuditLog (§5.3). Its use is narrow and audited:
--                   identity resolution at login, workspace listing, SuperAdmin
--                   tenant administration.
--   <owner>         schema owner used only for DDL (migrations, RLS apply).
-- ---------------------------------------------------------------------------

-- @statement
GRANT USAGE ON SCHEMA public TO void_app, void_platform;

-- @statement
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO void_app;

-- @statement
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO void_app;

-- @statement
-- The platform role starts from a clean slate every run, then gets its narrow set.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM void_platform;

-- @statement
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tenants TO void_platform;

-- @statement
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE roles TO void_platform;

-- @statement
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE users TO void_platform;

-- @statement
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_roles TO void_platform;

-- @statement
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE wallets TO void_platform;

-- @statement
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE invites TO void_platform;

-- @statement
-- FR-13.3 — the audit log is append-only for the runtime role: UPDATE and DELETE
-- are revoked at the database-permission level, not merely avoided in code.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM void_app;

-- @statement
GRANT SELECT, INSERT ON TABLE audit_logs TO void_app;

-- @statement
-- Tenant isolation on every tenant-scoped table (§5.3). FORCE makes the owner
-- subject to the policy too, so accidental owner-context reads cannot leak.
DO $$
DECLARE
  target_table text;
  tenant_tables text[] := ARRAY[
    'users',
    'user_roles',
    'wallets',
    'invites',
    'tenant_settings',
    'webhooks',
    'assets',
    'asset_versions',
    'ai_suggestions',
    'review_decisions',
    'review_comments',
    'licenses',
    'api_keys',
    'notifications',
    'audit_logs',
    'jobs',
    'sessions'
  ];
BEGIN
  FOREACH target_table IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', target_table || '_tenant_isolation', target_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I '
      'USING (tenant_id = current_setting(''app.current_tenant_id'')::uuid) '
      'WITH CHECK (tenant_id = current_setting(''app.current_tenant_id'')::uuid)',
      target_table || '_tenant_isolation',
      target_table
    );
  END LOOP;
END
$$;

-- @statement
-- `tenants` itself carries no tenant_id (§5.3), but the runtime role may only
-- ever see the tenant it is currently acting as. Cross-tenant administration
-- (workspace switcher, SuperAdmin console) goes through void_platform.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

-- @statement
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

-- @statement
DROP POLICY IF EXISTS tenants_active_only ON tenants;

-- @statement
CREATE POLICY tenants_active_only ON tenants
  USING (id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (id = current_setting('app.current_tenant_id')::uuid);

-- @statement
-- `roles` is a fixed platform-defined lookup table with no tenant data (§5.3),
-- so it is intentionally left without a policy; void_app only ever reads it.
GRANT SELECT ON TABLE roles TO void_app;

-- @statement
-- Helpful diagnostics: how many policies protect each table after this run.
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced,
  count(p.polname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
ORDER BY c.relname;
