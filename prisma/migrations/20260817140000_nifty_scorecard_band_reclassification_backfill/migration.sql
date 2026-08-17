-- Companion fix to 20260817120000_nifty_scorecard_ind13_field_and_net_backfill.
--
-- That migration corrected net_score (= domestic_score + external_score) but
-- did not touch band / rating_label, which are a pure function of net_score
-- (scorecard-assembly.service.ts findBand()) and were therefore left stale —
-- 38/100 rows ended up with a band that no longer matches their corrected
-- net_score (e.g. net_score 2 -> 3 crossed Bearish -> Caution; 6 -> 7 crossed
-- Neutral -> Bullish; 9 -> 10 crossed Bullish -> Strong Bullish; -1 -> 0
-- crossed Strong Bearish -> Bearish).
--
-- Per instruction: "Anchor re-selection and band reclassification on
-- historical rows are the correct outcome" — this migration performs that
-- reclassification. band and rating_label are always set to the same string
-- in this codebase (persistScorecard: ratingLabel: payload.band), so both
-- columns are recomputed identically here.
--
-- Ranges are the active (v2) scorecard_rating_rule for tool='nifty' as of
-- this migration (SCORECARD_RATING_V2, prisma/seed-rules-v2.ts:222-236),
-- inclusive on both ends, matching findBand()'s `netScore >= min && <= max`:
--   Strong Bullish  [10, 17]
--   Bullish         [ 7,  9]
--   Neutral         [ 4,  6]
--   Caution         [ 3,  3]
--   Bearish         [ 0,  2]
--   Strong Bearish  [-17, -1]
--
-- Deliberately NOT touched here: score_velocity_1d, score_velocity_5d,
-- peak_score_ceiling_state. Unlike band, those are sequential/stateful
-- (each day's value depends on the prior day's persisted state), so
-- retroactively recomputing them would mean replaying the entire scorecard
-- history day-by-day — a materially larger, unrequested change. They will
-- self-correct going forward: every new scorecard assembly reads net_score
-- fresh from history (now corrected by this + the companion migration) when
-- selecting velocity anchors and peak-ceiling state.
UPDATE "nifty_scorecards"
SET
  "band" = CASE
    WHEN "net_score" >= 10 THEN 'Strong Bullish'
    WHEN "net_score" >= 7  THEN 'Bullish'
    WHEN "net_score" >= 4  THEN 'Neutral'
    WHEN "net_score" = 3   THEN 'Caution'
    WHEN "net_score" >= 0  THEN 'Bearish'
    ELSE 'Strong Bearish'
  END,
  "rating_label" = CASE
    WHEN "net_score" >= 10 THEN 'Strong Bullish'
    WHEN "net_score" >= 7  THEN 'Bullish'
    WHEN "net_score" >= 4  THEN 'Neutral'
    WHEN "net_score" = 3   THEN 'Caution'
    WHEN "net_score" >= 0  THEN 'Bearish'
    ELSE 'Strong Bearish'
  END;
