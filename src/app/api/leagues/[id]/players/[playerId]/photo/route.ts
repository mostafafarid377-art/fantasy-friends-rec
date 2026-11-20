import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import sharp from "sharp";
import { getSupabase, type SupabaseClient } from "@/db";
import { ApiError, assertRole, checkDb, confirmedRow, handler, requireMember } from "@/lib/server";
import { PLAYER_FIELDS, playerDto } from "@/lib/roster";
import { removeUnlinkedPlayerPhoto } from "@/lib/player-photo-storage";
import { managedPhotoKey, PHOTO_EDGE, PHOTO_MAX_BYTES, PLAYER_PHOTO_BUCKET } from "@/lib/player-photo";

type Context = { params: Promise<{ id: string; playerId: string }> };
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };

async function currentPlayer(sb: SupabaseClient, id: string, playerId: string) {
  const { data, error } = await sb.from("players").select(`${PLAYER_FIELDS},created_by`).eq("league_id", id).eq("id", playerId).maybeSingle();
  checkDb(error, "Could not load player");
  if (!data || data.id !== playerId || data.league_id !== id) throw new ApiError("Player not found", 404);
  return data;
}

export const GET = handler(async (req: NextRequest, ctx: Context) => {
  const { id, playerId } = await ctx.params;
  const sb = await getSupabase();
  // Both the player and Storage reads are RLS-scoped to the cookie session.
  const player = await currentPlayer(sb, id, playerId);
  const key = managedPhotoKey(player.photo_url, id, playerId);
  if (!key || new URL(req.url).searchParams.get("v") !== key.split("/")[2]) {
    return new Response(null, { status: 404, headers: PRIVATE });
  }
  const { data, error } = await sb.storage.from(PLAYER_PHOTO_BUCKET).download(key);
  if (error || !data) return new Response(null, { status: 404, headers: PRIVATE });
  if (data.type !== "image/jpeg" || data.size > PHOTO_MAX_BYTES) return new Response(null, { status: 415, headers: PRIVATE });
  return new Response(data, { headers: { ...PRIVATE, "Content-Type": "image/jpeg" } });
});

async function writeContext(ctx: Context) {
  const { id, playerId } = await ctx.params;
  const sb = await getSupabase();
  const membership = await requireMember(id, sb);
  assertRole(membership, "leader");
  const player = await currentPlayer(sb, id, playerId);
  // Mirror the existing public.players write policy before storing any bytes.
  if (player.created_by !== membership.profileId) throw new ApiError("You don’t have permission to edit this player's photo", 403);
  return { id, playerId, sb, player, bucket: sb.storage.from(PLAYER_PHOTO_BUCKET) };
}

type Write = Awaited<ReturnType<typeof writeContext>>;
async function updatePhoto({ id, playerId, sb, player }: Write, photo: string | null) {
  const update = sb.from("players").update({ photo_url: photo, updated_at: new Date().toISOString() }).eq("league_id", id).eq("id", playerId);
  const query = player.photo_url === null ? update.is("photo_url", null) : update.eq("photo_url", player.photo_url);
  const { data, error } = await query.select(PLAYER_FIELDS).maybeSingle();
  const saved = confirmedRow(data, error, "Could not confirm photo change. Reload the player before retrying", id);
  if (saved.id !== playerId || saved.photo_url !== photo) throw new ApiError("Could not confirm the saved photo. Reload before retrying.", 409);
  return playerDto(saved);
}

async function readUpload(req: NextRequest) {
  const maxBody = PHOTO_MAX_BYTES + 8192;
  const contentType = req.headers.get("content-type");
  if (!contentType?.startsWith("multipart/form-data;") || !req.body) throw new ApiError("Choose a photo to upload", 422);
  if (Number(req.headers.get("content-length")) > maxBody) throw new ApiError("The optimized photo is too large", 413);
  // Also bound uploads that don't declare their length. Parse only after the
  // entire multipart request fits the limit.
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
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) { body.set(chunk, pos); pos += chunk.byteLength; }
  const form = await new Response(body, { headers: { "Content-Type": contentType } }).formData().catch(() => null);
  return form?.get("photo");
}

export const POST = handler(async (req: NextRequest, ctx: Context) => {
  const target = await writeContext(ctx);
  const file = await readUpload(req);
  if (!(file instanceof Blob) || file.size === 0 || file.type !== "image/jpeg") throw new ApiError("Choose a supported photo and try again", 422);
  if (file.size > PHOTO_MAX_BYTES) throw new ApiError("The optimized photo is too large", 413);
  let image: Buffer;
  try {
    // Re-encode untrusted bytes, enforcing a decode limit and stripping EXIF/GPS.
    const pipeline = sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 2048 * 2048 });
    if ((await pipeline.metadata()).format !== "jpeg") throw new Error("Expected JPEG");
    image = await pipeline.rotate().resize(PHOTO_EDGE, PHOTO_EDGE, { fit: "cover", withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  } catch {
    throw new ApiError("This file is not a valid photo. Try a different image.", 422);
  }
  const key = `${target.id}/${target.playerId}/${randomUUID()}.jpg`;
  if (!managedPhotoKey(`${PLAYER_PHOTO_BUCKET}/${key}`, target.id, target.playerId)) throw new ApiError("Invalid player photo path", 422);
  const upload = await target.bucket.upload(key, image, { upsert: false, contentType: "image/jpeg", cacheControl: "0" });
  if (upload.error || upload.data?.path !== key) throw new ApiError("Storage did not confirm the upload. Your existing photo was not changed.", 502);
  // If the DB response is ambiguous, don't delete the candidate: it may be
  // committed. Unlinked objects are not visible to ordinary members.
  const saved = await updatePhoto(target, `${PLAYER_PHOTO_BUCKET}/${key}`);
  await removeUnlinkedPlayerPhoto(target.sb, managedPhotoKey(target.player.photo_url, target.id, target.playerId));
  return Response.json({ player: saved });
});

export const DELETE = handler(async (_req: NextRequest, ctx: Context) => {
  const target = await writeContext(ctx);
  const saved = await updatePhoto(target, null);
  await removeUnlinkedPlayerPhoto(target.sb, managedPhotoKey(target.player.photo_url, target.id, target.playerId));
  return Response.json({ player: saved });
});
