-- Compass v2 Phase 4: adds the Shock Layer's daily outcome to
-- compass_classifications.
--
--   final_regime   = 'Risk-Off' when shock_a_active, else equals
--                    active_regime unchanged. Existing rows predate the
--                    Shock Layer and get '' (empty) — a live re-run of the
--                    classifier for any date backfills the real value; the
--                    column is never read as authoritative for rows where
--                    it is ''.
--   shock_a_active / shock_b_active = whether each trigger was active on
--                    that classification date. Default false for existing
--                    (pre-Phase-4) rows, which is correct: no shock layer
--                    existed then.
--
-- Purely additive — no existing column altered. crisis_override_fired is
-- LEFT IN PLACE (historical record); this migration does not touch it.
ALTER TABLE "compass_classifications" ADD COLUMN     "final_regime" VARCHAR(15) NOT NULL DEFAULT '',
ADD COLUMN     "shock_a_active" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shock_b_active" BOOLEAN NOT NULL DEFAULT false;
