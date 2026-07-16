-- Compass v2 Phase 1: introduce a versioned, effective-dated config table for
-- Compass thresholds, mirroring the existing "scoring_rules" (ScoringRule)
-- pattern used by NIFTY: a Json blob (config_definition) instead of typed
-- columns, resolved by effective_from/effective_to date range.
--
-- This migration ONLY creates the table. No data is seeded here — seeding is
-- done via a TS script (prisma/seed-compass-config.ts), matching how NIFTY
-- ScoringRule rows are seeded via prisma/seed.ts rather than raw SQL inserts.
--
-- versionLabel (not an int "version" like ScoringRule) since Compass config
-- generations are named ("v1", "v2") rather than incremented per-indicator.
CREATE TABLE "compass_config" (
    "id" TEXT NOT NULL,
    "version_label" VARCHAR(20) NOT NULL,
    "config_definition" JSONB NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "compass_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "compass_config_version_label_key" ON "compass_config"("version_label");

-- CreateIndex
CREATE INDEX "compass_config_effective_from_idx" ON "compass_config"("effective_from");
