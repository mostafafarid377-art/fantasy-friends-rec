import { playerPhotoUrl } from "@/lib/player-photo";
import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, handler, leagueRules, requireMember, checkDb } from "@/lib/server";
import { normalizeBench, validateSquad, validateSquadDraft, type Position } from "@/lib/domain";
import type { AutoSubReport, SquadEntry, SquadResponse } from "@/lib/squad";

import type { LiveMatchPoints } from "@/lib/live-points";

type Ctx = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";

const PLAYER = "id,full_name,position,photo_url,shirt_number,availability,status,team_id";
const SQUAD = "id,formation,captain_id,vice_captain_id,completed_at,updated_at";
type PlayerRow = { id: string; full_name: string; position: string; photo_url: string | null;
  shirt_number: number | null; availability: string; status: string; team_id: string | null };
type Entry = { playerId: string; slot: SquadEntry["slot"]; order: number };
type SavedSquad = { id: string; formation: string; captain_id: string | null; vice_captain_id: string | null;
  completed_at: string | null; updated_at: string };

function squadDto(row: SavedSquad): NonNullable<SquadResponse["squad"]> {
  return { id: row.id, formation: row.formation, captainId: row.captain_id,
    viceCaptainId: row.vice_captain_id, completedAt: row.completed_at, updatedAt: row.updated_at };
}
function entryDto(row: PlayerRow, entry: Entry, leagueId: string): SquadEntry {
  return { id: row.id, name: row.full_name, position: row.position as Position, slot: entry.slot, order: entry.order,
    photoUrl: playerPhotoUrl(row.photo_url, leagueId, row.id), shirtNumber: row.shirt_number, availability: row.availability, status: row.status, teamId: row.team_id };
}

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const sb = await getSupabase();
  const membership = await requireMember(id, sb);
  // Parent revision and its entries are read in the same snapshot.
  const [{ data, error }, recent, deadline, lastGame, liveGames] = await Promise.all([
    sb.from("fantasy_squads").select(`${SQUAD},fantasy_squad_players(player_id,slot,order,players(${PLAYER}))`)
      .eq("league_id", id).eq("profile_id", membership.profileId).maybeSingle(),
    sb.rpc("recent_fantasy_substitutions", { p_league: id }),
    sb.rpc("ff_squad_deadline", { p_league: id }),
    sb.rpc("last_game_points", { p_league: id }),
    sb.rpc("ff_my_live_match_points", { p_league: id }),
  ]);
  checkDb(deadline.error, "Could not load the squad deadline");
  checkDb(recent.error, "Could not load automatic substitutions");
  checkDb(lastGame.error, "Could not load last match points");
  checkDb(liveGames.error, "Could not load live match points");
  checkDb(error, "Could not load your squad");
  const row = data as unknown as (SavedSquad & { fantasy_squad_players: {
    player_id: string; slot: Entry["slot"]; order: number; players: PlayerRow | null }[] }) | null;
  const players = (row?.fantasy_squad_players ?? []).map((e) => {
    if (!e.players || e.players.id !== e.player_id) throw new ApiError("A saved squad player could not be loaded", 409);
    return entryDto(e.players, { playerId: e.player_id, slot: e.slot, order: e.order }, id);
  });
  // The score and match ID come from the same official ledger snapshot. Fetch
  // the kickoff for that specific match rather than looking up "latest" again.
  const game = lastGame.data?.[0] as { matchId: string; title: string; points: number | string | null } | undefined;
  const match = game ? await sb.from("real_matches").select("kick_off").eq("league_id", id).eq("id", game.matchId).maybeSingle() : null;
  checkDb(match?.error ?? null, "Could not load last match date");
  const lastMatch = game ? { matchId: game.matchId, title: game.title, kickOff: match?.data?.kick_off ?? null,
    points: game.points == null ? null : Number(game.points) } : null;
  return Response.json({ squad: row ? squadDto(row) : null, players, rules: leagueRules(membership.league),
    vicePolicy: membership.league.vice_policy, recentSubs: (recent.data ?? []) as AutoSubReport[], deadline: deadline.data, lastMatch, liveMatches: ((liveGames.data ?? []) as LiveMatchPoints[]).filter((m) => m.matchId !== lastMatch?.matchId)
  } satisfies SquadResponse, { headers: { "Cache-Control": "private, no-store" } });
});

const putSchema = z.object({
  formation: z.string().regex(/^[0-6]-[0-6]-[0-6]$/),
  captainId: z.string().min(1).nullable(),
  viceCaptainId: z.string().min(1).nullable(),
  expectedUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
  entries: z.array(z.object({ playerId: z.string().min(1), slot: z.enum(["starter", "sub", "reserve"]),
    order: z.number().int().min(0).max(2147483647) })),
});

export const PUT = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const sb = await getSupabase();
  const membership = await requireMember(id, sb);
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new ApiError("Invalid squad payload", 422, parsed.error.flatten().fieldErrors);
  const input = parsed.data;
  const rules = leagueRules(membership.league);
  const ids = input.entries.map((e) => e.playerId);
  if (ids.length > rules.squadSize || (!ids.length && !input.expectedUpdatedAt)) throw new ApiError("Invalid squad size", 422);
  if (new Set(ids).size !== ids.length) throw new ApiError("Duplicate players in squad", 422);

  const byId = new Map<string, PlayerRow>();
  if (ids.length) {
    const { data, error } = await sb.from("players").select(PLAYER).eq("league_id", id).in("id", ids);
    checkDb(error, "Could not verify the squad players");
    for (const player of data ?? []) byId.set(player.id, player);
    if (byId.size !== ids.length) throw new ApiError("One or more players are not part of this league", 403);
  }
  const players = normalizeBench(input.entries.map((e) => {
    const p = byId.get(e.playerId)!;
    if (p.status !== "active") throw new ApiError(`${p.full_name} is archived and cannot be selected`, 422);
    return entryDto(p, e, id);
  }));
  const complete = players.length === rules.squadSize;
  const validation = (complete ? validateSquad : validateSquadDraft)(rules, players, {
    formation: input.formation, captainId: input.captainId, viceId: input.viceCaptainId,
  });
  if (!validation.ok) throw new ApiError(validation.errors.join(" "), 422, validation.errors);

  const { data, error } = await sb.rpc("save_fantasy_squad_v2", {
    p_league: id, p_formation: input.formation, p_captain: input.captainId, p_vice: input.viceCaptainId,
    p_expected_updated_at: input.expectedUpdatedAt,
    p_entries: players.map((e) => ({ player_id: e.id, slot: e.slot, order: e.order })),
  });
  if (error?.code === "PT409") throw new ApiError(error.message, 409);
  checkDb(error, "Could not save squad");
  const row = data?.squad;
  const entries = data?.entries;
  const saved = new Map<string, { id: string; slot: string; order: number; squad_id: string }>(
    Array.isArray(entries) ? entries.map((e) => [e?.player_id, e]) : [],
  );
  if (!row?.id || !row.updated_at || row.league_id !== id || row.profile_id !== membership.profileId
      || row.formation !== input.formation || row.captain_id !== input.captainId || row.vice_captain_id !== input.viceCaptainId
      || Boolean(row.completed_at) !== complete || !Array.isArray(entries) || entries.length !== ids.length
      || !players.every((e) => {
        const stored = saved.get(e.id);
        return stored?.id && stored.squad_id === row.id && stored.slot === e.slot && stored.order === e.order;
      })) throw new ApiError("The saved squad could not be confirmed. Reload before retrying.", 409);

  return Response.json({ state: "applied", squad: squadDto(row), players, rules,
    vicePolicy: membership.league.vice_policy } satisfies SquadResponse & { state: "applied" });
});
