-- B4: enforce at most one is_current = true row per (indicator_id,
-- observation_date) at the database level. Application-level upsert logic
-- (data-points.repository.ts) is correct for sequential runs but not safe
-- under concurrency — Postgres's default Read Committed isolation does not
-- serialize a "read current row, then write" pattern across two overlapping
-- transactions, which is almost certainly how IND_NIFTY_13_FII_LS_RATIO
-- ended up with two is_current=true rows on 2026-07-16 (vintages 1.3s
-- apart). See chat report for the concurrency analysis.
--
-- Step 1: demote the existing duplicate before adding the constraint (a
-- constraint cannot be created while it's already violated). Not a delete —
-- the older-vintage row is kept, only is_current flips to false, identical
-- in shape to what a normal revision write already does. Exactly 1 pair
-- affected (verified by dry-run SELECT before this migration ran — see
-- chat report): IND_NIFTY_13_FII_LS_RATIO / 2026-07-16, both rows value
-- 8.452601 (values already agreed), vintages 14:00:03.466 vs 14:00:04.762 —
-- the earlier vintage is demoted, the later one stays current.
UPDATE "data_points" dp
SET "is_current" = false
WHERE dp."is_current" = true
  AND dp."vintage_date" < (
    SELECT MAX(dp2."vintage_date")
    FROM "data_points" dp2
    WHERE dp2."indicator_id" = dp."indicator_id"
      AND dp2."observation_date" = dp."observation_date"
      AND COALESCE(dp2."variant", '') = COALESCE(dp."variant", '')
      AND dp2."is_current" = true
  );

-- Step 2: the partial unique index.
--
-- Deliberately keeps `variant` in the key (as COALESCE(variant, '') — see
-- below), not just (indicator_id, observation_date) as literally asked,
-- because data_points is shared with the EdgeFinder tool, which has a
-- release-ladder concept (IndicatorVariant / Flash-vs-Final) that could
-- legitimately want two different-variant rows both current for the same
-- (indicator, date). Verified before writing this: zero such pairs exist
-- today (checked directly), so this is a forward-looking safety choice, not
-- a response to an observed conflict — flagging the deviation from the
-- literal 2-column ask rather than silently taking the narrower reading.
--
-- COALESCE(variant, '') rather than a plain 3-column UNIQUE INDEX on
-- (indicator_id, observation_date, variant): Postgres treats NULL as
-- distinct from NULL in ordinary unique indexes, so a plain 3-column index
-- would NOT have caught the actual Ind 13 duplicate (both rows had
-- variant = NULL). Wrapping variant in COALESCE to a fixed sentinel value
-- makes the indexed expression non-null, which Postgres unique indexes DO
-- enforce as a real conflict — this is the version that actually closes the
-- race that produced the 2026-07-16 duplicate.
CREATE UNIQUE INDEX "data_points_current_unique"
ON "data_points" ("indicator_id", "observation_date", (COALESCE("variant", '')))
WHERE "is_current" = true;
