-- Compass Phase C — widen compass_module_readings.source_code.
--
-- A reading that is DERIVED from several series must cite all of them, because
-- provenance is rendered next to the number and a partial citation is worse than
-- none. The hedged 30-year JPY pickup is computed from a US 30-year yield, a JGB
-- 30-year yield and two central bank policy rates:
--
--   'FRED:DGS30 / MOF:JGB30Y / BIS:CBPOL_US,JP'   -- 41 characters
--
-- which overflowed VARCHAR(40) by one. Truncating the provenance to fit the
-- column would defeat the point of storing it, so the column grows instead.
-- 80 leaves room for a four-source composite.

ALTER TABLE "compass_module_readings"
    ALTER COLUMN "source_code" TYPE VARCHAR(80);
