-- =============================================================================
-- Lucid recovery — Stage 0.4: clean rebuild of the public schema.
--
-- DESTRUCTIVE. Approved by the user 2026-09-13 (decision D1), after:
--   * recovery/scripts/00-assess.ts           — state recorded
--   * recovery/scripts/00b-forensics.ts       — writer identified (Railway),
--                                               stopped by the user
--   * recovery/scripts/00c-predrop-capture.ts — SAFE: outside public, CASCADE
--       reaches only the auth.users triggers on_auth_user_created and
--       on_auth_user_email_changed, which 01-post-push.sql recreates
--   * recovery/scripts/00d-catalog-and-grants.ts — catalog + grants captured
--
-- Touches only schema public. auth (users) and storage (screenshots) are not
-- dropped. Nothing of value is in public: every row there was regenerated
-- after the 2026-09-11 reset (80 calendar_events, 10 data_fetch_log, 3 models,
-- 13 pairs, 1 users row, 1 indicator). The journal lives in recovery/dumps/.
--
-- Grants: none. The recreated schema matches the post-reset posture captured in
-- recovery/snapshots/replay37-catalog.json — owned by postgres, no privileges
-- for anon, authenticated or service_role, no default privileges. 02-grants.sql
-- records that intent after the tables exist.
-- =============================================================================

BEGIN;

-- Fail fast instead of queueing behind a lock held by anything still connected.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DROP SCHEMA public CASCADE;
CREATE SCHEMA public AUTHORIZATION postgres;

COMMIT;
