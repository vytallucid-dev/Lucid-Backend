-- Supabase Auth -> public.users sync triggers
--
-- When Supabase Auth creates a user (auth.users), mirror that into public.users
-- so application code can join against a stable, app-owned user table.
--
-- security definer: function runs as the function owner (usually postgres),
-- bypassing RLS on public.users so the trigger can write regardless of who
-- issued the INSERT to auth.users.

-- ---------------------------------------------------------------------------
-- 1. Insert public.users row when a new auth.users row is created
-- ---------------------------------------------------------------------------
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
    coalesce(new.raw_user_meta_data->>'display_name', null),
    'user',
    coalesce(new.created_at, now()),
    now()
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 2. Propagate email changes from auth.users to public.users
-- ---------------------------------------------------------------------------
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

drop trigger if exists on_auth_user_email_changed on auth.users;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.handle_user_email_change();
