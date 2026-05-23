/*
  Warnings:

  - You are about to drop the `health_checks` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "AssetClass" AS ENUM ('index', 'forex_pair', 'commodity', 'equity');

-- CreateEnum
CREATE TYPE "IndicatorCategory" AS ENUM ('domestic', 'flow', 'sentiment', 'global', 'india_specific');

-- CreateEnum
CREATE TYPE "IndicatorTool" AS ENUM ('nifty', 'edgefinder', 'shared');

-- CreateEnum
CREATE TYPE "IndicatorFrequency" AS ENUM ('daily', 'weekly', 'monthly', 'quarterly', 'event_driven');

-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('fred', 'nse_scrape', 'cftc', 'manual', 'derived');

-- CreateEnum
CREATE TYPE "ScoringRuleType" AS ENUM ('threshold', 'direction', 'band', 'custom');

-- CreateEnum
CREATE TYPE "DataQualityFlag" AS ENUM ('estimated', 'revised', 'carry_forward', 'suspect');

-- CreateEnum
CREATE TYPE "FetchTriggerType" AS ENUM ('cron', 'manual', 'backfill');

-- CreateEnum
CREATE TYPE "FetchStatus" AS ENUM ('running', 'success', 'partial', 'failed');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('user', 'admin');

-- CreateEnum
CREATE TYPE "CompositeGroup" AS ENUM ('domestic', 'external');

-- CreateEnum
CREATE TYPE "ToolName" AS ENUM ('nifty', 'edgefinder');

-- DropTable
DROP TABLE "health_checks";

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "asset_class" "AssetClass" NOT NULL,
    "tool_scope" TEXT[],
    "metadata" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indicators" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "category" "IndicatorCategory" NOT NULL,
    "tool" "IndicatorTool" NOT NULL,
    "frequency" "IndicatorFrequency" NOT NULL,
    "unit" VARCHAR(20),
    "data_source" "DataSource" NOT NULL,
    "source_series_id" VARCHAR(50),
    "description" TEXT,
    "display_order" INTEGER,
    "composite_group" "CompositeGroup",
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indicators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scoring_rules" (
    "id" TEXT NOT NULL,
    "indicator_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "rule_type" "ScoringRuleType" NOT NULL,
    "rule_definition" JSONB NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "scoring_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scorecard_rating_rules" (
    "id" TEXT NOT NULL,
    "tool" "ToolName" NOT NULL,
    "version" INTEGER NOT NULL,
    "rules" JSONB NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scorecard_rating_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_points" (
    "id" TEXT NOT NULL,
    "indicator_id" TEXT NOT NULL,
    "observation_date" DATE NOT NULL,
    "value" DECIMAL(20,6) NOT NULL,
    "vintage_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "data_quality_flag" "DataQualityFlag",
    "source" "DataSource" NOT NULL,
    "source_metadata" JSONB,
    "notes" TEXT,
    "fetched_via" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "data_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_fetch_log" (
    "id" TEXT NOT NULL,
    "job_name" VARCHAR(100) NOT NULL,
    "trigger_type" "FetchTriggerType" NOT NULL,
    "triggered_by" TEXT,
    "target_date_from" DATE,
    "target_date_to" DATE,
    "status" "FetchStatus" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "rows_inserted" INTEGER NOT NULL DEFAULT 0,
    "rows_updated" INTEGER NOT NULL DEFAULT 0,
    "rows_skipped" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "metadata" JSONB,

    CONSTRAINT "data_fetch_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scores" (
    "id" TEXT NOT NULL,
    "indicator_id" TEXT NOT NULL,
    "observation_date" DATE NOT NULL,
    "score" SMALLINT NOT NULL,
    "flag" VARCHAR(50),
    "rule_version_id" TEXT NOT NULL,
    "data_point_id" TEXT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "computation_metadata" JSONB,

    CONSTRAINT "scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nifty_scorecards" (
    "id" TEXT NOT NULL,
    "observation_date" DATE NOT NULL,
    "net_score" SMALLINT NOT NULL,
    "domestic_score" SMALLINT NOT NULL,
    "external_score" SMALLINT NOT NULL,
    "positive_count" SMALLINT NOT NULL,
    "negative_count" SMALLINT NOT NULL,
    "neutral_count" SMALLINT NOT NULL,
    "rating_label" VARCHAR(30) NOT NULL,
    "special_flags" TEXT[],
    "nifty_close" DECIMAL(10,2),
    "score_velocity_1d" DECIMAL(6,2),
    "score_velocity_5d" DECIMAL(6,2),
    "indicator_breakdown" JSONB NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_stale" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "nifty_scorecards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edgefinder_scorecards" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "observation_date" DATE NOT NULL,
    "fundamentals_score" SMALLINT NOT NULL,
    "cot_score" SMALLINT NOT NULL,
    "total_score" SMALLINT NOT NULL,
    "rating_label" VARCHAR(30) NOT NULL,
    "indicator_breakdown" JSONB NOT NULL,
    "cot_breakdown" JSONB,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_stale" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "edgefinder_scorecards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "display_name" VARCHAR(100),
    "role" "UserRole" NOT NULL DEFAULT 'user',
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cot_data" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "report_date" DATE NOT NULL,
    "release_date" DATE NOT NULL,
    "long_contracts" INTEGER,
    "short_contracts" INTEGER,
    "net_position" INTEGER,
    "long_pct_change" DECIMAL(8,4),
    "short_pct_change" DECIMAL(8,4),
    "raw_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cot_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "economic_releases" (
    "id" TEXT NOT NULL,
    "indicator_id" TEXT NOT NULL,
    "release_date" DATE NOT NULL,
    "actual_value" DECIMAL(20,6),
    "forecast_value" DECIMAL(20,6),
    "previous_value" DECIMAL(20,6),
    "surprise_value" DECIMAL(20,6),
    "raw_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "economic_releases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assets_code_key" ON "assets"("code");

-- CreateIndex
CREATE INDEX "assets_asset_class_idx" ON "assets"("asset_class");

-- CreateIndex
CREATE UNIQUE INDEX "indicators_code_key" ON "indicators"("code");

-- CreateIndex
CREATE INDEX "indicators_tool_is_active_idx" ON "indicators"("tool", "is_active");

-- CreateIndex
CREATE INDEX "indicators_data_source_frequency_idx" ON "indicators"("data_source", "frequency");

-- CreateIndex
CREATE INDEX "scoring_rules_indicator_id_effective_from_idx" ON "scoring_rules"("indicator_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "scoring_rules_indicator_id_version_key" ON "scoring_rules"("indicator_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "scorecard_rating_rules_tool_version_key" ON "scorecard_rating_rules"("tool", "version");

-- CreateIndex
CREATE INDEX "data_points_indicator_id_observation_date_idx" ON "data_points"("indicator_id", "observation_date" DESC);

-- CreateIndex
CREATE INDEX "data_points_vintage_date_idx" ON "data_points"("vintage_date" DESC);

-- CreateIndex
CREATE INDEX "data_points_source_created_at_idx" ON "data_points"("source", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "data_points_indicator_id_observation_date_vintage_date_key" ON "data_points"("indicator_id", "observation_date", "vintage_date");

-- CreateIndex
CREATE INDEX "data_fetch_log_job_name_started_at_idx" ON "data_fetch_log"("job_name", "started_at" DESC);

-- CreateIndex
CREATE INDEX "data_fetch_log_status_started_at_idx" ON "data_fetch_log"("status", "started_at" DESC);

-- CreateIndex
CREATE INDEX "data_fetch_log_triggered_by_idx" ON "data_fetch_log"("triggered_by");

-- CreateIndex
CREATE INDEX "scores_indicator_id_observation_date_idx" ON "scores"("indicator_id", "observation_date" DESC);

-- CreateIndex
CREATE INDEX "scores_observation_date_indicator_id_idx" ON "scores"("observation_date", "indicator_id");

-- CreateIndex
CREATE INDEX "scores_rule_version_id_idx" ON "scores"("rule_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "scores_indicator_id_observation_date_rule_version_id_key" ON "scores"("indicator_id", "observation_date", "rule_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "nifty_scorecards_observation_date_key" ON "nifty_scorecards"("observation_date");

-- CreateIndex
CREATE INDEX "nifty_scorecards_rating_label_observation_date_idx" ON "nifty_scorecards"("rating_label", "observation_date" DESC);

-- CreateIndex
CREATE INDEX "edgefinder_scorecards_asset_id_observation_date_idx" ON "edgefinder_scorecards"("asset_id", "observation_date" DESC);

-- CreateIndex
CREATE INDEX "edgefinder_scorecards_observation_date_total_score_idx" ON "edgefinder_scorecards"("observation_date", "total_score" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "edgefinder_scorecards_asset_id_observation_date_key" ON "edgefinder_scorecards"("asset_id", "observation_date");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "cot_data_asset_id_report_date_idx" ON "cot_data"("asset_id", "report_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "cot_data_asset_id_report_date_key" ON "cot_data"("asset_id", "report_date");

-- CreateIndex
CREATE INDEX "economic_releases_indicator_id_release_date_idx" ON "economic_releases"("indicator_id", "release_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "economic_releases_indicator_id_release_date_key" ON "economic_releases"("indicator_id", "release_date");

-- AddForeignKey
ALTER TABLE "scoring_rules" ADD CONSTRAINT "scoring_rules_indicator_id_fkey" FOREIGN KEY ("indicator_id") REFERENCES "indicators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_points" ADD CONSTRAINT "data_points_indicator_id_fkey" FOREIGN KEY ("indicator_id") REFERENCES "indicators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_points" ADD CONSTRAINT "data_points_fetched_via_fkey" FOREIGN KEY ("fetched_via") REFERENCES "data_fetch_log"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scores" ADD CONSTRAINT "scores_indicator_id_fkey" FOREIGN KEY ("indicator_id") REFERENCES "indicators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scores" ADD CONSTRAINT "scores_rule_version_id_fkey" FOREIGN KEY ("rule_version_id") REFERENCES "scoring_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scores" ADD CONSTRAINT "scores_data_point_id_fkey" FOREIGN KEY ("data_point_id") REFERENCES "data_points"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edgefinder_scorecards" ADD CONSTRAINT "edgefinder_scorecards_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
