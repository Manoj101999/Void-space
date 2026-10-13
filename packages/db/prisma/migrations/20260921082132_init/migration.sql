-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "RoleName" AS ENUM ('SuperAdmin', 'TenantAdmin', 'Creator', 'Assessor', 'Developer', 'Viewer');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('invited', 'active', 'suspended');

-- CreateEnum
CREATE TYPE "WalletType" AS ENUM ('managed', 'linked');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('draft', 'pending', 'needs_manual_review', 'approved', 'rejected', 'revision', 'published');

-- CreateEnum
CREATE TYPE "PinStatus" AS ENUM ('pending', 'pinning', 'pinned', 'failed');

-- CreateEnum
CREATE TYPE "ReviewDecisionKind" AS ENUM ('approved', 'rejected', 'revision');

-- CreateEnum
CREATE TYPE "LicenseStatus" AS ENUM ('active', 'revoked');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'active', 'completed', 'failed', 'delayed');

-- CreateEnum
CREATE TYPE "JobQueue" AS ENUM ('ai_enrichment', 'ipfs_pin', 'blender_optimize', 'chain_license', 'xr_publish', 'notify');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(60) NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'active',
    "suspended_at" TIMESTAMP(3),
    "suspended_reason" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "name" "RoleName" NOT NULL,
    "description" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "full_name" VARCHAR(120) NOT NULL,
    "password_hash" TEXT,
    "google_id" VARCHAR(120),
    "wallet_address" VARCHAR(42),
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by_id" UUID,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "address" VARCHAR(42) NOT NULL,
    "type" "WalletType" NOT NULL,
    "derivation_index" INTEGER,
    "label" VARCHAR(120),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "role" "RoleName" NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "invited_by_id" UUID,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "default_polycount_budget" INTEGER,
    "required_metadata_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "secret" VARCHAR(255) NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "creator_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "category" VARCHAR(60) NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "AssetStatus" NOT NULL DEFAULT 'draft',
    "current_version_id" UUID,
    "manifest_url" VARCHAR(1000),
    "xr_manifest_ref" VARCHAR(255),
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "format" VARCHAR(10) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "polycount" INTEGER,
    "vertices" INTEGER,
    "materials" INTEGER,
    "animations" INTEGER,
    "textures" INTEGER,
    "ipfs_cid" VARCHAR(120),
    "pin_status" "PinStatus" NOT NULL DEFAULT 'pending',
    "source_tool" VARCHAR(60),
    "source_license" VARCHAR(120),
    "source_attribution" VARCHAR(500),
    "source_url" VARCHAR(1000),
    "mesh_metadata" JSONB,
    "is_derivative" BOOLEAN NOT NULL DEFAULT false,
    "derivative_of_version_id" UUID,
    "staging_path" VARCHAR(500),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_suggestions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "asset_version_id" UUID NOT NULL,
    "suggested_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "suggested_description" TEXT NOT NULL,
    "quality_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "model_version" VARCHAR(80) NOT NULL,
    "prompt_version" VARCHAR(40) NOT NULL,
    "latency_ms" INTEGER,
    "needs_manual_review" BOOLEAN NOT NULL DEFAULT false,
    "raw_response" JSONB,
    "accepted_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accepted_description" TEXT,
    "accepted_at" TIMESTAMP(3),
    "accepted_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_decisions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "asset_version_id" UUID NOT NULL,
    "assessor_id" UUID NOT NULL,
    "decision" "ReviewDecisionKind" NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_comments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "author_id" UUID,
    "parent_id" UUID,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "licenses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "asset_version_id" UUID NOT NULL,
    "approver_id" UUID,
    "token_id" BIGINT NOT NULL,
    "contract_address" VARCHAR(42) NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "block_number" BIGINT,
    "gas_used" BIGINT,
    "ipfs_metadata_cid" VARCHAR(120),
    "license_terms_hash" VARCHAR(66) NOT NULL,
    "license_type" VARCHAR(40) NOT NULL,
    "license_terms" TEXT,
    "recipient_address" VARCHAR(42),
    "status" "LicenseStatus" NOT NULL DEFAULT 'active',
    "revoked_reason" VARCHAR(500),
    "revoked_at" TIMESTAMP(3),
    "revoked_tx_hash" VARCHAR(66),
    "minted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "prefix" VARCHAR(16) NOT NULL,
    "hashed_key" VARCHAR(255) NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" VARCHAR(60) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "actor_id" UUID,
    "actor_label" VARCHAR(200),
    "action" VARCHAR(60) NOT NULL,
    "entity_type" VARCHAR(60) NOT NULL,
    "entity_id" VARCHAR(60),
    "before_state" JSONB,
    "after_state" JSONB,
    "tx_hash" VARCHAR(66),
    "block_number" BIGINT,
    "gas_used" BIGINT,
    "ipfs_cid" VARCHAR(120),
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "queue" "JobQueue" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "entity_type" VARCHAR(60),
    "entity_id" VARCHAR(60),
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 1,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_google_id_idx" ON "users"("google_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "user_roles_tenant_id_role_id_idx" ON "user_roles"("tenant_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_user_id_tenant_id_key" ON "user_roles"("user_id", "tenant_id");

-- CreateIndex
CREATE INDEX "wallets_user_id_idx" ON "wallets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_tenant_id_address_key" ON "wallets"("tenant_id", "address");

-- CreateIndex
CREATE UNIQUE INDEX "invites_token_hash_key" ON "invites"("token_hash");

-- CreateIndex
CREATE INDEX "invites_tenant_id_email_idx" ON "invites"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_settings_tenant_id_key" ON "tenant_settings"("tenant_id");

-- CreateIndex
CREATE INDEX "webhooks_tenant_id_is_active_idx" ON "webhooks"("tenant_id", "is_active");

-- CreateIndex
CREATE INDEX "assets_tenant_id_status_created_at_idx" ON "assets"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "assets_tenant_id_creator_id_idx" ON "assets"("tenant_id", "creator_id");

-- CreateIndex
CREATE INDEX "assets_tenant_id_name_idx" ON "assets"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "asset_versions_tenant_id_pin_status_idx" ON "asset_versions"("tenant_id", "pin_status");

-- CreateIndex
CREATE UNIQUE INDEX "asset_versions_asset_id_version_number_key" ON "asset_versions"("asset_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "ai_suggestions_asset_version_id_key" ON "ai_suggestions"("asset_version_id");

-- CreateIndex
CREATE INDEX "ai_suggestions_tenant_id_needs_manual_review_idx" ON "ai_suggestions"("tenant_id", "needs_manual_review");

-- CreateIndex
CREATE INDEX "review_decisions_tenant_id_asset_id_created_at_idx" ON "review_decisions"("tenant_id", "asset_id", "created_at");

-- CreateIndex
CREATE INDEX "review_decisions_tenant_id_created_at_idx" ON "review_decisions"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "review_comments_tenant_id_asset_id_created_at_idx" ON "review_comments"("tenant_id", "asset_id", "created_at");

-- CreateIndex
CREATE INDEX "licenses_tenant_id_status_idx" ON "licenses"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "licenses_tenant_id_asset_id_idx" ON "licenses"("tenant_id", "asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "licenses_tenant_id_token_id_key" ON "licenses"("tenant_id", "token_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_hashed_key_key" ON "api_keys"("hashed_key");

-- CreateIndex
CREATE INDEX "api_keys_tenant_id_revoked_at_idx" ON "api_keys"("tenant_id", "revoked_at");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_user_id_read_at_idx" ON "notifications"("tenant_id", "user_id", "read_at");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_created_at_idx" ON "notifications"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_action_created_at_idx" ON "audit_logs"("tenant_id", "action", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_entity_type_entity_id_idx" ON "audit_logs"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "jobs_tenant_id_created_at_idx" ON "jobs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "jobs_tenant_id_entity_type_entity_id_idx" ON "jobs"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "jobs_tenant_id_status_idx" ON "jobs"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "asset_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_derivative_of_version_id_fkey" FOREIGN KEY ("derivative_of_version_id") REFERENCES "asset_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_asset_version_id_fkey" FOREIGN KEY ("asset_version_id") REFERENCES "asset_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_asset_version_id_fkey" FOREIGN KEY ("asset_version_id") REFERENCES "asset_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_assessor_id_fkey" FOREIGN KEY ("assessor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "review_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_asset_version_id_fkey" FOREIGN KEY ("asset_version_id") REFERENCES "asset_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
