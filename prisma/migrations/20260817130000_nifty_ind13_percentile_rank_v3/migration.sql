-- Replace IND_NIFTY_13_FII_LS_RATIO scoring: threshold_bands (static 28.6/50
-- long_pct bands) -> percentile_rank (expanding-window percentile of long_pct
-- against its own history).
--
-- This is a NEW version row (v3), not an in-place edit of v2's rule_definition.
-- The 2026-06-29 recalibration migration mutated v2's bands via jsonb_set,
-- which destroyed the ability to see what the rule looked like before that
-- change. Versioning it properly this time: v2 is closed out with
-- effective_to = yesterday, v3 opens at effective_from = today. v2's row and
-- its (already-anomalous, pre-existing, NOT touched here) effective_from value
-- are otherwise left exactly as they were.
--
-- New rule (handlers/percentile-rank.handler.ts):
--   * min_observations: 60 (expanding-window count as of the scoring date,
--     inclusive of that date's own reading). Below 60 -> score 0, flagged
--     INSUFFICIENT_HISTORY, no -1/+1 ever emitted on a short window.
--   * bands are percentile tiers, same min-inclusive/max-exclusive convention
--     as every other banded rule in this codebase:
--       percentile <  20            -> -1
--       20 <= percentile < 80       ->  0
--       percentile >= 80            -> +1
--   * contrarian_watch_max_percentile: 5 -- when percentile < 5 (a subset of
--     the -1 tier), additionally sets flag CONTRARIAN_WATCH, same mechanism
--     VIX's band_with_flag rule already uses (flag on a Band, surfaced via
--     Score.flag -> indicator_breakdown -> public API `flags` array).
--   * historical_default: 0 -- if no data point exists at all for/before the
--     scoring date (e.g. pre-2026-05-04), same HISTORICAL_DEFAULT_NO_DATA
--     fallback the old rule used, unchanged behaviour.
--   * Percentile is computed against DISTINCT observation dates, not raw
--     data_points rows -- 2026-07-16 has two is_current rows (a pre-existing,
--     out-of-scope data anomaly); the handler collapses same-date rows to the
--     most recent vintage_date before ranking.
--
-- As of this migration, IND_NIFTY_13_FII_LS_RATIO has 55 distinct dated
-- observations (2026-05-04 .. 2026-08-14) -- below the 60-observation floor,
-- so every date scores 0 / INSUFFICIENT_HISTORY until 5 more trading days of
-- data have been ingested. This is expected, not a bug -- see chat report.
UPDATE "scoring_rules"
SET "effective_to" = '2026-08-16'
WHERE "indicator_id" = (SELECT "id" FROM "indicators" WHERE "code" = 'IND_NIFTY_13_FII_LS_RATIO')
  AND "version" = 2
  AND "effective_to" IS NULL;

INSERT INTO "scoring_rules" (
  "id",
  "indicator_id",
  "version",
  "rule_type",
  "rule_definition",
  "effective_from",
  "effective_to",
  "notes",
  "created_at"
)
VALUES (
  gen_random_uuid()::text,
  (SELECT "id" FROM "indicators" WHERE "code" = 'IND_NIFTY_13_FII_LS_RATIO'),
  3,
  'custom',
  '{
    "type": "percentile_rank",
    "metric": "long_pct",
    "window": "expanding",
    "min_observations": 60,
    "bands": [
      { "min": null, "max": 20, "score": -1 },
      { "min": 20, "max": 80, "score": 0 },
      { "min": 80, "max": null, "score": 1 }
    ],
    "contrarian_watch_max_percentile": 5,
    "contrarian_watch_flag": "CONTRARIAN_WATCH",
    "historical_default": 0,
    "cadence": "daily"
  }'::jsonb,
  '2026-08-17',
  NULL,
  'v3: replaces static threshold_bands (28.6/50 on long_pct) with an expanding-window percentile rank. Ind 13 is excluded from net_score as of this same date (see nifty_scorecards.ind_13_score migration) pending validation.',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("indicator_id", "version") DO NOTHING;
