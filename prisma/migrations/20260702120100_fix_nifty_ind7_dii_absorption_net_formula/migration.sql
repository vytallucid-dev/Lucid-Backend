-- Fix NIFTY Ind 7 (IND_NIFTY_07_DII_ABSORPTION) scoring: net numerator + new tiers.
--
-- The absorption numerator was DII GROSS buy; it must be DII NET (buy − sell). The
-- ingestion service now computes ratio = dii_net / abs(fii_sell) using NSE's own
-- precomputed net field. This migration realigns the LIVE v2 scoring rule's tier
-- table and formula doc string to match. (seed-rules-v2.ts uses upsert update:{} and
-- will NOT touch a live DB, so the live rule must be patched here — same pattern as
-- 20260629120000_recalibrate_nifty_ind13_fii_ls_bands.)
--
-- The rolling_ratio_excluding handler treats tier.min as inclusive (>=) and tier.max
-- as exclusive (<).
--
-- OLD tiers (gross-buy ratio):        NEW tiers (net ratio):
--   >= 0.75         -> +1              >= 0.75        -> +1
--   0.5 <= x < 0.75 ->  0              0 <= x < 0.75  ->  0
--   x < 0.5         -> -1              x < 0          -> -2   ("both fleeing")
--
-- The -2 tier (DII also net selling on the FII-seller days) is NEW; the boundary at 0
-- is NEW; the old 0.5 cutpoint is REMOVED. When the rolling average is < 0 the handler
-- also emits the flag 'DII_NET_SELLER_REGIME'.
--
-- Scoped by indicator code and version; no other indicator or rule version touched.
-- Updates ONLY the 'tiers' and 'formula' keys, preserving lookback_trading_days,
-- exclusion, all_excluded_fallback and cadence.
--
-- FORWARD-ONLY: existing historical data_points rows are NOT modified or recomputed.
-- Only the scoring rule that future score computations use is changed.
UPDATE "scoring_rules"
SET "rule_definition" = jsonb_set(
  jsonb_set(
    "rule_definition"::jsonb,
    '{tiers}',
    '[
      { "min": 0.75, "max": null, "score": 1 },
      { "min": 0, "max": 0.75, "score": 0 },
      { "min": null, "max": 0, "score": -2 }
    ]'::jsonb
  ),
  '{formula}',
  '"dii_net / abs(fii_sell)"'::jsonb,
  true
)
WHERE "indicator_id" = (SELECT "id" FROM "indicators" WHERE "code" = 'IND_NIFTY_07_DII_ABSORPTION')
  AND "version" = 2;
