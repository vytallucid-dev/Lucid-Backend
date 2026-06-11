-- Fix: the auth.users -> public.users sync trigger previously read the
-- display name from the 'display_name' metadata key, but this app's signup
-- stores it under 'full_name'. As a result new users were synced with a
-- missing display name. Source it from full_name (with sensible fallbacks),
-- trimmed, and never fall back to the email.

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
