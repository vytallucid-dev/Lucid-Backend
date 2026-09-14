-- =============================================================================
-- Lucid recovery — Stage 1.2 step 3: grant posture for public.
--
-- Run AFTER `prisma db push` and 01-post-push.sql. Idempotent.
--
-- Posture: owner-only. Nothing in Lucid reaches public through Supabase's REST
-- or GraphQL APIs (verified 2026-09-13):
--   * backend  — Prisma as postgres; no @supabase/supabase-js import anywhere
--   * frontend — Supabase used for auth and storage only
-- No table has row-level security, so any privilege granted to anon or
-- authenticated would expose that table to anyone holding the public anon key.
--
-- This matches the post-reset state captured in replay37-catalog.json: table
-- privileges held by postgres only; anon, authenticated and service_role have
-- no USAGE on the schema; no default privileges on public in any form; no
-- event trigger grants on CREATE TABLE. The REVOKEs are no-ops today — they
-- record the intent, and re-running this file undoes any grant added later.
--
-- Function privileges are deliberately left at their defaults so the
-- auth.users sync triggers keep working for sign-ups.
-- =============================================================================

BEGIN;

REVOKE ALL ON SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
