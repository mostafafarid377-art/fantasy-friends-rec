-- Fantasy Friends native Supabase Auth foundation.
-- Fresh-project migration: creates profile rows for Auth users; it imports no
-- legacy users and does not delete or reset any existing application records.
-- Existing application profile IDs are text, so the Auth UUID is stored as
-- auth.users.id::text to preserve compatibility with current FK columns.

alter table public.profiles
  alter column password_hash drop not null;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_username text;
  v_display_name text;
begin
  v_username := nullif(trim(new.raw_user_meta_data ->> 'username'), '');
  if v_username is null then
    v_username := 'user_' || substr(replace(new.id::text, '-', ''), 1, 10);
  end if;

  v_display_name := nullif(trim(new.raw_user_meta_data ->> 'display_name'), '');
  if v_display_name is null then
    v_display_name := v_username;
  end if;

  insert into public.profiles (
    id, email, email_lower, password_hash, username, display_name,
    email_verified_at, created_at, updated_at
  )
  values (
    new.id::text, coalesce(new.email, ''), lower(coalesce(new.email, '')),
    '', v_username, v_display_name,
    case when new.email_confirmed_at is not null then now() else null end,
    now(), now()
  )
  on conflict (id) do update set
    email = excluded.email,
    email_lower = excluded.email_lower,
    email_verified_at = excluded.email_verified_at,
    updated_at = now();

  return new;
end;
$$;
revoke all on function public.handle_new_auth_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_ff on auth.users;
create trigger on_auth_user_created_ff
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create or replace function public.sync_auth_user_profile()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.profiles
     set email = coalesce(new.email, ''),
         email_lower = lower(coalesce(new.email, '')),
         email_verified_at = case
           when new.email_confirmed_at is not null then coalesce(email_verified_at, now())
           else null
         end,
         updated_at = now()
   where id = new.id::text;
  return new;
end;
$$;
revoke all on function public.sync_auth_user_profile() from public, anon, authenticated;

drop trigger if exists on_auth_user_updated_ff on auth.users;
create trigger on_auth_user_updated_ff
  after update of email, email_confirmed_at on auth.users
  for each row execute function public.sync_auth_user_profile();

grant select on public.profiles to authenticated;
-- Client profile edits are column-limited by 0002_rls.sql.
