import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import {
  ApiError,
  assertRole,
  handler,
  confirmedRow,
  checkDb,
  memberProfiles,
  requireMember,
} from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

function leagueDto(l: any) {
  return { id: l.id, name: l.name, description: l.description, format: l.format, starters: l.starters,
    subsCount: l.subs_count, squadSize: l.starters + l.subs_count, inviteCode: l.invite_code, vicePolicy: l.vice_policy };
}

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const membership = await requireMember(id);
  const supabase = await getSupabase();

  const [standings, recent, members] = await Promise.all([
    supabase.rpc("ff_display_standings", { p_league: id }).order("rank"),
    supabase.from("league_activity").select("id,action,summary,profile_id,created_at").eq("league_id", id)
      .order("created_at", { ascending: false }).limit(30),
    memberProfiles(id),
  ]);
  checkDb(standings.error, "Could not load standings");
  checkDb(recent.error, "Could not load league activity");
  const names = new Map(members.map((m) => [m.profileId, m.teamName]));

  return Response.json({
    league: leagueDto(membership.league),
    role: membership.role,
    isLeader: membership.role === "leader",
    canDelete: membership.league.created_by === membership.profileId,
    members,
    standings: (standings.data ?? []).map((s: any) => ({
      profileId: s.profile_id,
      rank: s.rank,
      prevRank: s.prev_rank,
      totalPoints: Number(s.total_points),
      livePoints: Number(s.live_points ?? 0),
      provisional: s.provisional,
      matchesPlayed: s.matches_played,
      form: s.form,
      username: s.profiles?.username,
      displayName: s.profiles?.display_name,
      avatarUrl: s.profiles?.avatar_url,
      teamName: names.get(s.profile_id) ?? null,
    })),
    activity: (recent.data ?? []).map((a: any) => ({
      id: a.id,
      action: a.action,
      summary: a.summary,
      actorId: a.profile_id,
      createdAt: a.created_at,
    })),
    memberCount: members.length,
  });
});

const patchSchema = z.object({
  name: z.string().min(3).max(60).optional(),
  description: z.string().max(280).nullable().optional(),
  subsCount: z.number().int().min(1).max(10).optional(),
  vicePolicy: z.enum(["auto_captain", "none"]).optional(),
});

export const PATCH = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const membership = await requireMember(id);
  assertRole(membership, "leader");

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("Invalid league settings", 422, parsed.error.flatten().fieldErrors);
  }
  const input = parsed.data;
  // A squad is exactly starters plus substitutes; league creation caps that total at 15.
  if ((input.subsCount ?? membership.league.subs_count) + membership.league.starters > 15) {
    throw new ApiError("Starters and substitutes cannot exceed 15 players", 422);
  }
  const supabase = await getSupabase();

  const { data, error } = await supabase
    .from("leagues")
    .update({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.subsCount !== undefined ? { subs_count: input.subsCount } : {}),
      ...(input.vicePolicy !== undefined ? { vice_policy: input.vicePolicy } : {}),
    })
    .eq("id", id)
    .select()
    .maybeSingle();

  const updated = confirmedRow(data, error, "Could not update league settings");

  return Response.json({ league: leagueDto(updated) });
});

const deleteSchema = z.object({ confirmation: z.string().min(1).max(60) });

export const DELETE = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const sb = await getSupabase();
  const membership = await requireMember(id, sb);
  if (membership.league.created_by !== membership.profileId) throw new ApiError("Only the league creator can delete this league", 403);
  const input = deleteSchema.safeParse(await req.json().catch(() => null));
  if (!input.success || input.data.confirmation !== membership.league.name) {
    throw new ApiError("Type the current league name exactly to confirm deletion", 422);
  }
  const result = await sb.rpc("delete_owned_league", { p_league: id, p_confirmation: input.data.confirmation });
  checkDb(result.error, "Could not delete league");
  if (result.data !== id) throw new ApiError("League deletion could not be confirmed. Refresh your league list before retrying.", 409);
  return Response.json({ deletedId: id });
});
