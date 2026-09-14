-- Journal capture — regime at entry, rule breaks, excursion (MFE/MAE).
--
-- WHY THIS EXISTS
-- ----------------
-- The journal redesign's analytics need three facts the journal never stored:
--
--   1. The Compass regime on the entry date, so performance can be read by
--      market state. Snapshotted server-side at write time from
--      compass_classifications (the same "captured once, never re-read" rule as
--      the Oracle entry snapshot). No backfill here: the live classification
--      series begins 2026-09-09, and backfilling from the archive table is an
--      open decision (D4, default: no).
--
--   2. Rule breaks: short tags the trader chooses in the form. Empty array =
--      nothing recorded as broken.
--
--   3. Excursion per fill: the best (MFE) and worst (MAE) price reached before
--      the exit, and whether price returned to the entry after the MFE. All
--      optional and nullable — null means "not recorded", never zero.
--
-- Purely additive: new nullable columns (and one array with an empty default).
-- No existing column, row or constraint is modified, and no trade data is
-- rewritten.

-- ── trades ──────────────────────────────────────────────────────────────────
ALTER TABLE "trades"
  ADD COLUMN "compass_regime_at_entry"     VARCHAR(15),
  ADD COLUMN "compass_regime_entry_date"   DATE,
  ADD COLUMN "compass_regime_entry_source" VARCHAR(10),
  ADD COLUMN "rule_breaks"                 TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Provenance is one of three values, exactly as the Oracle source column is
-- constrained (trades_oracle_score_entry_source_check). Raw SQL — Prisma
-- cannot express a CHECK constraint, so this is intentional drift from
-- schema.prisma, like the Oracle one.
ALTER TABLE "trades"
  ADD CONSTRAINT "trades_compass_regime_entry_source_check"
  CHECK ("compass_regime_entry_source" IS NULL OR "compass_regime_entry_source" IN ('snapshot', 'archive', 'manual'));

-- ── executions ──────────────────────────────────────────────────────────────
ALTER TABLE "executions"
  ADD COLUMN "mfe_price"                   DECIMAL(20, 6),
  ADD COLUMN "mae_price"                   DECIMAL(20, 6),
  ADD COLUMN "returned_to_entry_after_mfe" BOOLEAN;
