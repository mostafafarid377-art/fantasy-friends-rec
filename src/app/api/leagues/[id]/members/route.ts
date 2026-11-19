import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import {
  ApiError,
  assertRole,
  handler,
  checkDb,
  memberProfiles,
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
    const { data: leaders, error } = await supabase
      .from("league_members")
      .select("*")
      .eq("league_id", id)
      .eq("role", "leader");
    checkDb(error, "Could not verify league leadership");
    if ((leaders?.length ?? 0) <= 1) {
      throw new ApiError("A league must keep at least one League Leader", 409);
    }
  }

  const change = await supabase.rpc("set_member_role", { p_league: id, p_profile: profileId, p_role: role });
  checkDb(change.error, "Could not change league role");
  const { data: updated, error } = await supabase.from("league_members").select("id,league_id,profile_id,role")
    .eq("league_id", id).eq("profile_id", profileId).maybeSingle();
  checkDb(error, "Could not confirm the updated role");
  if (!updated || updated.role !== role) throw new ApiError("That manager is not in this league", 404);


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
    const { data: leaders, error } = await supabase
      .from("league_members")
      .select("*")
      .eq("league_id", id)
      .eq("role", "leader");
    checkDb(error, "Could not verify league leadership");
    if ((leaders?.length ?? 0) <= 1) {
      throw new ApiError("Promote another League Leader before leaving this league", 409);
    }
  }

  const supabase = await getSupabase();
  const { data: removed, error } = await supabase
    .from("league_members")
    .delete()
    .eq("league_id", id)
    .eq("profile_id", targetProfileId)
    .select();
  checkDb(error, "Could not remove member");
  if (!removed?.length) throw new ApiError("That manager is not in this league", 404);

  return Response.json({ ok: true, left: self });
});