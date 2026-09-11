-- Compass Phase C — archive tables for the abandoned live classification series.
--
-- WHY
-- ---
-- The live Compass series accumulated between 2026-05-18 and 2026-09-08 is being
-- abandoned rather than repaired, and restarted clean. It is unusable as a
-- continuous history for four independent reasons, all verified against this
-- database in Phase C Stage 0:
--
--   1. It straddles the v1 -> v2 config cutover mid-series (2026-07-15/16), so
--      the first 45 rows were produced by different formulas and weights than
--      the last 53.
--   2. 28 of its 104 classification rows fall on Saturdays or Sundays, and at
--      least three more on US market holidays (Juneteenth 2026-06-19,
--      Independence Day observed 2026-07-03, Labor Day 2026-09-07). Every one of
--      those rows advanced the persistence counter, which means a regime
--      transition could complete on a closed market on no new information.
--   3. All 46 pre-cutover DXY_TREND rows store the deviation as a PERCENT
--      (|close/sma50 - 1| * 100) where the v2 band evaluator expects a fraction,
--      so all 46 are mis-banded: 39 YELLOW that should be GREEN, and 7 GREEN
--      that should be YELLOW.
--   4. final_regime is the empty string on the 45 pre-Phase-4 rows.
--
-- These rows are NOT deleted. They are the evidence behind the Phase B findings
-- and the record of what the deployed system was doing, so they are moved here
-- and remain queryable indefinitely.
--
-- The archive deliberately mirrors the OLD schema. The Phase C columns
-- (config_version_label, research_tag, is_trading_day) are added to the live
-- tables in a later migration, after this archive is taken.
--
-- `source` is a plain VARCHAR here rather than the shared "DataSource" enum, so
-- the archive stays readable if that enum ever changes.
--
-- The rows themselves are moved by scripts/phase7-archive-live-series.ts, which
-- is transactional and idempotent. This migration only creates the tables.
--
-- See SYSTEM_REFERENCE.md section 3.3 "Known data incidents".

CREATE TABLE "compass_classifications_archive" (
    "id"                                    TEXT NOT NULL,
    "classification_date"                   DATE NOT NULL,
    "vintage_date"                          TIMESTAMP(3) NOT NULL,
    "is_current"                            BOOLEAN NOT NULL,
    "candidate_regime"                      VARCHAR(15) NOT NULL,
    "active_regime"                         VARCHAR(15) NOT NULL,
    "persistence_days_count"                INTEGER NOT NULL,
    "crisis_override_fired"                 BOOLEAN NOT NULL,
    "final_regime"                          VARCHAR(15) NOT NULL,
    "shock_a_active"                        BOOLEAN NOT NULL,
    "shock_b_active"                        BOOLEAN NOT NULL,
    "us02y_close"                           DECIMAL(20,6),
    "us02y_sma21"                           DECIMAL(20,6),
    "rate_gate_hawkish"                     BOOLEAN NOT NULL,
    "override_3_suppressed_by_gate"         BOOLEAN NOT NULL,
    "override_5_suppressed_by_gate"         BOOLEAN NOT NULL,
    "fed_constraint"                        VARCHAR(12) NOT NULL,
    "override_2_suppressed_by_constraint"   BOOLEAN NOT NULL,
    "overrides_active"                      JSONB,
    "total_green_weight"                    DECIMAL(5,2) NOT NULL,
    "total_yellow_weight"                   DECIMAL(5,2) NOT NULL,
    "total_red_weight"                      DECIMAL(5,2) NOT NULL,
    "vote_breakdown"                        JSONB NOT NULL,
    "is_validation"                         BOOLEAN NOT NULL,
    "computed_at"                           TIMESTAMP(3) NOT NULL,
    "archived_at"                           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archive_reason"                        TEXT NOT NULL,

    CONSTRAINT "compass_classifications_archive_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "compass_classifications_archive_classification_date_idx"
    ON "compass_classifications_archive" ("classification_date" DESC);

CREATE TABLE "compass_inputs_archive" (
    "id"               TEXT NOT NULL,
    "observation_date" DATE NOT NULL,
    "input_code"       VARCHAR(30) NOT NULL,
    "raw_value"        DECIMAL(20,6),
    "derived_value"    DECIMAL(20,6),
    "color_band"       VARCHAR(10) NOT NULL,
    "sub_checks"       JSONB,
    "source"           VARCHAR(30) NOT NULL,
    "is_validation"    BOOLEAN NOT NULL,
    "computed_at"      TIMESTAMP(3) NOT NULL,
    "archived_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archive_reason"   TEXT NOT NULL,

    CONSTRAINT "compass_inputs_archive_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "compass_inputs_archive_observation_date_idx"
    ON "compass_inputs_archive" ("observation_date" DESC);

CREATE INDEX "compass_inputs_archive_input_code_observation_date_idx"
    ON "compass_inputs_archive" ("input_code", "observation_date" DESC);
