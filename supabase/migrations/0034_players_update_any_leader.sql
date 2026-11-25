-- 0034: let every League Leader update the league's players, not only the
-- leader who originally created each row.
--
-- Bug: players_write (0002) was a single `for all` policy whose WITH CHECK
-- required `created_by = auth.uid()::text`. That self-attribution guard is
-- correct for INSERT, but PostgreSQL also evaluates WITH CHECK on UPDATE, so
-- a Manager promoted to League Leader — or any additional League Leader —
-- could not update player rows created by someone else. The failed check
-- raises 42501, which the API surfaces as
-- "Could not update player: permission denied".
--
-- Fix: split the combined policy into per-command policies that mirror the
-- existing fixtures_insert / fixtures_update pattern:
--   INSERT — unchanged: leaders only, and the row must be attributed to the
--            caller (created_by = auth.uid()).
--   UPDATE — any current leader of the player's league. league_id and
--            created_by are absent from the UPDATE column grant (0002), so
--            neither can change through this path and the check always
--            evaluates the player's real league.
--   DELETE — unchanged behaviour: the combined policy's USING clause already
--            applied to DELETE; WITH CHECK is never evaluated for DELETE.
--
-- League isolation is preserved: is_leader(league_id) is evaluated against
-- the row's own league, so a leader of league A still cannot write players
-- in league B, and non-leaders remain excluded by the USING clause. Role
-- changes take effect immediately because is_leader reads the live
-- league_members row on every statement — there is no cached role to expire.

drop policy if exists players_write on public.players;

create policy players_insert on public.players
  for insert to authenticated
  with check (public.is_leader(league_id) and created_by = auth.uid()::text);

create policy players_update on public.players
  for update to authenticated
  using (public.is_leader(league_id))
  with check (public.is_leader(league_id));

create policy players_delete on public.players
  for delete to authenticated
  using (public.is_leader(league_id));
