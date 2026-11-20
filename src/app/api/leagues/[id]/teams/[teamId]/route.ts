import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, assertRole, confirmedRow, handler, requireMember } from "@/lib/server";
import { TEAM_FIELDS, teamDto } from "@/lib/roster";

type Ctx = { params: Promise<{ id: string; teamId: string }> };
const rename = z.object({ name: z.string().trim().min(2).max(50) });

export const PATCH = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id, teamId } = await ctx.params;
  const sb = await getSupabase();
  assertRole(await requireMember(id, sb), "leader");
  const input = rename.safeParse(await req.json().catch(() => null));
  if (!input.success) throw new ApiError("Check the team name", 422);
  const { data, error } = await sb.from("teams").update(input.data).eq("id", teamId).eq("league_id", id)
    .select(TEAM_FIELDS).maybeSingle();
  const saved = confirmedRow(data, error, "Could not rename team", id);
  if (saved.id !== teamId || saved.name !== input.data.name) throw new ApiError("The updated team could not be confirmed", 409);
  return Response.json({ team: teamDto(saved) });
});
