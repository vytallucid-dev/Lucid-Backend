-- Trade screenshots storage setup.
--
-- Run once in the Supabase SQL editor (Dashboard → SQL). Creates the public
-- bucket the frontend uploads compressed trade/planned screenshots to, plus RLS
-- policies so each authenticated user can only write/delete inside their own
-- "{user_id}/..." folder while anyone can read via the public URL.
--
-- The frontend uploads to:  trade-screenshots/{auth.uid()}/{uuid}.webp
-- (see lucid/src/lib/storage/screenshots.ts).

-- 1) Public bucket --------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('trade-screenshots', 'trade-screenshots', true)
on conflict (id) do update set public = true;

-- 2) Policies -------------------------------------------------------------------
-- Insert: only into your own top-level folder.
drop policy if exists "trade_screenshots_insert_own" on storage.objects;
create policy "trade_screenshots_insert_own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'trade-screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Update: only files in your own folder.
drop policy if exists "trade_screenshots_update_own" on storage.objects;
create policy "trade_screenshots_update_own"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'trade-screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Delete: only files in your own folder.
drop policy if exists "trade_screenshots_delete_own" on storage.objects;
create policy "trade_screenshots_delete_own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'trade-screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Read: public (bucket is public; this also allows listing if ever needed).
drop policy if exists "trade_screenshots_public_read" on storage.objects;
create policy "trade_screenshots_public_read"
  on storage.objects for select to public
  using (bucket_id = 'trade-screenshots');
