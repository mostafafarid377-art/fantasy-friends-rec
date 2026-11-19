import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import {
  ApiError,
  assertRole,
  handler,
  logActivity,
  memberProfiles,
  notifyUser,
  requireMember,
} from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireMember(id);
  const members = await memberProfiles(id);
  return Response.json({ members });
});

const patchSchema = z.object({
  profileId: z.string().min(1),
  role: z.enum(["leader", "manager", "organizer"]),
});

export const PATCH = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const membership = await requireMember(id);
  assertRole(membership, "leader");

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) throw new ApiError("Invalid role change", 422);

  const { profileId, role } = parsed.data;
  const supabase = await getSupabase();

  if (profileId === membership.profileId && role !== "leader") {
    const { data: leaders } = await supabase
      .from("league_members")
      .select("*")
      .eq("league_id", id)
      .eq("role", "leader");
    if (leaders?.length ?? 0 <= 1) {
      throw new ApiError("A league must keep at least one League Leader", 409);
    }
  }

  const { data: updated } = await supabase
    .from("league_members")
    .update({ role })
    .eq("league_id", id)
    .eq("profile_id", profileId)
    .select()
    .maybeSingle();
  if (!updated) throw new ApiError("That manager is not in this league", 404);

  await logActivity(id, membership.profileId, "member.role", `Role updated to ${role}`, {
    profileId,
    role,
  });
  await notifyUser(profileId, {
    leagueId: id,
    type: "role_changed",
    title: "Your league role changed",
    body: `You are now a ${role} in ${membership.league.name}.`,
    link: `/leagues/${id}`,
  });

  return Response.json({ member: updated });
});

export const DELETE = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const membership = await requireMember(id);

  const url = new URL(req.url);
  const targetProfileId = url.searchParams.get("profileId") ?? membership.profileId;
  const self = targetProfileId === membership.profileId;

  if (!self) assertRole(membership, "leader");

  if (self && membership.role === "leader") {
    const supabase = await getSupabase();
    const { data: leaders } = await supabase
      .from("league_members")
      .select("*")
      .eq("league_id", id)
      .eq("role", "leader");
    if (leaders?.length ?? 0 <= 1) {
      throw new ApiError("Promote another League Leader before leaving this league", 409);
    }
  }

  const supabase = await getSupabase();
  const { data: removed } = await supabase
    .from("league_members")
    .delete()
    .eq("league_id", id)
    .eq("profile_id", targetProfileId)
    .select();
  if (!removed?.length) throw new ApiError("That manager is not in this league", 404);

  await supabase
    .from("league_standings")
    .delete()
    .eq("league_id", id)
    .eq("profile_id", targetProfileId);

  await logActivity(
    id,
    membership.profileId,
    self ? "member.left" : "member.removed",
    self ? "A manager left the league" : "A manager was removed",
    { targetProfileId },
  );

  if (!self) {
    await notifyUser(targetProfileId, {
      leagueId: id,
      type: "member_removed",
      title: "Removed from league",
      body: `Your access to ${membership.league.name} was revoked by a League Leader.`,
    });
  }

  return Response.json({ ok: true, left: self });
});