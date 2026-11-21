import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, checkDb, confirmedRow, handler, requireIdentity, requireUser } from "@/lib/server";

import type { MyDisplayStanding } from "@/lib/live-points";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const supabase = await getSupabase();
  const user = await requireIdentity(supabase);
  const [profileResult, memberships, points] = await Promise.all([
    supabase.from("profiles").select("id,email,username,display_name,avatar_url,bio,email_verified_at,created_at")
      .eq("id", user.id).maybeSingle(),
    supabase.from("league_members").select("role").eq("profile_id", user.id),
    supabase.rpc("ff_my_display_standings"),
  ]);
  checkDb(profileResult.error, "Could not load your profile");
  const profile = profileResult.data;
  if (!profile) throw new ApiError("Profile not found", 404);
  checkDb(memberships.error, "Could not load your league roles");
  checkDb(points.error, "Could not load your points");
  const results = (points.data ?? []) as MyDisplayStanding[];
  const totalPoints = results.reduce((sum, p) => sum + Number(p.total_points), 0);
  const matchesPlayed = results.reduce((sum, p) => sum + p.matches_played, 0);
  const bestRank = results.length ? Math.min(...results.map((p) => p.rank)) : null;

  return Response.json({
    profile: {
      id: profile.id,
      email: profile.email,
      username: profile.username,
      displayName: profile.display_name,
      avatarUrl: profile.avatar_url,
      bio: profile.bio,
      emailVerified: Boolean(profile.email_verified_at),
      createdAt: profile.created_at,
    },
    stats: {
      leagues: memberships.data?.length ?? 0,
      roles: (memberships.data ?? []).reduce<Record<string, number>>((acc, m) => {
        acc[m.role] = (acc[m.role] ?? 0) + 1;
        return acc;
      }, {}),
      totalPoints,
      provisional: results.some((p) => p.provisional),
      matchesPlayed,
      bestRank,
    },
  });
});

const patchSchema = z.object({
  displayName: z.string().min(2).max(60).optional(),
  username: z
    .string()
    .min(3)
    .max(24)
    .regex(/^[a-z0-9_]+$/i)
    .optional(),
  avatarUrl: z.string().url().nullable().optional().or(z.literal("").transform(() => null)),
  bio: z.string().max(280).nullable().optional(),
});

export const PATCH = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) throw new ApiError("Check your profile details", 422, parsed.error.flatten().fieldErrors);
  const input = parsed.data;

  if (input.username && input.username !== user.username) {
    const supabase = await getSupabase();
    const { data: clash, error } = await supabase
      .from("profiles")
      .select("id")
      .eq("username", input.username)
      .limit(1);
    checkDb(error, "Could not check the username");
    if (clash?.length) throw new ApiError("That username is already taken", 409);
  }

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from("profiles")
    .update({
      ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...(input.avatarUrl !== undefined ? { avatar_url: input.avatarUrl } : {}),
      ...(input.bio !== undefined ? { bio: input.bio } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id)
    .select("id,email,username,display_name,avatar_url,bio,email_verified_at,created_at")
    .maybeSingle();


  const updated = confirmedRow(data, error, "Could not update your profile");
  return Response.json({
    profile: {
      id: updated.id,
      email: updated.email,
      username: updated.username,
      displayName: updated.display_name,
      avatarUrl: updated.avatar_url,
      bio: updated.bio,
      emailVerified: Boolean(updated.email_verified_at),
      createdAt: updated.created_at,
    },
  });
});