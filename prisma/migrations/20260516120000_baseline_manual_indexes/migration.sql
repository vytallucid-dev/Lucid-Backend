-- Baseline migration: registers manually-created indexes and triggers
-- so Prisma's drift detection stops flagging them.
-- These objects already exist in the database from prisma/manual-migrations/001_*.sql.
-- We use IF NOT EXISTS so this is safe to apply on any environment.

CREATE INDEX IF NOT EXISTS "assets_tool_scope_idx"
  ON "assets" USING GIN ("tool_scope");