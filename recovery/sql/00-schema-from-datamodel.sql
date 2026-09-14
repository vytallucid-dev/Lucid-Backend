-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AssetClass" AS ENUM ('index', 'forex_pair', 'commodity', 'equity', 'currency');

-- CreateEnum
CREATE TYPE "IndicatorCategory" AS ENUM ('domestic', 'flow', 'sentiment', 'global', 'india_specific');

-- CreateEnum
CREATE TYPE "IndicatorTool" AS ENUM ('nifty', 'edgefinder', 'shared');

-- CreateEnum
CREATE TYPE "IndicatorFrequency" AS ENUM ('daily', 'weekly', 'monthly', 'quarterly', 'event_driven');

-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('fred', 'nse_scrape', 'cftc', 'manual', 'derived', 'yahoo', 'jblanked', 'forex_factory', 'eodhd', 'crude_price_api');

-- CreateEnum
CREATE TYPE "ScoringRuleType" AS ENUM ('threshold', 'direction', 'band', 'custom', 'normal', 'inverted', 'cpi_rate_cycle', 'us02y_sma', 'rate_decision', 'cot_two_component');

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
    "country" VARCHAR(3),
    "ui_group" VARCHAR(20),
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
    "variant" VARCHAR(20),
    "is_legacy_variant" BOOLEAN NOT NULL DEFAULT false,
    "value" DECIMAL(20,6) NOT NULL,
    "forecast_value" DECIMAL(20,6),
    "previous_value" DECIMAL(20,6),
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
CREATE TABLE "indicator_variants" (
    "id" TEXT NOT NULL,
    "indicator_id" TEXT NOT NULL,
    "variant" VARCHAR(20) NOT NULL,
    "ordinal" SMALLINT NOT NULL,
    "is_final" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "indicator_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_events" (
    "id" TEXT NOT NULL,
    "source" VARCHAR(30) NOT NULL DEFAULT 'forex_factory',
    "country" VARCHAR(8) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "impact" VARCHAR(16) NOT NULL,
    "forecast_raw" VARCHAR(40),
    "previous_raw" VARCHAR(40),
    "actual_raw" VARCHAR(40),
    "indicator_id" TEXT,
    "indicator_code" VARCHAR(50),
    "variant" VARCHAR(20),
    "is_primary" BOOLEAN NOT NULL DEFAULT true,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "fetched_via" TEXT,

    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_event_deferrals" (
    "id" TEXT NOT NULL,
    "calendar_event_id" TEXT,
    "indicator_id" TEXT NOT NULL,
    "indicator_code" VARCHAR(50) NOT NULL,
    "variant" VARCHAR(20),
    "defer_until" DATE,
    "reason" VARCHAR(280),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "calendar_event_deferrals_pkey" PRIMARY KEY ("id")
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
    "vintage_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "tool_version" INTEGER NOT NULL DEFAULT 2,
    "rating_rule_id" TEXT NOT NULL,
    "net_score" SMALLINT NOT NULL,
    "domestic_score" SMALLINT NOT NULL,
    "external_score" SMALLINT NOT NULL,
    "positive_count" SMALLINT NOT NULL,
    "negative_count" SMALLINT NOT NULL,
    "neutral_count" SMALLINT NOT NULL,
    "rating_label" VARCHAR(30) NOT NULL,
    "special_flags" JSONB,
    "ind_9_raw_composite" SMALLINT,
    "ind_13_score" SMALLINT,
    "composition_flag" VARCHAR(40),
    "conflict_flag" BOOLEAN NOT NULL DEFAULT false,
    "peak_score_ceiling_state" JSONB,
    "band" VARCHAR(20),
    "nifty_close" DECIMAL(10,2),
    "score_velocity_1d" DECIMAL(6,2),
    "score_velocity_5d" DECIMAL(6,2),
    "indicator_breakdown" JSONB NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_stale" BOOLEAN NOT NULL DEFAULT false,
    "is_non_trading_day" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "nifty_scorecards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nse_holidays" (
    "date" DATE NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nse_holidays_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "edgefinder_scorecards" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "observation_date" DATE NOT NULL,
    "vintage_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "base_fundamentals_score" SMALLINT NOT NULL,
    "fundamentals_score" SMALLINT NOT NULL,
    "cot_score" SMALLINT NOT NULL,
    "total_score" SMALLINT NOT NULL,
    "rating_label" VARCHAR(30) NOT NULL,
    "compass_adjustment" SMALLINT NOT NULL DEFAULT 0,
    "compass_overrides_applied" JSONB,
    "regime_at_compute" VARCHAR(15),
    "indicator_breakdown" JSONB NOT NULL,
    "cot_breakdown" JSONB,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_stale" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "edgefinder_scorecards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edgefinder_pair_scores" (
    "id" TEXT NOT NULL,
    "pair_id" TEXT NOT NULL,
    "score_date" DATE NOT NULL,
    "vintage_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "base_pair_score" SMALLINT NOT NULL,
    "pair_cot_score" SMALLINT NOT NULL,
    "base_total" SMALLINT NOT NULL,
    "compass_adjustment" SMALLINT NOT NULL DEFAULT 0,
    "total_score" SMALLINT NOT NULL,
    "compass_overrides_applied" JSONB,
    "regime_at_compute" VARCHAR(15),
    "rating_label" VARCHAR(30) NOT NULL,
    "row_breakdown" JSONB NOT NULL,
    "cot_breakdown" JSONB,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edgefinder_pair_scores_pkey" PRIMARY KEY ("id")
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
    "contract_code" VARCHAR(30) NOT NULL,
    "report_date" DATE NOT NULL,
    "release_date" DATE NOT NULL,
    "trader_category" VARCHAR(30) NOT NULL,
    "long_contracts" INTEGER,
    "short_contracts" INTEGER,
    "long_pct" DECIMAL(8,4),
    "short_pct" DECIMAL(8,4),
    "change_in_long_contracts" INTEGER,
    "change_in_short_contracts" INTEGER,
    "change_in_long_pct" DECIMAL(8,4),
    "change_in_short_pct" DECIMAL(8,4),
    "weekly_change_pct" DECIMAL(8,4),
    "net_positioning_label" VARCHAR(15),
    "change_label" VARCHAR(15),
    "source" "DataSource" NOT NULL,
    "raw_payload" JSONB,
    "vintage_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cot_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currency_cycle_stance" (
    "id" TEXT NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "stance" VARCHAR(10) NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "fed_constraint" VARCHAR(12),
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
CREATE TABLE "pair_template_row_currencies" (
    "id" TEXT NOT NULL,
    "template_row_id" TEXT NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "indicator_code" VARCHAR(50),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pair_template_row_currencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_indicator_map" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "indicator_id" TEXT NOT NULL,
    "polarity" SMALLINT NOT NULL DEFAULT 1,
    "is_cot" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_indicator_map_pkey" PRIMARY KEY ("id")
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
    "is_validation" BOOLEAN NOT NULL DEFAULT false,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "config_version_label" VARCHAR(20),
    "research_tag" VARCHAR(40),
    "is_trading_day" BOOLEAN NOT NULL DEFAULT true,

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
    "final_regime" VARCHAR(15) NOT NULL DEFAULT '',
    "shock_a_active" BOOLEAN NOT NULL DEFAULT false,
    "shock_b_active" BOOLEAN NOT NULL DEFAULT false,
    "us02y_close" DECIMAL(20,6),
    "us02y_sma21" DECIMAL(20,6),
    "rate_gate_hawkish" BOOLEAN NOT NULL DEFAULT false,
    "override_3_suppressed_by_gate" BOOLEAN NOT NULL DEFAULT false,
    "override_5_suppressed_by_gate" BOOLEAN NOT NULL DEFAULT false,
    "fed_constraint" VARCHAR(12) NOT NULL DEFAULT '',
    "override_2_suppressed_by_constraint" BOOLEAN NOT NULL DEFAULT false,
    "overrides_active" JSONB,
    "total_green_weight" DECIMAL(5,2) NOT NULL,
    "total_yellow_weight" DECIMAL(5,2) NOT NULL,
    "total_red_weight" DECIMAL(5,2) NOT NULL,
    "vote_breakdown" JSONB NOT NULL,
    "is_validation" BOOLEAN NOT NULL DEFAULT false,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "config_version_label" VARCHAR(20),
    "research_tag" VARCHAR(40),
    "is_trading_day" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "compass_classifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compass_module_readings" (
    "id" TEXT NOT NULL,
    "classification_date" DATE NOT NULL,
    "module_code" VARCHAR(30) NOT NULL,
    "reading_code" VARCHAR(40) NOT NULL,
    "color_band" VARCHAR(10),
    "is_voting" BOOLEAN NOT NULL DEFAULT false,
    "weight" DECIMAL(5,2),
    "state_label" VARCHAR(40),
    "value_numeric" DECIMAL(20,6),
    "value_text" VARCHAR(120),
    "unit" VARCHAR(16),
    "source_code" VARCHAR(80) NOT NULL,
    "source_as_of" DATE,
    "staleness_state" VARCHAR(12) NOT NULL,
    "staleness_days" INTEGER,
    "explanation" JSONB,
    "config_version_label" VARCHAR(20),
    "research_tag" VARCHAR(40) NOT NULL DEFAULT '',
    "is_validation" BOOLEAN NOT NULL DEFAULT false,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compass_module_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compass_module_states" (
    "id" TEXT NOT NULL,
    "classification_date" DATE NOT NULL,
    "module_code" VARCHAR(30) NOT NULL,
    "verdict_band" VARCHAR(10),
    "state_label" VARCHAR(40),
    "headline" JSONB NOT NULL,
    "reading_codes" JSONB NOT NULL,
    "config_version_label" VARCHAR(20),
    "research_tag" VARCHAR(40) NOT NULL DEFAULT '',
    "is_validation" BOOLEAN NOT NULL DEFAULT false,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compass_module_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compass_synthesis" (
    "id" TEXT NOT NULL,
    "classification_date" DATE NOT NULL,
    "sentences" JSONB NOT NULL,
    "disagreements" JSONB NOT NULL,
    "config_version_label" VARCHAR(20),
    "research_tag" VARCHAR(40) NOT NULL DEFAULT '',
    "is_validation" BOOLEAN NOT NULL DEFAULT false,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compass_synthesis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compass_classifications_archive" (
    "id" TEXT NOT NULL,
    "classification_date" DATE NOT NULL,
    "vintage_date" TIMESTAMP(3) NOT NULL,
    "is_current" BOOLEAN NOT NULL,
    "candidate_regime" VARCHAR(15) NOT NULL,
    "active_regime" VARCHAR(15) NOT NULL,
    "persistence_days_count" INTEGER NOT NULL,
    "crisis_override_fired" BOOLEAN NOT NULL,
    "final_regime" VARCHAR(15) NOT NULL,
    "shock_a_active" BOOLEAN NOT NULL,
    "shock_b_active" BOOLEAN NOT NULL,
    "us02y_close" DECIMAL(20,6),
    "us02y_sma21" DECIMAL(20,6),
    "rate_gate_hawkish" BOOLEAN NOT NULL,
    "override_3_suppressed_by_gate" BOOLEAN NOT NULL,
    "override_5_suppressed_by_gate" BOOLEAN NOT NULL,
    "fed_constraint" VARCHAR(12) NOT NULL,
    "override_2_suppressed_by_constraint" BOOLEAN NOT NULL,
    "overrides_active" JSONB,
    "total_green_weight" DECIMAL(5,2) NOT NULL,
    "total_yellow_weight" DECIMAL(5,2) NOT NULL,
    "total_red_weight" DECIMAL(5,2) NOT NULL,
    "vote_breakdown" JSONB NOT NULL,
    "is_validation" BOOLEAN NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archive_reason" TEXT NOT NULL,

    CONSTRAINT "compass_classifications_archive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compass_inputs_archive" (
    "id" TEXT NOT NULL,
    "observation_date" DATE NOT NULL,
    "input_code" VARCHAR(30) NOT NULL,
    "raw_value" DECIMAL(20,6),
    "derived_value" DECIMAL(20,6),
    "color_band" VARCHAR(10) NOT NULL,
    "sub_checks" JSONB,
    "source" VARCHAR(30) NOT NULL,
    "is_validation" BOOLEAN NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archive_reason" TEXT NOT NULL,

    CONSTRAINT "compass_inputs_archive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compass_validation_reports" (
    "id" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "overall_passed" BOOLEAN NOT NULL,
    "window_results" JSONB NOT NULL,
    "summary" TEXT NOT NULL,

    CONSTRAINT "compass_validation_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "compass_curve_state" (
    "id" TEXT NOT NULL,
    "is_validation" BOOLEAN NOT NULL DEFAULT false,
    "computed_for_date" DATE NOT NULL,
    "inversion_start" DATE,
    "un_inversion_date" DATE,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "research_tag" VARCHAR(40) NOT NULL DEFAULT '',

    CONSTRAINT "compass_curve_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compass_shock_state" (
    "id" TEXT NOT NULL,
    "is_validation" BOOLEAN NOT NULL DEFAULT false,
    "computed_for_date" DATE NOT NULL,
    "shock_a_active" BOOLEAN NOT NULL DEFAULT false,
    "shock_a_expiry" DATE,
    "shock_b_active" BOOLEAN NOT NULL DEFAULT false,
    "shock_b_expiry" DATE,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "research_tag" VARCHAR(40) NOT NULL DEFAULT '',

    CONSTRAINT "compass_shock_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trading_accounts" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "account_type" VARCHAR(20) NOT NULL,
    "account_name" VARCHAR(120) NOT NULL,
    "account_size" DECIMAL(20,2) NOT NULL,
    "current_balance" DECIMAL(20,2) NOT NULL,
    "currency" VARCHAR(8) NOT NULL DEFAULT 'USD',
    "status" VARCHAR(20) NOT NULL DEFAULT 'Active',
    "starting_date" DATE NOT NULL,
    "broker" VARCHAR(120),
    "profit_goal_pct" DECIMAL(8,2),
    "prop_firm" VARCHAR(120),
    "stage" VARCHAR(20),
    "max_drawdown_pct" DECIMAL(8,2),
    "profit_target_pct" DECIMAL(8,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trading_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "model" VARCHAR(60) NOT NULL,
    "pair" VARCHAR(20) NOT NULL,
    "direction" VARCHAR(8) NOT NULL,
    "planned_entry" DECIMAL(20,6) NOT NULL,
    "planned_sl" DECIMAL(20,6) NOT NULL,
    "planned_first_tp" DECIMAL(20,6),
    "planned_main_tp" DECIMAL(20,6) NOT NULL,
    "conviction" VARCHAR(10) NOT NULL,
    "date_opened" TIMESTAMP(3) NOT NULL,
    "session" VARCHAR(24) NOT NULL,
    "screenshots" TEXT[],
    "psychology" VARCHAR(120),
    "notes" TEXT,
    "oracle_score_at_entry" SMALLINT,
    "oracle_score_entry_date" DATE,
    "oracle_score_entry_captured_at" TIMESTAMP(3),
    "oracle_score_entry_source" VARCHAR(10),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "executions" (
    "id" TEXT NOT NULL,
    "trade_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "risk_pct" DECIMAL(8,2) NOT NULL,
    "lot_size" DECIMAL(12,4) NOT NULL,
    "entry_price" DECIMAL(20,6) NOT NULL,
    "partial_exit_price" DECIMAL(20,6),
    "partial_exit_lot_pct" DECIMAL(8,2),
    "main_exit_price" DECIMAL(20,6),
    "exit_type" VARCHAR(16) NOT NULL DEFAULT 'TP',
    "date_closed" TIMESTAMP(3),
    "total_pips" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "blended_pnl" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "blended_rr" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "oracle_score_at_exit" SMALLINT,
    "oracle_score_exit_date" DATE,
    "oracle_score_exit_captured_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planned_trades" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "pair" VARCHAR(20) NOT NULL,
    "model" VARCHAR(60) NOT NULL,
    "direction" VARCHAR(8) NOT NULL,
    "planned_entry" DECIMAL(20,6) NOT NULL,
    "planned_sl" DECIMAL(20,6) NOT NULL,
    "planned_first_tp" DECIMAL(20,6),
    "planned_main_tp" DECIMAL(20,6) NOT NULL,
    "planned_risk_pct" DECIMAL(8,2) NOT NULL,
    "conviction" VARCHAR(10) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'Watching',
    "date_added" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "screenshots" TEXT[],
    "current_market_price" DECIMAL(20,6) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planned_trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_flows" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" TEXT NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "date" DATE NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trading_models" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "description" VARCHAR(200) NOT NULL DEFAULT '',
    "rules" TEXT NOT NULL DEFAULT '',
    "status" VARCHAR(12) NOT NULL DEFAULT 'Active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trading_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trading_pairs" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "symbol" VARCHAR(20) NOT NULL,
    "display_name" VARCHAR(40) NOT NULL,
    "flag_a" VARCHAR(16) NOT NULL,
    "flag_b" VARCHAR(16) NOT NULL,
    "pip_value" DECIMAL(12,4) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'Active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trading_pairs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assets_code_key" ON "assets"("code");

-- CreateIndex
CREATE INDEX "assets_asset_class_idx" ON "assets"("asset_class");

-- CreateIndex
CREATE INDEX "assets_tool_scope_idx" ON "assets" USING GIN ("tool_scope");

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
CREATE INDEX "data_points_indicator_current_date_idx" ON "data_points"("indicator_id", "is_current", "observation_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "data_points_indicator_id_observation_date_variant_vintage_d_key" ON "data_points"("indicator_id", "observation_date", "variant", "vintage_date");

-- CreateIndex
CREATE INDEX "indicator_variants_indicator_id_idx" ON "indicator_variants"("indicator_id");

-- CreateIndex
CREATE UNIQUE INDEX "indicator_variants_indicator_id_variant_key" ON "indicator_variants"("indicator_id", "variant");

-- CreateIndex
CREATE UNIQUE INDEX "indicator_variants_indicator_id_ordinal_key" ON "indicator_variants"("indicator_id", "ordinal");

-- CreateIndex
CREATE INDEX "calendar_events_scheduled_at_idx" ON "calendar_events"("scheduled_at");

-- CreateIndex
CREATE INDEX "calendar_events_indicator_id_scheduled_at_idx" ON "calendar_events"("indicator_id", "scheduled_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "calendar_events_source_country_title_scheduled_at_key" ON "calendar_events"("source", "country", "title", "scheduled_at");

-- CreateIndex
CREATE INDEX "calendar_event_deferrals_calendar_event_id_idx" ON "calendar_event_deferrals"("calendar_event_id");

-- CreateIndex
CREATE INDEX "calendar_event_deferrals_indicator_id_variant_idx" ON "calendar_event_deferrals"("indicator_id", "variant");

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
CREATE INDEX "nifty_scorecards_rating_label_observation_date_idx" ON "nifty_scorecards"("rating_label", "observation_date" DESC);

-- CreateIndex
CREATE INDEX "nifty_scorecards_observation_current_idx" ON "nifty_scorecards"("observation_date", "is_current");

-- CreateIndex
CREATE INDEX "nifty_scorecards_current_date_idx" ON "nifty_scorecards"("is_current", "observation_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "nifty_scorecards_observation_date_vintage_date_key" ON "nifty_scorecards"("observation_date", "vintage_date");

-- CreateIndex
CREATE INDEX "edgefinder_scorecards_asset_id_observation_date_idx" ON "edgefinder_scorecards"("asset_id", "observation_date" DESC);

-- CreateIndex
CREATE INDEX "edgefinder_scorecards_observation_date_total_score_idx" ON "edgefinder_scorecards"("observation_date", "total_score" DESC);

-- CreateIndex
CREATE INDEX "edgefinder_scorecards_observation_current_idx" ON "edgefinder_scorecards"("observation_date", "is_current");

-- CreateIndex
CREATE INDEX "edgefinder_scorecards_asset_current_date_idx" ON "edgefinder_scorecards"("asset_id", "is_current", "observation_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "edgefinder_scorecards_asset_id_observation_date_vintage_dat_key" ON "edgefinder_scorecards"("asset_id", "observation_date", "vintage_date");

-- CreateIndex
CREATE INDEX "edgefinder_pair_scores_pair_id_score_date_idx" ON "edgefinder_pair_scores"("pair_id", "score_date" DESC);

-- CreateIndex
CREATE INDEX "edgefinder_pair_scores_score_date_current_idx" ON "edgefinder_pair_scores"("score_date", "is_current");

-- CreateIndex
CREATE INDEX "edgefinder_pair_scores_pair_current_date_idx" ON "edgefinder_pair_scores"("pair_id", "is_current", "score_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "edgefinder_pair_scores_pair_id_score_date_vintage_date_key" ON "edgefinder_pair_scores"("pair_id", "score_date", "vintage_date");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "cot_data_contract_code_report_date_idx" ON "cot_data"("contract_code", "report_date" DESC);

-- CreateIndex
CREATE INDEX "cot_data_asset_id_report_date_idx" ON "cot_data"("asset_id", "report_date" DESC);

-- CreateIndex
CREATE INDEX "cot_data_vintage_date_idx" ON "cot_data"("vintage_date" DESC);

-- CreateIndex
CREATE INDEX "cot_data_asset_current_date_idx" ON "cot_data"("asset_id", "is_current", "report_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "cot_data_contract_code_report_date_trader_category_vintage__key" ON "cot_data"("contract_code", "report_date", "trader_category", "vintage_date");

-- CreateIndex
CREATE INDEX "currency_cycle_stance_currency_code_effective_from_idx" ON "currency_cycle_stance"("currency_code", "effective_from" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "currency_cycle_stance_currency_code_effective_from_key" ON "currency_cycle_stance"("currency_code", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "pair_template_rows_row_code_key" ON "pair_template_rows"("row_code");

-- CreateIndex
CREATE INDEX "pair_template_rows_row_order_idx" ON "pair_template_rows"("row_order");

-- CreateIndex
CREATE INDEX "pair_template_row_currencies_currency_code_idx" ON "pair_template_row_currencies"("currency_code");

-- CreateIndex
CREATE INDEX "pair_template_row_currencies_indicator_code_idx" ON "pair_template_row_currencies"("indicator_code");

-- CreateIndex
CREATE UNIQUE INDEX "pair_template_row_currencies_template_row_id_currency_code_key" ON "pair_template_row_currencies"("template_row_id", "currency_code");

-- CreateIndex
CREATE INDEX "asset_indicator_map_asset_id_idx" ON "asset_indicator_map"("asset_id");

-- CreateIndex
CREATE INDEX "asset_indicator_map_indicator_id_idx" ON "asset_indicator_map"("indicator_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_indicator_map_asset_id_indicator_id_key" ON "asset_indicator_map"("asset_id", "indicator_id");

-- CreateIndex
CREATE INDEX "compass_inputs_observation_date_idx" ON "compass_inputs"("observation_date" DESC);

-- CreateIndex
CREATE INDEX "compass_inputs_input_code_observation_date_idx" ON "compass_inputs"("input_code", "observation_date" DESC);

-- CreateIndex
CREATE INDEX "compass_inputs_observation_date_is_validation_idx" ON "compass_inputs"("observation_date", "is_validation");

-- CreateIndex
CREATE UNIQUE INDEX "compass_inputs_observation_date_input_code_is_validation_key" ON "compass_inputs"("observation_date", "input_code", "is_validation");

-- CreateIndex
CREATE INDEX "compass_classifications_classification_date_idx" ON "compass_classifications"("classification_date" DESC);

-- CreateIndex
CREATE INDEX "compass_classifications_date_current_idx" ON "compass_classifications"("classification_date", "is_current");

-- CreateIndex
CREATE INDEX "compass_classifications_classification_date_is_validation_idx" ON "compass_classifications"("classification_date", "is_validation");

-- CreateIndex
CREATE UNIQUE INDEX "compass_classifications_classification_date_vintage_date_key" ON "compass_classifications"("classification_date", "vintage_date");

-- CreateIndex
CREATE INDEX "compass_module_readings_classification_date_module_code_idx" ON "compass_module_readings"("classification_date" DESC, "module_code");

-- CreateIndex
CREATE INDEX "compass_module_readings_reading_code_classification_date_idx" ON "compass_module_readings"("reading_code", "classification_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "compass_module_readings_classification_date_module_code_rea_key" ON "compass_module_readings"("classification_date", "module_code", "reading_code", "is_validation", "research_tag");

-- CreateIndex
CREATE INDEX "compass_module_states_classification_date_idx" ON "compass_module_states"("classification_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "compass_module_states_classification_date_module_code_is_va_key" ON "compass_module_states"("classification_date", "module_code", "is_validation", "research_tag");

-- CreateIndex
CREATE INDEX "compass_synthesis_classification_date_idx" ON "compass_synthesis"("classification_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "compass_synthesis_classification_date_is_validation_researc_key" ON "compass_synthesis"("classification_date", "is_validation", "research_tag");

-- CreateIndex
CREATE INDEX "compass_classifications_archive_classification_date_idx" ON "compass_classifications_archive"("classification_date" DESC);

-- CreateIndex
CREATE INDEX "compass_inputs_archive_observation_date_idx" ON "compass_inputs_archive"("observation_date" DESC);

-- CreateIndex
CREATE INDEX "compass_inputs_archive_input_code_observation_date_idx" ON "compass_inputs_archive"("input_code", "observation_date" DESC);

-- CreateIndex
CREATE INDEX "compass_validation_reports_generated_at_idx" ON "compass_validation_reports"("generated_at" DESC);

-- CreateIndex
CREATE INDEX "compass_config_effective_from_idx" ON "compass_config"("effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "compass_config_version_label_key" ON "compass_config"("version_label");

-- CreateIndex
CREATE UNIQUE INDEX "compass_curve_state_is_validation_research_tag_key" ON "compass_curve_state"("is_validation", "research_tag");

-- CreateIndex
CREATE UNIQUE INDEX "compass_shock_state_is_validation_research_tag_key" ON "compass_shock_state"("is_validation", "research_tag");

-- CreateIndex
CREATE INDEX "trading_accounts_user_id_created_at_idx" ON "trading_accounts"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "trading_accounts_user_id_status_idx" ON "trading_accounts"("user_id", "status");

-- CreateIndex
CREATE INDEX "trades_user_id_date_opened_idx" ON "trades"("user_id", "date_opened" DESC);

-- CreateIndex
CREATE INDEX "executions_trade_id_idx" ON "executions"("trade_id");

-- CreateIndex
CREATE INDEX "executions_account_id_idx" ON "executions"("account_id");

-- CreateIndex
CREATE INDEX "executions_account_id_date_closed_idx" ON "executions"("account_id", "date_closed");

-- CreateIndex
CREATE INDEX "planned_trades_user_id_status_idx" ON "planned_trades"("user_id", "status");

-- CreateIndex
CREATE INDEX "planned_trades_user_id_date_added_idx" ON "planned_trades"("user_id", "date_added" DESC);

-- CreateIndex
CREATE INDEX "cash_flows_account_id_date_idx" ON "cash_flows"("account_id", "date");

-- CreateIndex
CREATE INDEX "cash_flows_user_id_idx" ON "cash_flows"("user_id");

-- CreateIndex
CREATE INDEX "trading_models_user_id_idx" ON "trading_models"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "trading_models_user_id_name_key" ON "trading_models"("user_id", "name");

-- CreateIndex
CREATE INDEX "trading_pairs_user_id_idx" ON "trading_pairs"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "trading_pairs_user_id_symbol_key" ON "trading_pairs"("user_id", "symbol");

-- AddForeignKey
ALTER TABLE "scoring_rules" ADD CONSTRAINT "scoring_rules_indicator_id_fkey" FOREIGN KEY ("indicator_id") REFERENCES "indicators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_points" ADD CONSTRAINT "data_points_indicator_id_fkey" FOREIGN KEY ("indicator_id") REFERENCES "indicators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_points" ADD CONSTRAINT "data_points_fetched_via_fkey" FOREIGN KEY ("fetched_via") REFERENCES "data_fetch_log"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "indicator_variants" ADD CONSTRAINT "indicator_variants_indicator_id_fkey" FOREIGN KEY ("indicator_id") REFERENCES "indicators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_indicator_id_fkey" FOREIGN KEY ("indicator_id") REFERENCES "indicators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_fetched_via_fkey" FOREIGN KEY ("fetched_via") REFERENCES "data_fetch_log"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_deferrals" ADD CONSTRAINT "calendar_event_deferrals_calendar_event_id_fkey" FOREIGN KEY ("calendar_event_id") REFERENCES "calendar_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_deferrals" ADD CONSTRAINT "calendar_event_deferrals_indicator_id_fkey" FOREIGN KEY ("indicator_id") REFERENCES "indicators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scores" ADD CONSTRAINT "scores_indicator_id_fkey" FOREIGN KEY ("indicator_id") REFERENCES "indicators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scores" ADD CONSTRAINT "scores_rule_version_id_fkey" FOREIGN KEY ("rule_version_id") REFERENCES "scoring_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scores" ADD CONSTRAINT "scores_data_point_id_fkey" FOREIGN KEY ("data_point_id") REFERENCES "data_points"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nifty_scorecards" ADD CONSTRAINT "nifty_scorecards_rating_rule_id_fkey" FOREIGN KEY ("rating_rule_id") REFERENCES "scorecard_rating_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edgefinder_scorecards" ADD CONSTRAINT "edgefinder_scorecards_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edgefinder_pair_scores" ADD CONSTRAINT "edgefinder_pair_scores_pair_id_fkey" FOREIGN KEY ("pair_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cot_data" ADD CONSTRAINT "cot_data_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pair_template_row_currencies" ADD CONSTRAINT "pair_template_row_currencies_template_row_id_fkey" FOREIGN KEY ("template_row_id") REFERENCES "pair_template_rows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_indicator_map" ADD CONSTRAINT "asset_indicator_map_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_indicator_map" ADD CONSTRAINT "asset_indicator_map_indicator_id_fkey" FOREIGN KEY ("indicator_id") REFERENCES "indicators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_trade_id_fkey" FOREIGN KEY ("trade_id") REFERENCES "trades"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_flows" ADD CONSTRAINT "cash_flows_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

