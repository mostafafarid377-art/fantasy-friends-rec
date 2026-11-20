-- Reuse Hagz-fantasy's private bucket. Create it only on fresh installations.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('player-images', 'player-images', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

do $$ begin
  if exists (select 1 from storage.buckets where id = 'player-images' and public) then
    raise exception 'The player-images bucket must be private';
  end if;
end $$;

-- Object keys: <league_id>/<player_id>/<random uuid>.jpg. A member only sees
-- the linked photo; the league leader can verify and clean up unlinked uploads.
create policy ff_player_photo_read on storage.objects for select to authenticated
using (bucket_id = 'player-images' and exists (
  select 1 from public.players p
  where p.league_id = split_part(name, '/', 1) and p.id = split_part(name, '/', 2)
    and (public.is_leader(p.league_id) or
      (public.is_member(p.league_id) and p.photo_url = 'player-images/' || name))
));

create policy ff_player_photo_insert on storage.objects for insert to authenticated
with check (bucket_id = 'player-images'
  and name ~ '^[^/]+/[^/]+/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.jpg$'
  and exists (
    select 1 from public.players p where p.league_id = split_part(name, '/', 1)
      and p.id = split_part(name, '/', 2) and public.is_leader(p.league_id)
      and p.created_by = auth.uid()::text
  ));

-- Uploads are immutable (no UPDATE policy). Detach before removing a blob.
create policy ff_player_photo_delete on storage.objects for delete to authenticated
using (bucket_id = 'player-images' and exists (
  select 1 from public.players p where p.league_id = split_part(name, '/', 1)
    and p.id = split_part(name, '/', 2) and public.is_leader(p.league_id)
    and p.photo_url is distinct from 'player-images/' || name
));

-- The existing photo_url field still supports legacy external links. A managed
-- path must reference an existing object under this exact player's namespace.
create function public.ff_validate_player_photo() returns trigger language plpgsql
security definer set search_path = pg_catalog, public as $$
declare object_key text;
begin
  if new.photo_url is null or left(new.photo_url, 14) <> 'player-images/' then return new; end if;
  if tg_op = 'UPDATE' and new.photo_url is not distinct from old.photo_url
    and new.id = old.id and new.league_id = old.league_id then return new; end if;
  object_key := substr(new.photo_url, 15);
  if object_key !~ '^[^/]+/[^/]+/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.jpg$'
     or split_part(object_key, '/', 1) <> new.league_id or split_part(object_key, '/', 2) <> new.id
     or not exists (select 1 from storage.objects o where o.bucket_id = 'player-images' and o.name = object_key) then
    raise exception 'Photo must exist in this player''s league storage folder' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function public.ff_validate_player_photo() from public, anon, authenticated;
create trigger ff_player_photo_scope before insert or update of photo_url, id, league_id on public.players
for each row execute function public.ff_validate_player_photo();
