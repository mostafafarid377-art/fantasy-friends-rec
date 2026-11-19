import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import {
  ApiError,
  assertRole,
  handler,
  logActivity,
  memberProfiles,
  notifyMembers,
  requireMember,
} from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const membership = await requireMember(id);
  const supabase = await getSupabase();

  const { data: standingsRows } = await supabase
    .from("league_standings")
    .select("*, profiles(username, display_name, avatar_url)")
    .eq("league_id", id)
    .order("rank", { ascending: true });

  const { data: activity } = await supabase
    .from("league_activity")
    .select("*")
    .eq("league_id", id)
    .order("created_at", { ascending: false })
    .limit(30);

  const { count: memberCount } = await supabase
    .from("league_members")
    .select("*", { count: "exact", head: true })
    .eq("league_id", id);

  const members = await memberProfiles(id);

  return Response.json({
    league: membership.league,
    role: membership.role,
    isLeader: membership.role === "leader",
    members,
    standings: (standingsRows ?? []).map((s: any) => ({
      profileId: s.profile_id,
      rank: s.rank,
      prevRank: s.prev_rank,
      totalPoints: s.total_points,
      matchesPlayed: s.matches_played,
      form: s.form,
      username: s.profiles?.username,
      displayName: s.profiles?.display_name,
      avatarUrl: s.profiles?.avatar_url,
      teamName: members.find((m: any) => m.profileId === s.profile_id)?.teamName ?? null,
    })),
    activity: (activity ?? []).map((a: any) => ({
      id: a.id,
      action: a.action,
      summary: a.summary,
      actorId: a.profile_id,
      createdAt: a.created_at,
    })),
    memberCount: memberCount ?? 0,
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
  const supabase = await getSupabase();

  const { data: updated } = await supabase
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

  await logActivity(id, membership.profileId, "league.settings", "League settings updated", {
    ...input,
  });
  await notifyMembers(id, {
    type: "settings_updated",
    title: "League settings updated",
    body: `${membership.league.name} settings were changed by a League Leader.`,
  });

  return Response.json({ league: updated });
});