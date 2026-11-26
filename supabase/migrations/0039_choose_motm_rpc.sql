-- The man of the match is written through guarded functions, not direct table
-- writes. Migration 0038 granted only SELECT on match_motm, so a client's
-- INSERT was blocked by row level security (42501 "permission denied"). These
-- security-definer functions own the write: they verify the caller may manage
-- the match, that the match is approved, and that the player took part.

create or replace function public.choose_motm(p_match text, p_player text)
returns public.match_motm
language plpgsql
security definer
set search_path = pg_catalog, public as $$
declare
  v_match public.real_matches%rowtype;
  v_row public.match_motm%rowtype;
begin
  if auth.uid() is null then raise insufficient_privilege; end if;
  select * into v_match from public.real_matches where id = p_match for update;
  if not found then
    raise exception 'Match not found' using errcode = 'P0002';
  end if;
  if not (public.is_leader(v_match.league_id) or public.is_match_organizer(p_match)) then
    raise insufficient_privilege;
  end if;
  if v_match.status <> 'approved' then
    raise exception 'The man of the match can be chosen once the match is approved' using errcode = '22023';
  end if;
  if not exists (select 1 from public.match_scoring_lineups l where l.match_id = p_match and l.player_id = p_player) then
    raise exception 'Choose a player who took part in this match' using errcode = '22023';
  end if;

  insert into public.match_motm (id, league_id, match_id, player_id, chosen_by, created_at, updated_at)
  values (gen_random_uuid()::text, v_match.league_id, p_match, p_player, auth.uid()::text, now(), now())
  on conflict (match_id) do update
    set player_id = excluded.player_id, chosen_by = excluded.chosen_by, updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.choose_motm(text, text) from public, anon;
grant execute on function public.choose_motm(text, text) to authenticated;
--> statement-breakpoint

-- Link or clear the photo on the chosen record. The bytes live in the private
-- motm-images bucket; this only stores the managed path.
create or replace function public.set_motm_photo(p_match text, p_photo text)
returns public.match_motm
language plpgsql
security definer
set search_path = pg_catalog, public as $$
declare
  v_match public.real_matches%rowtype;
  v_row public.match_motm%rowtype;
begin
  if auth.uid() is null then raise insufficient_privilege; end if;
  select * into v_match from public.real_matches where id = p_match for update;
  if not found then
    raise exception 'Match not found' using errcode = 'P0002';
  end if;
  if not (public.is_leader(v_match.league_id) or public.is_match_organizer(p_match)) then
    raise insufficient_privilege;
  end if;
  update public.match_motm
    set photo_url = p_photo, updated_at = now()
    where match_id = p_match
  returning * into v_row;
  if not found then
    raise exception 'Choose the man of the match before adding a photo' using errcode = '22023';
  end if;
  return v_row;
end;
$$;
revoke all on function public.set_motm_photo(text, text) from public, anon;
grant execute on function public.set_motm_photo(text, text) to authenticated;
