-- =========================================================
-- Manual SQL Migration: Partial Indexes + Auth Sync
-- Apply AFTER `prisma migrate dev --name init` succeeds.
-- =========================================================

-- Partial index: hot-path "current data points" lookup
CREATE INDEX IF NOT EXISTS idx_data_points_current
  ON data_points (indicator_id, observation_date DESC)
  WHERE is_current = true;

-- Partial index: stale scorecards (recompute queue)
CREATE INDEX IF NOT EXISTS idx_nifty_scorecards_stale
  ON nifty_scorecards (observation_date)
  WHERE is_stale = true;

CREATE INDEX IF NOT EXISTS idx_edgefinder_scorecards_stale
  ON edgefinder_scorecards (asset_id, observation_date)
  WHERE is_stale = true;

-- Partial index: currently-active scoring rules
CREATE INDEX IF NOT EXISTS idx_scoring_rules_current
  ON scoring_rules (indicator_id)
  WHERE effective_to IS NULL;

-- GIN index on tool_scope array for cross-tool asset queries
CREATE INDEX IF NOT EXISTS idx_assets_tool_scope_gin
  ON assets USING GIN (tool_scope);

-- =========================================================
-- Supabase Auth Sync: keep public.users in sync with auth.users
-- =========================================================
-- This trigger inserts/updates a row in public.users whenever
-- a user is created or updated in auth.users.

CREATE OR REPLACE FUNCTION public.handle_auth_user_sync()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    INSERT INTO public.users (id, email, display_name, role, created_at, updated_at)
    VALUES (
      NEW.id,
      NEW.email,
      COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email),
      'user',
      NOW(),
      NOW()
    )
    ON CONFLICT (id) DO NOTHING;
  ELSIF (TG_OP = 'UPDATE') THEN
    UPDATE public.users
    SET
      email = NEW.email,
      updated_at = NOW()
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_changed ON auth.users;
CREATE TRIGGER on_auth_user_changed
  AFTER INSERT OR UPDATE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_auth_user_sync();
