/**
 * Checks that migration 0028 still carries the bodies it was built from.
 *
 * Four functions in 0028 are copies of long, stable bodies that already live
 * in earlier migrations: the official scorer, the shared live projection and
 * the two save functions. Copying them by hand invites drift, so they are
 * derived here from their original migrations with the smallest possible edit
 * (the fantasy lineup input comes from the shared resolver) and compared with
 * what the migration actually contains.
 *
 * The lineage of every body matters, so it is spelled out here:
 *
 *   ff_save_validated_squad  0009 wrote save_fantasy_squad_v2, 0014 renamed
 *                             it to ff_save_validated_squad, 0028 replaces it
 *                             again. The body 0028 carries is therefore the
 *                             0009 body, not the older 0007 body: the bench
 *                             rule that 0009 added is live today and must not
 *                             be lost by replacing the function.
 *   ff_score_match            0020 wrote it, 0028 replaces it.
 *   ff_live_manager_points_from_live
 *                             0027 wrote it, 0028 replaces it.
 *   ff_save_next_match_lineup 0022 wrote it, 0028 replaces it.
 *
 * This script never writes. It only reports drift, so a hand edit in the
 * migration can never be overwritten by running it.
 *
 * Run: node scripts/check-0028-parity.mjs
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("./supabase/migrations/0028_lineup_lifecycle.sql");

/** Extracts a `create [or replace] function <name>(...) ... $$;` block. */
function extractFunction(source, name) {
  const start = Math.max(
    source.indexOf(`create or replace function public.${name}(`),
    source.indexOf(`create function public.${name}(`),
  );
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = source.indexOf("$$;", start);
  if (end < 0) throw new Error(`function ${name} has no closing $$;`);
  return source.slice(start, end + "$$;".length);
}

const scoring = read("./supabase/migrations/0020_next_match_lineups.sql");
const live = read("./supabase/migrations/0027_shared_live_projection.sql");
const nextMatch = read("./supabase/migrations/0022_prepare_next_match_lineup.sql");
const squad = read("./supabase/migrations/0009_bench_lineups_scoring.sql");
const rename = read("./supabase/migrations/0014_match_deadlines.sql");

/* ------------------------------------------------------------------ */
/* The live lineage of the squad function.                              */
/* ------------------------------------------------------------------ */

// 0014 renamed the function 0009 wrote. 0028 replaces the renamed function,
// so 0028 has to carry the 0009 body and not the older 0007 one.
const renameStatement =
  "alter function public.save_fantasy_squad_v2(text,text,text,text,timestamptz,jsonb) rename to ff_save_validated_squad;";
if (!rename.includes(renameStatement)) {
  throw new Error("migration 0014 no longer renames save_fantasy_squad_v2 to ff_save_validated_squad");
}

// The rule 0009 added: the goalkeeper sits in the first bench seat and the
// outfield substitutes follow in order. It is live today, so a migration that
// replaces the squad function has to keep it.
const benchRule = `  if exists (
    select 1 from (
      select e."order", case when p.position='GK' then 0 else row_number() over (partition by (p.position='GK') order by e."order",p.id) end as priority
      from jsonb_to_recordset(p_entries) e(player_id text,slot text,"order" int)
      join players p on p.id=e.player_id where e.slot='sub'
    ) b where b."order" <> b.priority
  ) or (select count(*) from jsonb_to_recordset(p_entries) e(player_id text,slot text) join players p on p.id=e.player_id
    where e.slot='sub' and p.position='GK') > 1
  or (select count(*) from jsonb_to_recordset(p_entries) e(player_id text,slot text) join players p on p.id=e.player_id
    where e.slot='sub' and p.position<>'GK') > greatest(0,settings.subs_count-1) then
    raise exception 'Bench must reserve position zero for the goalkeeper, followed by ordered outfield substitutes' using errcode='22023';
  end if;`;

/* ------------------------------------------------------------------ */
/* ff_score_match: the fantasy lineup input comes from the resolver.   */
/* ------------------------------------------------------------------ */

const scoreOld = `  ), overrides as materialized (
    select d.profile_id,d.lineup from public.fantasy_match_lineup_drafts d
    join public.league_members lm on lm.league_id=v_match.league_id and lm.profile_id=d.profile_id
    where d.match_id=p_match
  ), inputs as materialized (
    select profile_id,lineup from overrides
    union all
    select s.profile_id,jsonb_build_object('formation',s.formation,'captainId',s.captain_id,'viceId',s.vice_captain_id,
      'players',jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name,'position',p.position,'slot',sp.slot,'order',sp."order") order by sp.slot,sp."order",p.id))
    from public.fantasy_squads s
    join public.fantasy_squad_players sp on sp.squad_id=s.id
    join public.players p on p.id=sp.player_id and p.league_id=v_match.league_id
    where s.league_id=v_match.league_id and not exists(select 1 from overrides d where d.profile_id=s.profile_id)
    group by s.id
  ), captured as (`;

const scoreNew = `  ), inputs as materialized (
    -- The lineup a manager actually uses for this match: the draft they saved,
    -- else the lineup locked in at the deadline, else the lineup inherited
    -- from their previous official lineup, else their default squad.
    select r.profile_id,r.lineup from public.ff_effective_fantasy_lineups(p_match) r
  ), captured as (`;

// The captured official lineup has to carry a captaincy that can be used.
// A lineup without one is kept as it is, a lineup with a broken one is not
// captured as an official lineup.
const captureOld = `      and v_match.kick_off >= (select enabled_at from public.fantasy_lineup_rollout)
      and exists (`;
const captureNew = `      and v_match.kick_off >= (select enabled_at from public.fantasy_lineup_rollout)
      and public.ff_valid_fantasy_captaincy(i.lineup)
      and exists (`;

/* ------------------------------------------------------------------ */
/* ff_live_manager_points_from_live: same resolver for the live rows.  */
/* ------------------------------------------------------------------ */

const liveOld = `  starters as (
    -- Same input precedence as official scoring: one fixture override, otherwise the default.
    select m.id as match_id,d.profile_id,e.id as player_id,d.lineup->>'captainId' as captain,d.lineup->>'viceId' as vice
    from matches m join fantasy_match_lineup_drafts d on d.match_id=m.id
    join league_members lm on lm.league_id=p_league and lm.profile_id=d.profile_id
    cross join lateral jsonb_to_recordset(d.lineup->'players') e(id text,slot text) where e.slot='starter'
    union all
    select m.id,s.profile_id,sp.player_id,s.captain_id,s.vice_captain_id
    from matches m join fantasy_squads s on s.league_id=p_league
    join league_members lm on lm.league_id=p_league and lm.profile_id=s.profile_id
    join fantasy_squad_players sp on sp.squad_id=s.id and sp.slot='starter'
    where not exists (select 1 from fantasy_match_lineup_drafts d where d.match_id=m.id and d.profile_id=s.profile_id)
  ),`;

const liveNew = `  starters as (
    -- Same input precedence as official scoring: the shared resolver returns
    -- the lineup each manager actually uses for this match.
    select m.id as match_id,r.profile_id,e.id as player_id,r.lineup->>'captainId' as captain,r.lineup->>'viceId' as vice
    from matches m join public.ff_effective_fantasy_lineups(m.id) r on true
    cross join lateral jsonb_to_recordset(r.lineup->'players') e(id text,slot text) where e.slot='starter'
  ),`;

/* ------------------------------------------------------------------ */
/* ff_save_next_match_lineup: a saved lineup names its captaincy.     */
/* ------------------------------------------------------------------ */

const nextOld = `  if jsonb_array_length(entries) <> jsonb_array_length(p_entries) or not exists (`;
const nextNew = `  if p_captain is null or p_vice is null then
    raise exception 'Choose a captain and a vice-captain for this lineup' using errcode='22023';
  end if;
  if p_captain=p_vice then
    raise exception 'Captain and vice-captain must be different players' using errcode='22023';
  end if;
  if jsonb_array_length(entries) <> jsonb_array_length(p_entries) or not exists (`;

const nextCaptainOld = `      and (p_captain is null or count(*) filter(where slot='starter' and id=p_captain)=1)
      and (p_vice is null or count(*) filter(where slot='starter' and id=p_vice)=1)`;
const nextCaptainNew = `      and count(*) filter(where slot='starter' and id=p_captain)=1
      and count(*) filter(where slot='starter' and id=p_vice)=1`;

// The save reports the fixture it wrote to, so the caller can confirm that
// the lineup went to the match it asked for.
const nextReturnOld = `  return jsonb_build_object('revision',revision,'lineup',result);`;
const nextReturnNew = `  return jsonb_build_object('revision',revision,'lineup',result,'matchId',m.id);`;

/* ------------------------------------------------------------------ */
/* ff_save_validated_squad: a complete squad names its captaincy.     */
/* ------------------------------------------------------------------ */

const squadOld = `  is_complete := total = settings.squad_size and starters = settings.starters and subs = settings.subs_count and keepers = 1;`;
const squadNew = `${squadOld}
  if is_complete and (p_captain is null or p_vice is null) then
    raise exception 'A complete squad needs a captain and a vice-captain' using errcode = '22023';
  end if;`;

/** Applies the documented patch to a copied body and returns it. */
const derived = {
  ff_score_match: () => {
    const body = extractFunction(scoring, "ff_score_match");
    if (!body.includes(scoreOld)) throw new Error("ff_score_match input block not found");
    if (!body.includes(captureOld)) throw new Error("ff_score_match capture block not found");
    return body.replace(scoreOld, scoreNew).replace(captureOld, captureNew);
  },
  ff_live_manager_points_from_live: () => {
    const body = extractFunction(live, "ff_live_manager_points_from_live");
    if (!body.includes(liveOld)) throw new Error("ff_live_manager_points_from_live starters block not found");
    return body.replace(liveOld, liveNew).replace(
      "create function public.ff_live_manager_points_from_live(",
      "create or replace function public.ff_live_manager_points_from_live(",
    );
  },
  ff_save_next_match_lineup: () => {
    const body = extractFunction(nextMatch, "ff_save_next_match_lineup");
    if (!body.includes(nextOld) || !body.includes(nextCaptainOld) || !body.includes(nextReturnOld)) {
      throw new Error("ff_save_next_match_lineup validation block not found");
    }
    return body.replace(nextOld, nextNew).replace(nextCaptainOld, nextCaptainNew).replace(nextReturnOld, nextReturnNew);
  },
  ff_save_validated_squad: () => {
    // The body of the function that is live today: the one migration 0009
    // wrote, under the name migration 0014 gave it.
    const body = extractFunction(squad, "save_fantasy_squad_v2");
    if (!body.includes(benchRule)) {
      throw new Error("migration 0009 no longer holds the bench rule; the live squad function has changed");
    }
    if (!body.includes(squadOld)) throw new Error("save_fantasy_squad_v2 completion block not found");
    return body.replace(squadOld, squadNew).replace(
      "create or replace function public.save_fantasy_squad_v2(",
      "create or replace function public.ff_save_validated_squad(",
    );
  },
};

let drifted = 0;
for (const [name, build] of Object.entries(derived)) {
  const expected = build();
  const actual = extractFunction(migration, name);
  if (actual !== expected) {
    drifted += 1;
    console.error(`drift: ${name} in migration 0028 differs from the body it was built from`);
  } else {
    console.log(`ok: ${name}`);
  }
}

// The rule 0009 added has to be in the migration, not only in the migration
// it was copied from. Losing it would silently allow a bench that no longer
// reserves the first seat for the goalkeeper.
const migrationSquad = extractFunction(migration, "ff_save_validated_squad");
if (!migrationSquad.includes(benchRule)) {
  drifted += 1;
  console.error("drift: ff_save_validated_squad in migration 0028 no longer holds the bench rule of migration 0009");
}

// The captaincy of a lineup has to be checked wherever a lineup is frozen.
for (const [name, fn] of [["ff_promote_match_lineup", "ff_promote_match_lineup"], ["ff_score_match", "ff_score_match"]]) {
  if (!extractFunction(migration, fn).includes("ff_valid_fantasy_captaincy")) {
    drifted += 1;
    console.error(`drift: ${name} in migration 0028 does not check the captaincy of the lineup it locks in`);
  }
}

if (drifted > 0) {
  console.error("migration 0028 has drifted from the migrations it was built from");
  process.exit(1);
}
console.log("Migration 0028 matches the bodies it was built from.");
