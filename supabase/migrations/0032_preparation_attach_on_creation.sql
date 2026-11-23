begin;

-- A saved preparation must become the next fixture's lineup, even when that
-- fixture is created at the moment it starts.
--
-- A manager who edits the lineup for the next match while no fixture is
-- scheduled saves a preparation: one league-level row in
-- fantasy_next_lineup_preparations. It is a valid, fully checked lineup with
-- no fixture to name yet, and the resolver never reads it — correctly: the
-- resolver resolves one fixture, and a league-level row names none.
--
-- The preparation becomes a match-specific draft through
-- ff_attach_prepared_fantasy_lineups, the trigger that runs when a fixture
-- is created. Until now that trigger refused any fixture whose kickoff was
-- not in the future at insert time. A fixture that is created when it starts
-- — the common way to log a match — was therefore promoted by the deadline
-- runner within a minute with the inherited previous lineup, while the
-- preparation the manager had saved for exactly that fixture sat unread.
-- Production showed it plainly: a saved preparation, an empty drafts table,
-- and a fresh fixture whose official lineup equalled the previous match's.
--
-- The fix is at the association point, not in the resolver. The gate is
-- wrong, not the channel: the preparation is the lineup for the next
-- fixture of the league, and the fixture that is created now is that
-- fixture, started or not. So the trigger attaches a preparation to every
-- newly created fixture of the league, with one guard replacing the old
-- one: a backdated fixture — one older than a fixture the league already
-- has — is a record being entered, not the next match, and never consumes a
-- preparation.
--
-- Every property of the old design is kept:
--
--   * A preparation is consumed exactly once, in the same transaction that
--     creates the fixture, and becomes that fixture's ordinary draft before
--     any promotion can run. It can never linger into an unrelated fixture.
--   * The resolver is untouched: frozen history wins, then the match's
--     draft, then the inherited previous official lineup, then the squad.
--   * The league deadline lock serializes the attach with saves and with
--     the deadline runner: ff_match_deadline takes it before this row
--     exists, and ff_save_next_match_lineup and ff_promote_match_lineup take
--     the same lock. A save that races a creation is serialized behind it
--     and is then refused by its own next-match check, so the manager
--     reloads onto a proper match-specific draft.
--   * Lineups that were locked in stay exactly as they are; nothing here
--     writes history.

create or replace function public.ff_attach_prepared_fantasy_lineups() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  -- ff_match_deadline already holds the same league advisory lock as saves.
  -- The fixture being created is the fixture the preparations were waiting
  -- for whenever nothing newer exists — whether or not its kickoff is still
  -- in the future. A fixture that is created when it starts is locked in by
  -- the deadline runner within a minute; attaching its preparations is the
  -- only way the managers' saved lineups reach it. A backdated fixture, one
  -- older than a fixture the league already has, is a record being entered
  -- and never consumes a preparation.
  if new.status <> 'approved'
    and new.kick_off >= (select enabled_at from public.fantasy_lineup_rollout)
    and not exists (select 1 from public.real_matches o
      where o.league_id=new.league_id and o.id<>new.id and o.kick_off>new.kick_off) then
    with prepared as (
      delete from public.fantasy_next_lineup_preparations p where p.league_id=new.league_id
      returning p.profile_id,p.lineup,p.updated_at
    )
    insert into public.fantasy_match_lineup_drafts(match_id,profile_id,lineup,updated_at)
      select new.id,profile_id,lineup,updated_at from prepared;
  end if;
  return new;
end $$;
revoke all on function public.ff_attach_prepared_fantasy_lineups() from public,anon,authenticated;

-- The trigger itself already exists from migration 0022 and keeps pointing
-- at this function, so replacing the body is the whole change.
--
-- PostgREST caches the database schema. The function signature is
-- unchanged, so nothing is reloaded for it; nothing new is exposed either.

commit;
