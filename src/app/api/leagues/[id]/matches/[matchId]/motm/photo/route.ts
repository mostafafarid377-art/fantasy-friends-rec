import type { NextRequest } from "next/server";
import { getSupabase } from "@/db";
import { checkDb, handler, requireMember } from "@/lib/server";
import { loadMatch } from "@/lib/matches";
import { managedMotmPhotoKey, MOTM_PHOTO_BUCKET, MOTM_PHOTO_MAX_BYTES } from "@/lib/motm-photo";

type Context = { params: Promise<{ id: string; matchId: string }> };
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };

/** Serve the linked MOTM photo. The match, MOTM row and Storage read are all
 * RLS-scoped to the cookie session; the version query must match the stored key. */
export const GET = handler(async (req: NextRequest, ctx: Context) => {
  const { id, matchId } = await ctx.params;
  const sb = await getSupabase();
  const match = await loadMatch(matchId, sb);
  if (!match || match.league_id !== id) return new Response(null, { status: 404, headers: PRIVATE });
  await requireMember(match.league_id, sb);
  const { data, error } = await sb.from("match_motm").select("photo_url").eq("league_id", id).eq("match_id", matchId).maybeSingle();
  checkDb(error, "Could not load the man of the match");
  const key = managedMotmPhotoKey(data?.photo_url ?? null, id, matchId);
  if (!key || new URL(req.url).searchParams.get("v") !== key.split("/")[2]) {
    return new Response(null, { status: 404, headers: PRIVATE });
  }
  const { data: blob, error: dlError } = await sb.storage.from(MOTM_PHOTO_BUCKET).download(key);
  if (dlError || !blob) return new Response(null, { status: 404, headers: PRIVATE });
  if (blob.type !== "image/jpeg" || blob.size > MOTM_PHOTO_MAX_BYTES) return new Response(null, { status: 415, headers: PRIVATE });
  return new Response(blob, { headers: { ...PRIVATE, "Content-Type": "image/jpeg" } });
});
