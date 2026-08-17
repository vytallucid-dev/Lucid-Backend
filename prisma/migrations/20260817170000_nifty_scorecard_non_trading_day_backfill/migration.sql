-- B2: mark existing weekend/NSE-holiday NiftyScorecard rows. Not deleted —
-- flagged, so historical-series reads, velocity anchor selection, and band
-- distribution can exclude them (application-code filters added alongside
-- this migration; see chat report). Generation of NEW non-trading-day rows
-- is separately gated in scorecard-assembly trigger paths, not by this
-- migration (this migration is backfill-only, per instruction).
--
-- Predicted before running (dry-run SELECT, see chat report): 31 rows —
-- 29 weekend rows (Sat/Sun, all found by direct day-of-week query) + 2
-- weekday NSE-holiday rows discovered only once the nse_holidays calendar
-- existed (2026-05-28 Bakri Id, a Thursday; 2026-06-26 Muharram, a Friday).
-- Depends on migration 20260817160000_nse_holiday_calendar having already
-- run (uses the nse_holidays table it creates).
ALTER TABLE "nifty_scorecards" ADD COLUMN "is_non_trading_day" BOOLEAN NOT NULL DEFAULT false;

UPDATE "nifty_scorecards"
SET "is_non_trading_day" = true
WHERE EXTRACT(DOW FROM "observation_date") IN (0, 6)
   OR "observation_date" IN (SELECT "date" FROM "nse_holidays");
