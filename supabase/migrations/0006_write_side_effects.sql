-- Side effects run only from authorized writes and commit with the record.
-- No authenticated role receives a direct notification, activity, or audit grant.
begin;

create function public.ff_fixture_or_approval_notice() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  l text;
  actor text;
  label text;
  notice_type text;
  heading text;
  description text;
  target_link text;
  target_profile text;
  action_name text;
  review_only boolean := false;
  include_actor boolean := false;
begin
  if tg_table_name = 'fantasy_fixtures' then
    l := new.league_id; actor := new.created_by; label := new.title;
    action_name := 'fixture.created'; notice_type := 'fixture_created'; heading := 'New fixture';
    description := label; target_link := '/fixtures';
  else
    select league_id,title,organizer_id into strict l,label,target_profile from real_matches where id=new.match_id;
    actor := new.actor_id;
    target_link := '/matches/' || new.match_id;
    action_name := 'match.' || new.action;
    case new.action
      when 'submitted' then
        notice_type := 'match_submitted'; heading := 'Match submitted for review'; description := label;
        review_only := true; target_profile := null;
      when 'approved' then
        notice_type := 'match_approved'; heading := 'Match approved — standings updated';
        description := label || ' is now an official result.'; include_actor := true; target_profile := null;
      when 'rejected' then
        notice_type := 'match_rejected'; heading := 'Match returned to organizer';
        description := coalesce(new.reason, label); include_actor := true;
      else return new;
    end case;
  end if;
  insert into league_activity(id,league_id,profile_id,action,summary)
    values(gen_random_uuid()::text,l,actor,action_name,heading || ': ' || label);
  insert into notifications(id,profile_id,league_id,type,title,body,link)
    select gen_random_uuid()::text,profile_id,l,notice_type,heading,description,target_link
      from league_members where league_id=l and (include_actor or profile_id is distinct from actor)
      and (not review_only or role in ('leader','organizer')) and (target_profile is null or profile_id=target_profile);
  return new;
end;
$$;
revoke all on function public.ff_fixture_or_approval_notice() from public, anon, authenticated;
create trigger ff_fixture_created after insert on public.fantasy_fixtures
  for each row execute function public.ff_fixture_or_approval_notice();
create trigger ff_match_decision_recorded after insert on public.match_approvals
  for each row execute function public.ff_fixture_or_approval_notice();

create function public.ff_roster_activity() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  actor text := auth.uid()::text;
  activity text;
  label text;
begin
  if actor is null then return new; end if;
  if tg_table_name = 'teams' then
    activity := 'team.created'; label := new.name;
  else
    label := new.full_name;
    if tg_op = 'INSERT' then activity := 'player.created';
    elsif old.status is distinct from new.status and new.status = 'archived' then activity := 'player.archived';
    else activity := 'player.updated'; end if;
  end if;
  insert into league_activity(id,league_id,profile_id,action,summary,meta)
    values(gen_random_uuid()::text,new.league_id,actor,activity,label,jsonb_build_object('id',new.id));
  return new;
end;
$$;
revoke all on function public.ff_roster_activity() from public, anon, authenticated;
create trigger ff_player_written after insert or update on public.players
  for each row execute function public.ff_roster_activity();
create trigger ff_team_created after insert on public.teams
  for each row execute function public.ff_roster_activity();

create function public.ff_validate_roster_scope() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if tg_table_name='players' then
    if new.team_id is not null and not exists (select 1 from teams where id=new.team_id and league_id=new.league_id) then
      raise exception 'That team does not exist in this league' using errcode = '22023';
    end if;
  else
    perform pg_advisory_xact_lock(hashtextextended('team-name:' || new.league_id || ':' || lower(new.name), 0));
    if exists (select 1 from teams where league_id=new.league_id and lower(name)=lower(new.name) and id<>new.id) then
      raise unique_violation using message = 'A team with that name already exists in this league';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.ff_validate_roster_scope() from public, anon, authenticated;
create trigger ff_validate_player_team before insert or update of team_id on public.players
  for each row execute function public.ff_validate_roster_scope();
create trigger ff_validate_team_name before insert or update of name on public.teams
  for each row execute function public.ff_validate_roster_scope();

create function public.ff_unlink_deleted_match() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update fantasy_fixtures set real_match_id=null, updated_at=now()
    where real_match_id=old.id and league_id=old.league_id;
  return old;
end;
$$;
revoke all on function public.ff_unlink_deleted_match() from public, anon, authenticated;
create trigger ff_unlink_deleted_match after delete on public.real_matches
  for each row execute function public.ff_unlink_deleted_match();
create function public.ff_record_change() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  actor text := auth.uid()::text;
  l text;
  action_name text;
  label text;
  note_type text;
  note_title text;
  recipient text;
  link text := '/leagues';
begin
  if actor is null then return null; end if;
  case tg_table_name
    when 'profiles' then
      if new.id=actor and (old.username,old.display_name,old.avatar_url,old.bio) is distinct from
          (new.username,new.display_name,new.avatar_url,new.bio) then
        insert into audit_logs(id,actor_id,action,entity,entity_id)
          values(gen_random_uuid()::text,actor,'profile.updated','profile',new.id);
      end if;
      return null;
    when 'leagues' then
      if (old.name,old.description,old.subs_count,old.vice_policy) is not distinct from
          (new.name,new.description,new.subs_count,new.vice_policy) then return null; end if;
      l := new.id;
      action_name := 'league.settings'; label := 'League settings updated';
      note_type := 'settings_updated'; note_title := label; link := '/settings';
    when 'league_members' then
      l := old.league_id;
      if tg_op='DELETE' then
        if not exists (select 1 from leagues where id=l) then return null; end if;
        delete from league_standings where league_id=l and profile_id=old.profile_id;
        if actor=old.profile_id then action_name := 'member.left'; label := 'A manager left the league';
        else
          action_name := 'member.removed'; label := 'A manager was removed';
          -- The removed account is intentionally notified after it loses access.
          insert into notifications(id,profile_id,league_id,type,title,body,link)
            values(gen_random_uuid()::text,old.profile_id,l,'member_removed','Removed from league',label,link);
        end if;
      elsif old.role is distinct from new.role then
        action_name := 'member.role'; label := 'Role updated to ' || new.role;
        recipient := new.profile_id; note_type := 'role_changed'; note_title := 'Your league role changed';
      else return null;
      end if;
    when 'fantasy_fixtures' then
      if tg_op='DELETE' then l := old.league_id; action_name := 'fixture.deleted'; label := old.title;
      else
        if (old.title,old.gameweek,old.scheduled_at,old.status,old.notes) is not distinct from
          (new.title,new.gameweek,new.scheduled_at,new.status,new.notes) then return null; end if;
        l := new.league_id; action_name := 'fixture.updated'; label := new.title;
      end if;
    when 'match_events' then
      if tg_op='DELETE' then l := old.league_id; action_name := 'match.event.deleted'; label := 'Event removed';
      elsif tg_op='UPDATE' then l := new.league_id; action_name := 'match.event.updated'; label := 'Event corrected';
      else l := new.league_id; action_name := 'match.event.' || new.event_type; label := 'Event recorded'; end if;
      if not exists (select 1 from real_matches where id=coalesce(new.match_id,old.match_id) and league_id=l) then return null; end if;
    when 'match_substitutions' then
      l := new.league_id; action_name := 'match.substitution'; label := 'Substitution recorded';
      if not exists (select 1 from real_matches where id=new.match_id and league_id=l) then return null; end if;
    else return null;
  end case;
  if not exists (select 1 from leagues where id=l) then return null; end if;
  insert into league_activity(id,league_id,profile_id,action,summary)
    values(gen_random_uuid()::text,l,actor,action_name,label);
  if note_type is not null then
    insert into notifications(id,profile_id,league_id,type,title,body,link)
      select gen_random_uuid()::text,profile_id,l,note_type,note_title,label,link
      from league_members where league_id=l and (recipient is null or profile_id=recipient);
  end if;
  return null;
end;
$$;
revoke all on function public.ff_record_change() from public, anon, authenticated;
create trigger ff_profile_changed after update of username,display_name,avatar_url,bio on public.profiles
  for each row execute function public.ff_record_change();
create trigger ff_league_changed after update on public.leagues
  for each row execute function public.ff_record_change();
create trigger ff_member_changed after update of role on public.league_members
  for each row execute function public.ff_record_change();
create trigger ff_member_removed after delete on public.league_members
  for each row execute function public.ff_record_change();
create trigger ff_fixture_changed after update or delete on public.fantasy_fixtures
  for each row execute function public.ff_record_change();
create trigger ff_event_changed after insert or update or delete on public.match_events
  for each row execute function public.ff_record_change();
create trigger ff_sub_recorded after insert on public.match_substitutions
  for each row execute function public.ff_record_change();

create function public.ff_keep_league_leader() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if old.role='leader' and (tg_op='DELETE' or new.role<>'leader') and exists
      (select 1 from leagues where id=old.league_id) then
    perform pg_advisory_xact_lock(hashtextextended('league-leader:' || old.league_id, 0));
    if not exists (select 1 from league_members where league_id=old.league_id and role='leader' and id<>old.id) then
      raise exception 'A league must keep at least one League Leader';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.ff_keep_league_leader() from public, anon, authenticated;
create trigger ff_keep_leader_on_delete before delete on public.league_members
  for each row execute function public.ff_keep_league_leader();
create trigger ff_keep_leader_on_role_change before update of role on public.league_members
  for each row execute function public.ff_keep_league_leader();

create function public.ff_scoring_rules_changed() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  actor text := auth.uid()::text;
  l text;
  approved boolean;
begin
  if actor is null then return null; end if;
  for l in select distinct n.league_id from new_rules n join old_rules o using (id)
      where (n.status,n.points) is distinct from (o.status,o.points) loop
    select bool_and(status='approved') into approved from scoring_rules where league_id=l;
    insert into league_activity(id,league_id,profile_id,action,summary)
      values(gen_random_uuid()::text,l,actor,case when approved then 'rules.approved' else 'rules.updated' end,
        case when approved then 'Scoring rules approved' else 'Scoring rules updated (draft)' end);
    if approved then
      insert into notifications(id,profile_id,league_id,type,title,body,link)
        select gen_random_uuid()::text,profile_id,l,'rules_approved','Scoring rules approved',
          'Official fantasy scoring is now active for this league.','/rules'
        from league_members where league_id=l and profile_id<>actor;
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function public.ff_scoring_rules_changed() from public, anon, authenticated;
create trigger ff_scoring_rules_changed after update on public.scoring_rules
  referencing old table as old_rules new table as new_rules
  for each statement execute function public.ff_scoring_rules_changed();
commit;
