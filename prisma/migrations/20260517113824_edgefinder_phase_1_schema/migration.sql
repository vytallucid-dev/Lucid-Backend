/*
  Warnings:

  - You are about to drop the column `long_pct_change` on the `cot_data` table. All the data in the column will be lost.
  - You are about to drop the column `net_position` on the `cot_data` table. All the data in the column will be lost.
  - You are about to drop the column `short_pct_change` on the `cot_data` table. All the data in the column will be lost.
  - You are about to drop the `economic_releases` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[contract_code,report_date,trader_category,vintage_date]` on the table `cot_data` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[asset_id,observation_date,vintage_date]` on the table `edgefinder_scorecards` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `contract_code` to the `cot_data` table without a default value. This is not possible if the table is not empty.
  - Added the required column `source` to the `cot_data` table without a default value. This is not possible if the table is not empty.
  - Added the required column `trader_category` to the `cot_data` table without a default value. This is not possible if the table is not empty.
  - Added the required column `base_fundamentals_score` to the `edgefinder_scorecards` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
ALTER TYPE "AssetClass" ADD VALUE 'currency';

-- AlterEnum
ALTER TYPE "DataSource" ADD VALUE 'yahoo';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ScoringRuleType" ADD VALUE 'normal';
ALTER TYPE "ScoringRuleType" ADD VALUE 'inverted';
ALTER TYPE "ScoringRuleType" ADD VALUE 'cpi_rate_cycle';
ALTER TYPE "ScoringRuleType" ADD VALUE 'us02y_sma';
ALTER TYPE "ScoringRuleType" ADD VALUE 'rate_decision';
ALTER TYPE "ScoringRuleType" ADD VALUE 'cot_two_component';

-- DropIndex
DROP INDEX "cot_data_asset_id_report_date_key";

-- DropIndex
DROP INDEX "edgefinder_scorecards_asset_id_observation_date_key";

-- AlterTable
ALTER TABLE "cot_data" DROP COLUMN "long_pct_change",
DROP COLUMN "net_position",
DROP COLUMN "short_pct_change",
ADD COLUMN     "change_label" VARCHAR(15),
ADD COLUMN     "contract_code" VARCHAR(30) NOT NULL,
ADD COLUMN     "is_current" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "long_pct" DECIMAL(8,4),
ADD COLUMN     "net_positioning_label" VARCHAR(15),
ADD COLUMN     "short_pct" DECIMAL(8,4),
ADD COLUMN     "source" "DataSource" NOT NULL,
ADD COLUMN     "trader_category" VARCHAR(30) NOT NULL,
ADD COLUMN     "vintage_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "weekly_change_pct" DECIMAL(8,4);

-- AlterTable
ALTER TABLE "data_points" ADD COLUMN     "forecast_value" DECIMAL(20,6),
ADD COLUMN     "previous_value" DECIMAL(20,6);

-- AlterTable
ALTER TABLE "edgefinder_scorecards" ADD COLUMN     "base_fundamentals_score" SMALLINT NOT NULL,
ADD COLUMN     "compass_adjustment" SMALLINT NOT NULL DEFAULT 0,
ADD COLUMN     "compass_overrides_applied" JSONB,
ADD COLUMN     "is_current" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "regime_at_compute" VARCHAR(15),
ADD COLUMN     "vintage_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "indicators" ADD COLUMN     "country" VARCHAR(3),
ADD COLUMN     "ui_group" VARCHAR(20);

-- DropTable
DROP TABLE "economic_releases";

-- CreateTable
CREATE TABLE "currency_cycle_stance" (
    "id" TEXT NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "stance" VARCHAR(10) NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "currency_cycle_stance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pair_template_rows" (
    "id" TEXT NOT NULL,
    "row_code" VARCHAR(30) NOT NULL,
    "display_name" VARCHAR(50) NOT NULL,
    "ui_group" VARCHAR(20) NOT NULL,
    "treatment" VARCHAR(30) NOT NULL,
    "us_indicator_code" VARCHAR(50),
    "eur_indicator_code" VARCHAR(50),
    "gbp_indicator_code" VARCHAR(50),
    "jpy_indicator_code" VARCHAR(50),
    "row_order" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "pair_template_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compass_inputs" (
    "id" TEXT NOT NULL,
    "observation_date" DATE NOT NULL,
    "input_code" VARCHAR(30) NOT NULL,
    "raw_value" DECIMAL(20,6),
    "derived_value" DECIMAL(20,6),
    "color_band" VARCHAR(10) NOT NULL,
    "sub_checks" JSONB,
    "source" "DataSource" NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compass_inputs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compass_classifications" (
    "id" TEXT NOT NULL,
    "classification_date" DATE NOT NULL,
    "vintage_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "candidate_regime" VARCHAR(15) NOT NULL,
    "active_regime" VARCHAR(15) NOT NULL,
    "persistence_days_count" INTEGER NOT NULL DEFAULT 0,
    "crisis_override_fired" BOOLEAN NOT NULL DEFAULT false,
    "total_green_weight" DECIMAL(5,2) NOT NULL,
    "total_yellow_weight" DECIMAL(5,2) NOT NULL,
    "total_red_weight" DECIMAL(5,2) NOT NULL,
    "vote_breakdown" JSONB NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compass_classifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "currency_cycle_stance_currency_code_effective_from_idx" ON "currency_cycle_stance"("currency_code", "effective_from" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "currency_cycle_stance_currency_code_effective_from_key" ON "currency_cycle_stance"("currency_code", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "pair_template_rows_row_code_key" ON "pair_template_rows"("row_code");

-- CreateIndex
CREATE INDEX "pair_template_rows_row_order_idx" ON "pair_template_rows"("row_order");

-- CreateIndex
CREATE INDEX "compass_inputs_observation_date_idx" ON "compass_inputs"("observation_date" DESC);

-- CreateIndex
CREATE INDEX "compass_inputs_input_code_observation_date_idx" ON "compass_inputs"("input_code", "observation_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "compass_inputs_observation_date_input_code_key" ON "compass_inputs"("observation_date", "input_code");

-- CreateIndex
CREATE INDEX "compass_classifications_classification_date_idx" ON "compass_classifications"("classification_date" DESC);

-- CreateIndex
CREATE INDEX "compass_classifications_date_current_idx" ON "compass_classifications"("classification_date", "is_current");

-- CreateIndex
CREATE UNIQUE INDEX "compass_classifications_classification_date_vintage_date_key" ON "compass_classifications"("classification_date", "vintage_date");

-- CreateIndex
CREATE INDEX "cot_data_contract_code_report_date_idx" ON "cot_data"("contract_code", "report_date" DESC);

-- CreateIndex
CREATE INDEX "cot_data_vintage_date_idx" ON "cot_data"("vintage_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "cot_data_contract_code_report_date_trader_category_vintage__key" ON "cot_data"("contract_code", "report_date", "trader_category", "vintage_date");

-- CreateIndex
CREATE INDEX "edgefinder_scorecards_observation_current_idx" ON "edgefinder_scorecards"("observation_date", "is_current");

-- CreateIndex
CREATE UNIQUE INDEX "edgefinder_scorecards_asset_id_observation_date_vintage_dat_key" ON "edgefinder_scorecards"("asset_id", "observation_date", "vintage_date");

-- AddForeignKey
ALTER TABLE "cot_data" ADD CONSTRAINT "cot_data_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
