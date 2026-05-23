-- EdgeFinder Phase 3B-1.5 — Migrate JBlanked indicators to Forex Factory.
--
-- Run this BEFORE applying the schema migration that drops the `jblanked` enum
-- value. Otherwise the migration will fail with rows still referencing the
-- old enum value.
--
-- Expected affected rows: 42 indicators (those flipped to JBlanked in
-- Phase 3B-1). No data_points rows should exist with source = 'jblanked'
-- because the only JBlanked fetch attempted in Phase 3B-1 failed with an
-- auth error before any ingest succeeded.

BEGIN;

-- Safety check — should return 0; if not, STOP and investigate orphan data.
DO $$
DECLARE
  orphan_count INT;
BEGIN
  SELECT COUNT(*) INTO orphan_count FROM data_points WHERE source = 'jblanked';
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'Found % data_points rows with source = jblanked. Stop and investigate.', orphan_count;
  END IF;
END$$;

UPDATE indicators SET data_source = 'forex_factory' WHERE data_source = 'jblanked';

COMMIT;
