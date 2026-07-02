-- Add NIFTY Ind 14 (IND_NIFTY_14_DII_FLOW) — DII Net Flow.
--
-- DISPLAY-ONLY indicator. Mirrors Ind 6 (IND_NIFTY_06_FII_FLOW) but stores DII net
-- flow (INR crore, signed) every trading day. It is NOT scored and NOT part of any
-- composite:
--   * It has NO scoring rule (none inserted here, none in seed-rules-v2.ts/seed.ts),
--     so the scoring engine would throw NO_ACTIVE_RULE if it ever tried to score it.
--   * computeAllScoresForDate explicitly skips it via NON_SCORED_NIFTY_INDICATORS,
--     so it never reaches the scorecard breakdown, polarity counts, or composites.
--   * composite_group is NULL (not 'domestic'/'external'), and the domestic/external
--     composite sums are driven by hardcoded code lists that do not include it.
-- Therefore net_score, domestic_composite, external_composite, band and all sub-tools
-- are unaffected by this indicator.
--
-- Idempotent: ON CONFLICT (code) DO NOTHING so re-running is a no-op and an existing
-- row (e.g. from `prisma db seed`) is left untouched.
--
-- NOTE: This migration only inserts the indicator ROW. The daily data_point writes are
-- performed by nse-fii-dii.service.ts from the next ingestion forward. No backfill:
-- historical DII net data was never captured and NSE only returns the latest day.
INSERT INTO "indicators" (
  "id",
  "code",
  "name",
  "category",
  "tool",
  "frequency",
  "unit",
  "data_source",
  "display_order",
  "composite_group",
  "is_active",
  "created_at",
  "updated_at"
)
VALUES (
  gen_random_uuid()::text,
  'IND_NIFTY_14_DII_FLOW',
  'DII Net Flow',
  'flow',
  'nifty',
  'daily',
  'INR_crore',
  'nse_scrape',
  14,
  NULL,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO NOTHING;
