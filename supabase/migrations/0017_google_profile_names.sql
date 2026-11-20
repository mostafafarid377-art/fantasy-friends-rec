-- Initialize Google names only on profile creation; profile edits survive all future logins.
begin;
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
  if new.raw_app_meta_data->>'provider' = 'google' then
    v_display_name := coalesce(
      case when jsonb_typeof(new.raw_user_meta_data->'full_name')='string' then nullif(regexp_replace(new.raw_user_meta_data->>'full_name','^[[:space:]]+|[[:space:]]+$','','g'),'') end,
      case when jsonb_typeof(new.raw_user_meta_data->'name')='string' then nullif(regexp_replace(new.raw_user_meta_data->>'name','^[[:space:]]+|[[:space:]]+$','','g'),'') end,
      v_display_name);
    v_display_name := left(v_display_name,80);
  end if;
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

commit;
