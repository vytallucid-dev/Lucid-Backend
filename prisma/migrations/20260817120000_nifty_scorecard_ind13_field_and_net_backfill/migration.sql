-- Remove IND_NIFTY_13_FII_LS_RATIO (FII Long/Short Futures) from NIFTY net_score.
--
-- Prior behaviour: net_score = domestic_score + external_score + ind13Score,
-- with Ind 13 folded in as an unlabeled third term outside both composites
-- (scorecard-assembly.service.ts). This meant domestic_score + external_score
-- did not equal net_score on any date where Ind 13 scored non-zero — and Ind 13
-- has scored exactly -1 on every scorecard ever assembled (91/91 isCurrent rows
-- as of this migration), so live net_score has been one point below
-- domestic+external on every single day since inception.
--
-- This migration:
--   1. Adds ind_13_score — Ind 13's score persisted standalone, so the API/UI
--      can display it without recomputing or reading indicator_breakdown JSON.
--      Ind 13 continues to be computed and returned; it is simply no longer
--      summed into any composite.
--   2. Backfills ALL existing nifty_scorecards rows (current and superseded):
--      net_score is recomputed as domestic_score + external_score, and
--      ind_13_score is populated from the score already recorded in
--      indicator_breakdown for that row (no rescoring — historical Ind 13
--      scores are taken as-is, computed under whatever rule was active then).
--
-- Predicted impact (verified by dry-run SELECT before this migration ran):
--   100/100 rows (all vintages, not just is_current) move by exactly net_score
--   += 1, because ind13_score was -1 on every row with no exceptions. Actual
--   result matched this prediction exactly — see chat report for the
--   before/after verification query.
--
-- Companion migration 20260817130000_nifty_ind13_percentile_rank_v3 replaces
-- Ind 13's scoring rule going forward; this migration does not touch
-- scoring_rules or re-score anything — it only backfills already-persisted
-- scorecard rows.
ALTER TABLE "nifty_scorecards" ADD COLUMN "ind_13_score" SMALLINT;

UPDATE "nifty_scorecards"
SET
  "ind_13_score" = (indicator_breakdown -> 'IND_NIFTY_13_FII_LS_RATIO' ->> 'score')::smallint,
  "net_score" = "domestic_score" + "external_score";
