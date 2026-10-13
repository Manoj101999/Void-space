-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "description" VARCHAR(4000),
ADD COLUMN     "metadata" JSONB;

-- CreateTable
CREATE TABLE "public_catalog_entries" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "tenant_name" VARCHAR(120) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(4000),
    "category" VARCHAR(60) NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "format" VARCHAR(10) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "polycount" INTEGER,
    "vertices" INTEGER,
    "materials" INTEGER,
    "textures" INTEGER,
    "animations" INTEGER,
    "ipfs_cid" VARCHAR(120) NOT NULL,
    "license_type" VARCHAR(40) NOT NULL,
    "license_terms" TEXT,
    "token_id" BIGINT,
    "contract_address" VARCHAR(42),
    "tx_hash" VARCHAR(66),
    "license_metadata_cid" VARCHAR(120),
    "xr_manifest_ref" VARCHAR(255),
    "source_license" VARCHAR(120),
    "source_attribution" VARCHAR(500),
    "source_url" VARCHAR(1000),
    "published_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "public_catalog_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "public_catalog_entries_asset_id_key" ON "public_catalog_entries"("asset_id");

-- CreateIndex
CREATE INDEX "public_catalog_entries_published_at_idx" ON "public_catalog_entries"("published_at");

-- CreateIndex
CREATE INDEX "public_catalog_entries_category_published_at_idx" ON "public_catalog_entries"("category", "published_at");

-- CreateIndex
CREATE INDEX "public_catalog_entries_tenant_id_idx" ON "public_catalog_entries"("tenant_id");
