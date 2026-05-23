-- AlterEnum
-- Add forex_factory to DataSource enum.
-- Note: forex_factory was added to the live DB manually via SQL before this
-- migration was generated, to work around the chicken-and-egg problem where
-- we needed to update 42 indicator rows from 'jblanked' to 'forex_factory'
-- before the enum value existed. This statement uses IF NOT EXISTS to be
-- idempotent — running it against a DB that already has forex_factory is a no-op.
ALTER TYPE "DataSource" ADD VALUE IF NOT EXISTS 'forex_factory';

-- Note: 'jblanked' enum value is being deprecated but NOT removed in this migration.
-- All 42 indicator rows that referenced 'jblanked' have been migrated to 'forex_factory'
-- via prisma/manual-sql/edgefinder_phase_3b15_indicator_source_update.sql.
-- Removing an enum value in Postgres requires creating a new type, casting columns,
-- dropping the old type, and renaming — a multi-step operation that is risky to
-- automate. The dead value will be cleaned up in a future migration if needed.
