-- Recalibrate NIFTY Ind 13 (IND_NIFTY_13_FII_LS_RATIO) scoring bands.
--
-- The stored value is a long-SHARE percentage on a 0-100 scale:
--   long_pct = FII Future Index Long / (Long + Short) * 100
-- (NOT a raw long/short ratio, NOT a 0-1 fraction). The threshold_bands handler
-- treats band.min as inclusive (>=) and band.max as exclusive (<).
--
-- OLD bands (45/55):                NEW bands (50/28.6):
--   >= 55        -> +1               >= 50        -> +1   (ratio > 1.0)
--   45 <= x < 55 ->  0               28.6 <= x < 50 ->  0 (ratio 0.4 .. 1.0)
--   x < 45       -> -1               x < 28.6     -> -1   (ratio < 0.4)
--
-- Recalibrated from 45/55 (which assumed a 50%-balanced center). FII index-futures
-- long share is structurally skewed toward shorts (FIIs hedge cash longs with
-- futures shorts), so it sits below 45% in essentially all regimes and the old
-- bands pinned Ind 13 permanently at -1 (dead signal). New bands center the neutral
-- zone on the metric's real operating range. Reference: historical FII long/short
-- ratio 0.15 (Dec 2024 bearish extreme) to 5+ (strong-bull extreme); crossover to
-- net-long = ratio 1.0 = 50% share. 50/28.6 thresholds derive from ratio 1.0 and
-- 0.4 — not fit to current data.
--
-- This only changes the current regime's signal during FUTURE bull phases
-- (share > 28.6% / ratio > 0.4). Today's bearish readings (~13% share) remain -1.
-- Single-indicator change: scoped by indicator code; no other indicator touched.
-- Updates ONLY the 'bands' key of rule_definition (jsonb_set), preserving metric,
-- cadence, live_tracking_only and historical_default.
UPDATE "scoring_rules"
SET "rule_definition" = jsonb_set(
  "rule_definition"::jsonb,
  '{bands}',
  '[
    { "min": 50.0, "max": null, "score": 1 },
    { "min": 28.6, "max": 50.0, "score": 0 },
    { "min": null, "max": 28.6, "score": -1 }
  ]'::jsonb
)
WHERE "indicator_id" = (SELECT "id" FROM "indicators" WHERE "code" = 'IND_NIFTY_13_FII_LS_RATIO')
  AND "version" = 2;
