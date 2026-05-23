-- =========================================================
-- Manual SQL Migration: IIP data source change
-- Apply AFTER prisma migrate creates the cleanup migration.
-- =========================================================
-- FRED's INDPROINDMISMEI series stopped updating in Jan 2023.
-- Moving IIP to manual injection from MOSPI's monthly release.
-- The source_series_id is preserved for historical reference.

UPDATE indicators
SET data_source = 'manual',
    updated_at = NOW()
WHERE code = 'IND_NIFTY_05_IIP';
