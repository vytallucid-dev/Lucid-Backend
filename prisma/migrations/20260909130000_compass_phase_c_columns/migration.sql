-- Compass Phase C — provenance and trading-day columns, and singleton-cache keys.
--
-- 1. config_version_label
--    compass_config has a version_label, but compass_classifications and
--    compass_inputs had no column recording WHICH config produced a row. A row
--    could not be attributed to the formulas and weights that made it, which is
--    exactly what made the 2026-07-15/16 v1 -> v2 cutover so hard to reason
--    about after the fact. Populated from compassConfigRepository.resolveForDate
--    at write time. Nullable because the archived pre-Phase-C rows are gone from
--    these tables and nothing else needs backfilling.
--
-- 2. is_trading_day
--    False for any row the US market calendar says should not exist. Going
--    forward the classifier refuses to write on a closed market at all (see
--    runCompassClassifier's Step 0 gate), so this should stay true for every
--    live row; it exists as a durable marker for any row that predates the gate
--    or is written by a backfill, and so that "was this a real session?" is a
--    column rather than a recomputation.
--
-- 3. research_tag
--    Labels replay output so it can coexist with live data. Deliberately NOT
--    part of the unique key on either table: compass_classifications is unique
--    on (classification_date, vintage_date) and replay rows get their own
--    vintage_date, while the ported replay keeps its per-input state in memory
--    and reports input detail through vote_breakdown rather than writing
--    compass_inputs rows at all.
--
-- 4. compass_curve_state / compass_shock_state unique keys
--    Both were singletons keyed on is_validation alone, so any research run
--    would have overwritten live cache state. research_tag widens the key.
--
--    It is NOT NULL DEFAULT '' rather than nullable ON PURPOSE. Postgres treats
--    NULLs as distinct in a unique index, so a nullable research_tag would allow
--    unlimited duplicate ('live', NULL) rows and silently destroy the singleton
--    guarantee these two caches depend on. '' means "live".
--
--    Both tables are documented in the schema as recomputable caches, not
--    sources of truth, so widening their key cannot lose anything.

-- ---------------------------------------------------------------- 1, 2, 3
ALTER TABLE "compass_classifications"
    ADD COLUMN "config_version_label" VARCHAR(20),
    ADD COLUMN "research_tag"         VARCHAR(40),
    ADD COLUMN "is_trading_day"       BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "compass_inputs"
    ADD COLUMN "config_version_label" VARCHAR(20),
    ADD COLUMN "research_tag"         VARCHAR(40),
    ADD COLUMN "is_trading_day"       BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "compass_classifications_research_tag_idx"
    ON "compass_classifications" ("research_tag");

CREATE INDEX "compass_inputs_research_tag_idx"
    ON "compass_inputs" ("research_tag");

-- ---------------------------------------------------------------- 4
ALTER TABLE "compass_curve_state"
    ADD COLUMN "research_tag" VARCHAR(40) NOT NULL DEFAULT '';

ALTER TABLE "compass_shock_state"
    ADD COLUMN "research_tag" VARCHAR(40) NOT NULL DEFAULT '';

DROP INDEX IF EXISTS "compass_curve_state_is_validation_key";
DROP INDEX IF EXISTS "compass_shock_state_is_validation_key";

CREATE UNIQUE INDEX "compass_curve_state_is_validation_research_tag_key"
    ON "compass_curve_state" ("is_validation", "research_tag");

CREATE UNIQUE INDEX "compass_shock_state_is_validation_research_tag_key"
    ON "compass_shock_state" ("is_validation", "research_tag");
