import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import sharp from "sharp";
import { getSupabase, type SupabaseClient } from "@/db";
import { ApiError, checkDb, confirmedRow, handler, requireMember } from "@/lib/server";
import { loadMatch } from "@/lib/matches";
import { motmStats, type Motm } from "@/lib/motm";
import { managedMotmPhotoKey, motmPhotoUrl, MOTM_PHOTO_BUCKET, MOTM_PHOTO_EDGE, MOTM_PHOTO_MAX_BYTES } from "@/lib/motm-photo";
import { removeUnlinkedMotmPhoto } from "@/lib/player-photo-storage";

type Context = { params: Promise<{ id: string; matchId: string }> };
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
const MOTM_FIELDS = "id,league_id,match_id,player_id,photo_url,chosen_by,created_at";

type MotmRow = { id: string; league_id: string; match_id: string; player_id: string; photo_url: string | null; chosen_by: string | null; created_at: string };
type MatchRow = { id: string; league_id: string; title: string; kick_off: string | null; status: string; organizer_id: string | null };

async function loadLeagueMatch(sb: SupabaseClient, leagueId: string, matchId: string): Promise<MatchRow> {
  const match = await loadMatch(matchId, sb);
  if (!match || match.league_id !== leagueId) throw new ApiError("Match not found", 404);
  return match as MatchRow;
}

/** Leader of the league, or the organizer of this match (with a managing role). */
async function requireMotmManager(sb: SupabaseClient, match: MatchRow) {
  const membership = await requireMember(match.league_id, sb);
  const isLeader = membership.role === "leader";
  const isOrganizer = match.organizer_id === membership.profileId && (membership.role === "leader" || membership.role === "organizer");
  if (!isLeader && !isOrganizer) throw new ApiError("You are not authorized to choose the man of the match", 403);
  return membership;
}

async function currentMotm(sb: SupabaseClient, leagueId: string, matchId: string): Promise<MotmRow | null> {
  const { data, error } = await sb.from("match_motm").select(MOTM_FIELDS).eq("league_id", leagueId).eq("match_id", matchId).maybeSingle();
  checkDb(error, "Could not load the man of the match");
  return (data as MotmRow | null) ?? null;
}

/** The players who took part in the match, for validating the choice. */
async function participantIds(sb: SupabaseClient, matchId: string): Promise<Set<string>> {
  const { data, error } = await sb.from("match_scoring_lineups").select("player_id").eq("match_id", matchId);
  checkDb(error, "Could not load the match lineup");
  return new Set((data ?? []).map((r: { player_id: string }) => r.player_id));
}

async function card(sb: SupabaseClient, match: MatchRow, row: MotmRow): Promise<Motm> {
  const [{ data: player, error: pErr }, { data: scored, error: sErr }] = await Promise.all([
    sb.from("players").select("id,full_name,team_id,teams(name)").eq("league_id", match.league_id).eq("id", row.player_id).maybeSingle(),
    sb.from("player_match_points").select("points,breakdown").eq("league_id", match.league_id).eq("match_id", match.id).eq("player_id", row.player_id).maybeSingle(),
  ]);
  checkDb(pErr, "Could not load the man of the match");
  checkDb(sErr, "Could not load the man of the match");
  if (!player) throw new ApiError("Man of the match player not found", 404);
  const stats = motmStats(scored?.points ?? null, scored?.breakdown as never);
  const team = Array.isArray(player.teams) ? player.teams[0] : player.teams;
  return {
    matchId: match.id, matchTitle: match.title, kickOff: match.kick_off, playerId: row.player_id, playerName: player.full_name,
    club: (team as { name?: string } | null)?.name ?? null, photoUrl: motmPhotoUrl(row.photo_url, match.league_id, match.id),
    points: stats.points, goals: stats.goals, assists: stats.assists, createdAt: row.created_at,
  };
}

/** Any league member reads the latest MOTM card for this match (usually none or one). */
export const GET = handler(async (_req: NextRequest, ctx: Context) => {
  const { id, matchId } = await ctx.params;
  const sb = await getSupabase();
  const match = await loadLeagueMatch(sb, id, matchId);
  await requireMember(match.league_id, sb);
  const row = await currentMotm(sb, id, matchId);
  return Response.json({ motm: row ? await card(sb, match, row) : null });
});

const chooseSchema = z.object({ playerId: z.string().trim().min(1).max(80) });

/** Leader/organizer chooses (or changes) the MOTM after the match is approved. */
export const PUT = handler(async (req: NextRequest, ctx: Context) => {
  const { id, matchId } = await ctx.params;
  const parsed = chooseSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new ApiError("Choose a player for the man of the match", 422);
  const sb = await getSupabase();
  const match = await loadLeagueMatch(sb, id, matchId);
  if (match.status !== "approved") throw new ApiError("The man of the match can be chosen once the match is approved", 409);
  const membership = await requireMotmManager(sb, match);
  const participants = await participantIds(sb, matchId);
  if (!participants.has(parsed.data.playerId)) throw new ApiError("Choose a player who took part in this match", 422);

  const existing = await currentMotm(sb, id, matchId);
  const now = new Date().toISOString();
  const row = {
    league_id: id, match_id: matchId, player_id: parsed.data.playerId,
    chosen_by: membership.profileId, updated_at: now,
  };
  const query = existing
    ? sb.from("match_motm").update(row).eq("id", existing.id).eq("match_id", matchId)
    : sb.from("match_motm").insert({ ...row, id: randomUUID(), created_at: now });
  const { data, error } = await query.select(MOTM_FIELDS).maybeSingle();
  const saved = confirmedRow(data as MotmRow | null, error, "Could not confirm the man of the match", id);
  if (saved.player_id !== parsed.data.playerId || saved.match_id !== matchId) {
    throw new ApiError("The man of the match could not be confirmed. Reload before retrying.", 409);
  }
  return Response.json({ motm: await card(sb, match, saved) });
});

async function readUpload(req: NextRequest) {
  const maxBody = MOTM_PHOTO_MAX_BYTES + 8192;
  const contentType = req.headers.get("content-type");
  if (!contentType?.startsWith("multipart/form-data;") || !req.body) throw new ApiError("Choose a photo to upload", 422);
  if (Number(req.headers.get("content-length")) > maxBody) throw new ApiError("The optimized photo is too large", 413);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBody) {
        await reader.cancel();
        throw new ApiError("The optimized photo is too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    body.set(chunk, pos);
    pos += chunk.byteLength;
  }
  const form = await new Response(body, { headers: { "Content-Type": contentType } }).formData().catch(() => null);
  return form?.get("photo");
}

/** Upload (or replace) the MOTM photo. Portrait JPEG, max 1200px long edge. */
export const POST = handler(async (req: NextRequest, ctx: Context) => {
  const { id, matchId } = await ctx.params;
  const sb = await getSupabase();
  const match = await loadLeagueMatch(sb, id, matchId);
  await requireMotmManager(sb, match);
  const existing = await currentMotm(sb, id, matchId);
  if (!existing) throw new ApiError("Choose the man of the match before adding a photo", 409);

  const file = await readUpload(req);
  if (!(file instanceof Blob) || file.size === 0 || file.type !== "image/jpeg") throw new ApiError("Choose a supported photo and try again", 422);
  if (file.size > MOTM_PHOTO_MAX_BYTES) throw new ApiError("The optimized photo is too large", 413);

  let image: Buffer;
  try {
    // Re-encode untrusted bytes, enforcing a decode limit and stripping EXIF/GPS.
    const pipeline = sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 4096 * 4096 });
    if ((await pipeline.metadata()).format !== "jpeg") throw new Error("Expected JPEG");
    image = await pipeline.rotate().resize(MOTM_PHOTO_EDGE, MOTM_PHOTO_EDGE, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
  } catch {
    throw new ApiError("This file is not a valid photo. Try a different image.", 422);
  }

  const key = `${id}/${matchId}/${randomUUID()}.jpg`;
  if (!managedMotmPhotoKey(`${MOTM_PHOTO_BUCKET}/${key}`, id, matchId)) throw new ApiError("Invalid man-of-the-match photo path", 422);
  const upload = await sb.storage.from(MOTM_PHOTO_BUCKET).upload(key, image, { upsert: false, contentType: "image/jpeg", cacheControl: "0" });
  if (upload.error || upload.data?.path !== key) throw new ApiError("Storage did not confirm the upload. Your existing photo was not changed.", 502);

  const photo = `${MOTM_PHOTO_BUCKET}/${key}`;
  const { data, error } = await sb.from("match_motm")
    .update({ photo_url: photo, updated_at: new Date().toISOString() })
    .eq("id", existing.id).eq("match_id", matchId)
    .select(MOTM_FIELDS).maybeSingle();
  const saved = confirmedRow(data as MotmRow | null, error, "Could not confirm the saved photo", id);
  if (saved.photo_url !== photo) throw new ApiError("The photo could not be confirmed. Reload before retrying.", 409);
  await removeUnlinkedMotmPhoto(sb, managedMotmPhotoKey(existing.photo_url, id, matchId));
  return Response.json({ motm: await card(sb, match, saved) });
});

/** Remove the MOTM photo (the choice itself stays). */
export const DELETE = handler(async (_req: NextRequest, ctx: Context) => {
  const { id, matchId } = await ctx.params;
  const sb = await getSupabase();
  const match = await loadLeagueMatch(sb, id, matchId);
  await requireMotmManager(sb, match);
  const existing = await currentMotm(sb, id, matchId);
  if (!existing) throw new ApiError("There is no man of the match to update", 404);
  const { data, error } = await sb.from("match_motm")
    .update({ photo_url: null, updated_at: new Date().toISOString() })
    .eq("id", existing.id).eq("match_id", matchId)
    .select(MOTM_FIELDS).maybeSingle();
  const saved = confirmedRow(data as MotmRow | null, error, "Could not confirm the photo removal", id);
  if (saved.photo_url !== null) throw new ApiError("The photo removal could not be confirmed. Reload before retrying.", 409);
  await removeUnlinkedMotmPhoto(sb, managedMotmPhotoKey(existing.photo_url, id, matchId));
  return Response.json({ motm: await card(sb, match, saved) });
});
