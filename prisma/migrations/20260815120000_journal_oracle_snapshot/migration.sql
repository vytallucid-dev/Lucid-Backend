-- Journal Oracle snapshot — entry on the idea, exit on the fill.
--
-- WHY THIS EXISTS
-- ----------------
-- `trades.fundamental_score` held "the Oracle score" for a trade, but it was a
-- LIVE, UNDATED read: the add-trade form fetched whatever the Oracle currently
-- said for that pair at the moment the form happened to be open, and stored the
-- number. Reopening a scored pair a week later and re-saving would have written
-- a different number for the same trade. Nothing recorded which date the number
-- belonged to, so the historical context of a past trade was unanchored.
--
-- This replaces it with a date-addressed snapshot: the score for the pair ON the
-- entry date, captured once at write time and never recomputed. A later revision
-- to the Oracle's own history therefore cannot silently rewrite what a past trade
-- was taken against.
--
-- GRAIN
-- -----
-- Entry lives on `trades` — the entry date is idea-level, one per idea.
-- Exit lives on `executions` — `date_closed` is per-account, and two accounts can
-- genuinely close the same idea on different days, against different scores.
-- Putting the exit snapshot on the idea would have to pick one of them arbitrarily.
--
-- WHAT IS DESTRUCTIVE HERE
-- ------------------------
-- One column is dropped: trades.fundamental_score. Every one of its values is
-- preserved first — step 3 carries it across to oracle_score_at_entry, flagged
-- source='legacy', for every trade whose entry date has no real score row. Only
-- where a REAL dated snapshot exists is the old value superseded (step 2), which
-- is the intent: the snapshot is the same fact, correctly captured.
--
-- Everything else is additive. No existing row's prices, P&L, R or dates are
-- touched. The whole file runs in one transaction.

-- ---------------------------------------------------------------------------
-- 1. New columns.
-- ---------------------------------------------------------------------------
ALTER TABLE "trades"
  ADD COLUMN "oracle_score_at_entry"          SMALLINT,
  ADD COLUMN "oracle_score_entry_date"        DATE,
  ADD COLUMN "oracle_score_entry_captured_at" TIMESTAMP(3),
  ADD COLUMN "oracle_score_entry_source"      VARCHAR(10);

ALTER TABLE "executions"
  ADD COLUMN "oracle_score_at_exit"          SMALLINT,
  ADD COLUMN "oracle_score_exit_date"        DATE,
  ADD COLUMN "oracle_score_exit_captured_at" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- 2. Backfill real, date-addressed entry snapshots.
--
-- Two score homes, joined the same way: assets.code = trades.pair. FX pairs
-- score in edgefinder_pair_scores, everything else (Gold, indices) in
-- edgefinder_scorecards. The public "Gold" key alias is an API-surface concern
-- only — the asset's own code is XAUUSD, which is what trades.pair holds, so no
-- alias mapping is needed here.
--
-- is_current picks the live vintage; DISTINCT ON + vintage_date DESC picks the
-- newest live vintage should more than one exist for a date.
--
-- The entry date is the UTC calendar date of date_opened, matching the UTC
-- convention the trading serializers already use for every date they emit.
-- ---------------------------------------------------------------------------
UPDATE "trades" t
SET oracle_score_at_entry          = s.total_score,
    oracle_score_entry_date        = t.date_opened::date,
    oracle_score_entry_captured_at = NOW(),
    oracle_score_entry_source      = 'snapshot'
FROM (
  SELECT DISTINCT ON (a.code, ps.score_date)
         a.code AS code, ps.score_date AS d, ps.total_score AS total_score
  FROM "edgefinder_pair_scores" ps
  JOIN "assets" a ON a.id = ps.pair_id
  WHERE ps.is_current = true
  ORDER BY a.code, ps.score_date, ps.vintage_date DESC
) s
WHERE s.code = t.pair AND s.d = t.date_opened::date;

UPDATE "trades" t
SET oracle_score_at_entry          = s.total_score,
    oracle_score_entry_date        = t.date_opened::date,
    oracle_score_entry_captured_at = NOW(),
    oracle_score_entry_source      = 'snapshot'
FROM (
  SELECT DISTINCT ON (a.code, sc.observation_date)
         a.code AS code, sc.observation_date AS d, sc.total_score AS total_score
  FROM "edgefinder_scorecards" sc
  JOIN "assets" a ON a.id = sc.asset_id
  WHERE sc.is_current = true
  ORDER BY a.code, sc.observation_date, sc.vintage_date DESC
) s
WHERE s.code = t.pair AND s.d = t.date_opened::date
  AND t.oracle_score_at_entry IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Carry the remaining fundamental_score values across as legacy.
--
-- These trades predate the Oracle's scoring history, so no dated snapshot can
-- ever exist for them. The stored number was reviewed or overridden by hand at
-- the time and is the only Oracle context those trades will ever have — it is
-- kept, not nulled. oracle_score_entry_date stays NULL: a legacy value is
-- addressed to no date, and claiming one would fabricate provenance.
-- ---------------------------------------------------------------------------
UPDATE "trades"
SET oracle_score_at_entry          = fundamental_score,
    oracle_score_entry_captured_at = NOW(),
    oracle_score_entry_source      = 'legacy'
WHERE oracle_score_at_entry IS NULL
  AND fundamental_score IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Backfill exit snapshots for already-closed executions.
--    Open executions (date_closed IS NULL) stay null on all three columns.
-- ---------------------------------------------------------------------------
UPDATE "executions" e
SET oracle_score_at_exit          = s.total_score,
    oracle_score_exit_date        = e.date_closed::date,
    oracle_score_exit_captured_at = NOW()
FROM "trades" t,
     (
       SELECT DISTINCT ON (a.code, ps.score_date)
              a.code AS code, ps.score_date AS d, ps.total_score AS total_score
       FROM "edgefinder_pair_scores" ps
       JOIN "assets" a ON a.id = ps.pair_id
       WHERE ps.is_current = true
       ORDER BY a.code, ps.score_date, ps.vintage_date DESC
     ) s
WHERE e.trade_id = t.id
  AND e.date_closed IS NOT NULL
  AND s.code = t.pair
  AND s.d = e.date_closed::date;

UPDATE "executions" e
SET oracle_score_at_exit          = s.total_score,
    oracle_score_exit_date        = e.date_closed::date,
    oracle_score_exit_captured_at = NOW()
FROM "trades" t,
     (
       SELECT DISTINCT ON (a.code, sc.observation_date)
              a.code AS code, sc.observation_date AS d, sc.total_score AS total_score
       FROM "edgefinder_scorecards" sc
       JOIN "assets" a ON a.id = sc.asset_id
       WHERE sc.is_current = true
       ORDER BY a.code, sc.observation_date, sc.vintage_date DESC
     ) s
WHERE e.trade_id = t.id
  AND e.date_closed IS NOT NULL
  AND e.oracle_score_at_exit IS NULL
  AND s.code = t.pair
  AND s.d = e.date_closed::date;

-- ---------------------------------------------------------------------------
-- 5. Retire the live, undated column. Its values now live in
--    oracle_score_at_entry with explicit provenance.
-- ---------------------------------------------------------------------------
ALTER TABLE "trades" DROP COLUMN "fundamental_score";

-- ---------------------------------------------------------------------------
-- 6. Provenance is a closed set — reject anything else at the DB boundary.
-- ---------------------------------------------------------------------------
ALTER TABLE "trades"
  ADD CONSTRAINT "trades_oracle_score_entry_source_check"
  CHECK ("oracle_score_entry_source" IS NULL
      OR "oracle_score_entry_source" IN ('snapshot', 'legacy', 'manual'));
