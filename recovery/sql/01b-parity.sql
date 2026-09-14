-- =============================================================================
-- Lucid recovery — Stage 1.2 step 2b: parity with the migration history.
--
-- Run AFTER db push and 01-post-push.sql. Idempotent. One transaction.
--
-- Found by 11-verify-schema.ts on 2026-09-14. Every item is a definition that
-- is identical between `db push` and the migrations but differs in NAME or
-- KIND, or an index schema.prisma never declared. Production ran the
-- migrations, so production's names and kinds win.
--
--   * db push truncates generated identifiers at Postgres's 63-byte limit
--     differently from the explicit names the migrations wrote.
--   * 20260909130000 created two research_tag indexes schema.prisma omits.
--   * compass_inputs' unique was a CONSTRAINT in production; db push builds a
--     bare unique INDEX of the same name.
-- No application code references any of these names (grep, 2026-09-14);
-- this is for future migrations, which do.
-- =============================================================================

BEGIN;

-- ── Index names: db push default → migration-history name ────────────────────
-- 20260807120000_datapoint_release_variant
ALTER INDEX IF EXISTS "data_points_indicator_id_observation_date_variant_vintage_d_key"
  RENAME TO "data_points_indicator_id_observation_date_variant_vintage_key";

-- 20260909140000_compass_phase_c_module_state
ALTER INDEX IF EXISTS "compass_module_readings_classification_date_module_code_rea_key"
  RENAME TO "compass_module_readings_unique_key";
ALTER INDEX IF EXISTS "compass_module_readings_classification_date_module_code_idx"
  RENAME TO "compass_module_readings_date_module_idx";
ALTER INDEX IF EXISTS "compass_module_readings_reading_code_classification_date_idx"
  RENAME TO "compass_module_readings_reading_date_idx";
ALTER INDEX IF EXISTS "compass_module_states_classification_date_module_code_is_va_key"
  RENAME TO "compass_module_states_unique_key";
ALTER INDEX IF EXISTS "compass_module_states_classification_date_idx"
  RENAME TO "compass_module_states_date_idx";
ALTER INDEX IF EXISTS "compass_synthesis_classification_date_is_validation_researc_key"
  RENAME TO "compass_synthesis_unique_key";
ALTER INDEX IF EXISTS "compass_synthesis_classification_date_idx"
  RENAME TO "compass_synthesis_date_idx";

-- ── Indexes schema.prisma does not declare ───────────────────────────────────
-- 20260909130000_compass_phase_c_columns
CREATE INDEX IF NOT EXISTS "compass_classifications_research_tag_idx" ON "compass_classifications" ("research_tag");
CREATE INDEX IF NOT EXISTS "compass_inputs_research_tag_idx" ON "compass_inputs" ("research_tag");

-- ── compass_inputs unique: CONSTRAINT, as in production ──────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'compass_inputs_observation_date_input_code_is_validation_key'
      AND conrelid = 'public.compass_inputs'::regclass
  ) THEN
    ALTER TABLE "compass_inputs"
      ADD CONSTRAINT "compass_inputs_observation_date_input_code_is_validation_key"
      UNIQUE USING INDEX "compass_inputs_observation_date_input_code_is_validation_key";
  END IF;
END $$;

COMMIT;
