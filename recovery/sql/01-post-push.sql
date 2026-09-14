-- =============================================================================
-- Lucid recovery — Stage 1.2 step 2: objects `prisma db push` cannot build.
--
-- Run ONCE, immediately AFTER `prisma db push` has created the tables, and
-- never before it. Idempotent: safe to re-run. One transaction: all or nothing.
--
-- Provenance: swept across all 48 migrations and both hand-applied SQL
-- directories (prisma/manual-migrations, prisma/manual-sql) on 2026-09-13.
-- Everything else is declared in schema.prisma — including the GIN index on
-- assets.tool_scope and the four hot-path indexes from
-- 20260610120000_perf_hot_path_indexes.
--
-- Deliberately EXCLUDED:
--   * manual-migrations/001 — public.handle_auth_user_sync() and trigger
--     on_auth_user_changed. It falls back to the email as display name, the
--     exact behaviour 20260612120000 fixed. Same-event triggers fire in name
--     order, so on_auth_user_changed would run before on_auth_user_created,
--     insert first, and the fixed trigger's ON CONFLICT DO NOTHING would skip —
--     silently reintroducing the bug.
--   * manual-migrations/001 — idx_assets_tool_scope_gin, a duplicate of
--     assets_tool_scope_idx, which schema.prisma declares.
-- =============================================================================

BEGIN;

-- ── 1. auth.users → public.users sync ────────────────────────────────────────

-- Final body, from 20260612120000_fix_user_display_name_trigger.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  insert into public.users (id, email, display_name, role, created_at, updated_at)
  values (
    new.id,
    new.email,
    nullif(
      trim(
        coalesce(
          new.raw_user_meta_data->>'full_name',
          new.raw_user_meta_data->>'name',
          new.raw_user_meta_data->>'display_name',
          ''
        )
      ),
      ''
    ),
    'user',
    coalesce(new.created_at, now()),
    now()
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- From 20260520120000_supabase_auth_user_sync_trigger.
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  update public.users
  set email = new.email,
      updated_at = now()
  where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.handle_user_email_change();

-- ── 2. Partial unique indexes (migration SQL only) ───────────────────────────

-- 20260804120000_multi_account_trade_logging: at most one primary execution per trade.
CREATE UNIQUE INDEX IF NOT EXISTS "executions_one_primary_per_trade"
  ON "executions" ("trade_id") WHERE "is_primary" = true;

-- 20260807143518_add_calendar_event_deferrals
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_event_deferrals_standing_unique"
  ON "calendar_event_deferrals" ("indicator_id", "variant") WHERE "calendar_event_id" IS NULL;

-- 20260817180000_data_points_current_unique_partial_index
CREATE UNIQUE INDEX IF NOT EXISTS "data_points_current_unique"
  ON "data_points" ("indicator_id", "observation_date", (COALESCE("variant", '')))
  WHERE "is_current" = true;

-- ── 3. CHECK constraints (migration SQL only) ────────────────────────────────

-- 20260731120000_edgefinder_phase1_normalise_pair_template_and_asset_indicator_map
ALTER TABLE "asset_indicator_map" DROP CONSTRAINT IF EXISTS "asset_indicator_map_polarity_sign_check";
ALTER TABLE "asset_indicator_map"
  ADD CONSTRAINT "asset_indicator_map_polarity_sign_check" CHECK ("polarity" IN (-1, 1));

-- 20260815120000_journal_oracle_snapshot
ALTER TABLE "trades" DROP CONSTRAINT IF EXISTS "trades_oracle_score_entry_source_check";
ALTER TABLE "trades"
  ADD CONSTRAINT "trades_oracle_score_entry_source_check"
  CHECK ("oracle_score_entry_source" IS NULL
      OR "oracle_score_entry_source" IN ('snapshot', 'legacy', 'manual'));

-- ── 4. Partial performance indexes (manual-migrations/001, never in history) ─

CREATE INDEX IF NOT EXISTS idx_data_points_current
  ON data_points (indicator_id, observation_date DESC) WHERE is_current = true;

CREATE INDEX IF NOT EXISTS idx_nifty_scorecards_stale
  ON nifty_scorecards (observation_date) WHERE is_stale = true;

CREATE INDEX IF NOT EXISTS idx_edgefinder_scorecards_stale
  ON edgefinder_scorecards (asset_id, observation_date) WHERE is_stale = true;

CREATE INDEX IF NOT EXISTS idx_scoring_rules_current
  ON scoring_rules (indicator_id) WHERE effective_to IS NULL;

COMMIT;
