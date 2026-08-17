-- Replace the price-block indicators' scoring: endpoint-delta
-- (rolling_pct_direction / rolling_pct_tiered, comparing only the newest and
-- oldest of an 11-row window) -> rolling_slope_sigma (an OLS fit across all
-- 10 observations in the window, scored against the indicator's own trailing
-- volatility instead of a fixed percentage).
--
--   Ind 10 IND_NIFTY_10_DXY     3-tier, +/-0.5 sigma
--   Ind 11 IND_NIFTY_11_BRENT   3-tier, +/-0.5 sigma (same tier shape as DXY)
--   Ind 12 IND_NIFTY_12_USDINR  5-tier, +/-0.5 / +/-1.5 sigma (unchanged tier
--                               count from the old rule; boundaries changed
--                               from fixed pct to sigma multiples)
--
-- Handler: handlers/rolling-slope-sigma.handler.ts (new, registered as
-- rolling_slope_sigma in engine.ts). Not shared with rolling_pct_direction /
-- rolling_pct_tiered, which remain registered and unchanged -- their v2 rows
-- close out below but stay fully functional for any future rescoring of a
-- date that falls in their effective range (2020-01-01 .. 2026-08-16).
--
-- window_size: 10 (NOT 11 -- correction from Phase A recon, which found the
-- old handlers' `needed = lookback_trading_days + 1 = 11` produces a 2-point
-- endpoint delta across an 11-row set; the OLS fit specified for this rule
-- uses all 10 observations directly, x = 0..9, so the window requirement is
-- 10, not 11).
--
-- sigma_lookback_max: 250, sigma_lookback_min: 60 (below 60 -> insufficient_data).
--
-- Known, documented, accepted limitation for Ind 10 (DXY): ingestion for this
-- indicator only began 2026-04-23, so as of this migration DXY has ~82
-- distinct dated observations (~73 possible slope-measure points) -- it will
-- not reach the 250-observation sigma target until roughly April 2027 at
-- daily cadence. Per instruction, DXY runs the IDENTICAL algorithm as Brent
-- and USD/INR with no special-casing and no compensating rule: sigma is a
-- volatility estimate rather than a signal estimate, and is reasonably
-- stable at n~=75; the fixed-percentage rule it replaces was calibrated on no
-- data at all, so a volatility-derived deadband from ~75 observations is
-- still a strict improvement.
--
-- This migration touches ONLY scoring_rules. Per instruction, NO historical
-- nifty_scorecards row is backfilled or rescored in this phase -- existing
-- scores keep whatever the v2 endpoint-delta rule produced for their date.
-- The new v3 rule applies live-forward only, starting today.
UPDATE "scoring_rules"
SET "effective_to" = '2026-08-16'
WHERE "indicator_id" IN (
  SELECT "id" FROM "indicators"
  WHERE "code" IN ('IND_NIFTY_10_DXY', 'IND_NIFTY_11_BRENT', 'IND_NIFTY_12_USDINR')
)
AND "version" = 2
AND "effective_to" IS NULL;

INSERT INTO "scoring_rules" (
  "id", "indicator_id", "version", "rule_type", "rule_definition",
  "effective_from", "effective_to", "notes", "created_at"
)
VALUES
(
  gen_random_uuid()::text,
  (SELECT "id" FROM "indicators" WHERE "code" = 'IND_NIFTY_10_DXY'),
  3,
  'custom',
  '{
    "type": "rolling_slope_sigma",
    "window_size": 10,
    "sigma_lookback_max": 250,
    "sigma_lookback_min": 60,
    "bands": [
      { "min": null, "max": -0.5, "score": 1 },
      { "min": -0.5, "max": 0.5,  "score": 0 },
      { "min": 0.5,  "max": null, "score": -1 }
    ],
    "cadence": "daily"
  }'::jsonb,
  '2026-08-17',
  NULL,
  'v3: OLS slope over the 10-observation window, scored against trailing sigma (min 60, target 250 observations) instead of a fixed pct threshold. Known limitation: DXY has only ~82 distinct observations as of this rule (ingestion began 2026-04-23) -- sigma runs on a shorter window than Brent/USDINR until ~April 2027, by design, no special-casing.',
  CURRENT_TIMESTAMP
),
(
  gen_random_uuid()::text,
  (SELECT "id" FROM "indicators" WHERE "code" = 'IND_NIFTY_11_BRENT'),
  3,
  'custom',
  '{
    "type": "rolling_slope_sigma",
    "window_size": 10,
    "sigma_lookback_max": 250,
    "sigma_lookback_min": 60,
    "bands": [
      { "min": null, "max": -0.5, "score": 1 },
      { "min": -0.5, "max": 0.5,  "score": 0 },
      { "min": 0.5,  "max": null, "score": -1 }
    ],
    "cadence": "daily"
  }'::jsonb,
  '2026-08-17',
  NULL,
  'v3: OLS slope over the 10-observation window, scored against trailing sigma (min 60, target 250 observations) instead of a fixed pct threshold.',
  CURRENT_TIMESTAMP
),
(
  gen_random_uuid()::text,
  (SELECT "id" FROM "indicators" WHERE "code" = 'IND_NIFTY_12_USDINR'),
  3,
  'custom',
  '{
    "type": "rolling_slope_sigma",
    "window_size": 10,
    "sigma_lookback_max": 250,
    "sigma_lookback_min": 60,
    "bands": [
      { "min": null, "max": -1.5, "score": 2 },
      { "min": -1.5, "max": -0.5, "score": 1 },
      { "min": -0.5, "max": 0.5,  "score": 0 },
      { "min": 0.5,  "max": 1.5,  "score": -1 },
      { "min": 1.5,  "max": null, "score": -2 }
    ],
    "cadence": "daily"
  }'::jsonb,
  '2026-08-17',
  NULL,
  'v3: OLS slope over the 10-observation window, scored against trailing sigma (min 60, target 250 observations) instead of a fixed pct threshold. 5-tier resolution unchanged from v2.',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("indicator_id", "version") DO NOTHING;
