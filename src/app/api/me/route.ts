import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, handler, logAudit, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const user = await requireUser();
  const supabase = await getSupabase();

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) throw new ApiError("Profile not found", 404);

  const { data: memberships } = await supabase
    .from("league_members")
    .select("league_id, role")
    .eq("profile_id", user.id);

  const { data: points } = await supabase
    .from("league_standings")
    .select("league_id, total_points, matches_played, rank")
    .eq("profile_id", user.id);

  const totalPoints = (points as any[])
    ? (points as any[]).reduce((sum: number, p: any) => sum + Number(p.total_points), 0)
    : 0;
  const matchesPlayed = (points as any[])
    ? (points as any[]).reduce((sum: number, p: any) => sum + p.matches_played, 0)
    : 0;
  const bestRank = (points as any[]).length
    ? Math.min(...(points as any[]).map((p: any) => p.rank))
    : null;

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
      leagues: memberships?.length ?? 0,
      roles: (memberships as any[]).reduce<Record<string, number>>((acc, m) => {
        acc[m.role] = (acc[m.role] ?? 0) + 1;
        return acc;
      }, {}),
      totalPoints,
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
    const { data: clash } = await supabase
      .from("profiles")
      .select("id")
      .eq("username", input.username)
      .limit(1);
    if (clash?.length) throw new ApiError("That username is already taken", 409);
  }

  const supabase = await getSupabase();
  const { data: updated } = await supabase
    .from("profiles")
    .update({
      ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...(input.avatarUrl !== undefined ? { avatar_url: input.avatarUrl } : {}),
      ...(input.bio !== undefined ? { bio: input.bio } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id)
    .select()
    .maybeSingle();

  await logAudit(null, user.id, "profile.updated", "profile", user.id);

  return Response.json({
    profile: {
      id: updated!.id,
      email: updated!.email,
      username: updated!.username,
      displayName: updated!.display_name,
      avatarUrl: updated!.avatar_url,
      bio: updated!.bio,
      emailVerified: Boolean(updated!.email_verified_at),
      createdAt: updated!.created_at,
    },
  });
});