-- Performance: composite indexes for the hot "latest current row" read paths.
-- These back the public Oracle/NIFTY read APIs, which filter on
-- (key, is_current) and order by the date column descending. The pre-existing
-- (date, is_current) indexes don't serve these well because the leading column
-- is the date, not the entity key.

-- NIFTY: getLatestScorecard / velocity / v-bottom → WHERE is_current ORDER BY observation_date DESC
CREATE INDEX IF NOT EXISTS "nifty_scorecards_current_date_idx"
  ON "nifty_scorecards" ("is_current", "observation_date" DESC);

-- EdgeFinder asset scorecard → WHERE asset_id = ? AND is_current ORDER BY observation_date DESC
CREATE INDEX IF NOT EXISTS "edgefinder_scorecards_asset_current_date_idx"
  ON "edgefinder_scorecards" ("asset_id", "is_current", "observation_date" DESC);

-- EdgeFinder pair score → WHERE pair_id IN (...) AND is_current ORDER BY score_date DESC
CREATE INDEX IF NOT EXISTS "edgefinder_pair_scores_pair_current_date_idx"
  ON "edgefinder_pair_scores" ("pair_id", "is_current", "score_date" DESC);

-- COT → WHERE asset_id IN (...) AND is_current ORDER BY report_date DESC
CREATE INDEX IF NOT EXISTS "cot_data_asset_current_date_idx"
  ON "cot_data" ("asset_id", "is_current", "report_date" DESC);
