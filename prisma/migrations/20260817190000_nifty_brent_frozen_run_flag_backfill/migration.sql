-- B5 backfill: flag the two unambiguous Brent frozen runs found in the A5
-- audit. Values are NOT changed, dates are NOT changed, isCurrent is NOT
-- changed — only dataQualityFlag is set to 'suspect' (existing enum value;
-- matches the hard-constraint language "suspect values get flagged, not
-- removed"). Suspect points are excluded from slope/sigma windows by the
-- percentile-rank/rolling-slope-sigma handlers' frozen-run detection (B6),
-- not by this flag directly — this flag is a record-level annotation for
-- anyone reading the row, independent of that detection.
--
-- Both runs are source = 'crude_price_api', value = 89.18, and are
-- documented in code as an upstream feed freeze (crude-price-fetch.job.ts /
-- yahoo-brent-fetch.job.ts comments: "Brent moved off the Crude Price API
-- (which froze at 89.18 for 10+ consecutive days)"). Unambiguous per your
-- confirmation. Nothing else is touched — RBI rate, USD Weakness, and DII
-- Absorption's flat/zero runs were verified legitimate (see chat report)
-- and are explicitly NOT flagged here.
--
-- Run 1: 2026-06-10 .. 2026-06-22 (12 dates)
-- Run 2: 2026-07-03 .. 2026-07-05 (3 dates)
UPDATE "data_points"
SET "data_quality_flag" = 'suspect'
WHERE "indicator_id" = (SELECT "id" FROM "indicators" WHERE "code" = 'IND_NIFTY_11_BRENT')
  AND "is_current" = true
  AND "source" = 'crude_price_api'
  AND "observation_date" IN (
    '2026-06-10','2026-06-12','2026-06-13','2026-06-14','2026-06-15','2026-06-16',
    '2026-06-17','2026-06-18','2026-06-19','2026-06-20','2026-06-21','2026-06-22',
    '2026-07-03','2026-07-04','2026-07-05'
  );
