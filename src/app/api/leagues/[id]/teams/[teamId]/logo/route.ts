import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import sharp from "sharp";
import { getSupabase, type SupabaseClient } from "@/db";
import { ApiError, assertRole, checkDb, confirmedRow, handler, requireMember } from "@/lib/server";
import { TEAM_FIELDS, teamDto } from "@/lib/roster";
import { TEAM_LOGO_BUCKET, TEAM_LOGO_EDGE, TEAM_LOGO_LIMIT, teamLogoKey } from "@/lib/team-logo";

type Context = { params: Promise<{ id: string; teamId: string }> };
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };

async function target(ctx: Context, edit: boolean) {
  const { id, teamId } = await ctx.params;
  const sb = await getSupabase();
  const member = await requireMember(id, sb);
  if (edit) assertRole(member, "leader");
  const { data, error } = await sb.from("teams").select(TEAM_FIELDS).eq("league_id", id).eq("id", teamId).maybeSingle();
  checkDb(error, "Could not load team");
  if (!data || data.id !== teamId || data.league_id !== id) throw new ApiError("Team not found", 404);
  return { id, teamId, sb, team: data, key: teamLogoKey(data.crest_url, id, teamId), bucket: sb.storage.from(TEAM_LOGO_BUCKET) };
}

export const GET = handler(async (req: NextRequest, ctx: Context) => {
  const t = await target(ctx, false);
  if (!t.key || new URL(req.url).searchParams.get("v") !== t.key.split("/")[2]) return new Response(null, { status: 404, headers: PRIVATE });
  const { data, error } = await t.bucket.download(t.key);
  if (error || !data) return new Response(null, { status: 404, headers: PRIVATE });
  if (data.type !== "image/webp" || data.size > TEAM_LOGO_LIMIT) return new Response(null, { status: 415, headers: PRIVATE });
  return new Response(data, { headers: { ...PRIVATE, "Content-Type": "image/webp" } });
});

async function optimize(req: NextRequest) {
  const type = req.headers.get("content-type");
  if (!req.body || !type || !["image/webp", "image/jpeg", "image/png"].includes(type)) throw new ApiError("Choose a JPEG, PNG or WebP logo", 422);
  if (Number(req.headers.get("content-length")) > TEAM_LOGO_LIMIT) throw new ApiError("The optimized logo is too large", 413);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > TEAM_LOGO_LIMIT) { await reader.cancel(); throw new ApiError("The optimized logo is too large", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const pipeline = sharp(Buffer.concat(chunks), { limitInputPixels: 4096 * 4096 });
    if (`image/${(await pipeline.metadata()).format}` !== type) throw new Error("Invalid format");
    const image = await pipeline.rotate().resize(TEAM_LOGO_EDGE, TEAM_LOGO_EDGE, { fit: "inside", withoutEnlargement: true }).webp({ quality: 83 }).toBuffer();
    if (!image.length || image.length > TEAM_LOGO_LIMIT) throw new Error("Invalid output");
    return image;
  } catch { throw new ApiError("This file is not a valid logo. Try a different image.", 422); }
}

async function save(t: Awaited<ReturnType<typeof target>>, path: string | null) {
  const update = (sb: SupabaseClient) => sb.from("teams").update({ crest_url: path }).eq("id", t.teamId).eq("league_id", t.id);
  const q = t.team.crest_url == null ? update(t.sb).is("crest_url", null) : update(t.sb).eq("crest_url", t.team.crest_url);
  const { data, error } = await q.select(TEAM_FIELDS).maybeSingle();
  const row = confirmedRow(data, error, "Could not confirm the logo change. Reload the team before retrying", t.id);
  if (row.id !== t.teamId || row.crest_url !== path) throw new ApiError("The saved logo could not be confirmed", 409);
  if (t.key) {
    try { const { error } = await t.bucket.remove([t.key]); if (error) console.warn("Unlinked logo cleanup failed", error.message); }
    catch { console.warn("Unlinked logo cleanup failed"); }
  }
  return Response.json({ team: teamDto(row) });
}

export const POST = handler(async (req: NextRequest, ctx: Context) => {
  const t = await target(ctx, true);
  const image = await optimize(req);
  const key = `${t.id}/${t.teamId}/${randomUUID()}.webp`;
  const path = `${TEAM_LOGO_BUCKET}/${key}`;
  if (!teamLogoKey(path, t.id, t.teamId)) throw new ApiError("Invalid team storage path", 422);
  const upload = await t.bucket.upload(key, image, { upsert: false, contentType: "image/webp", cacheControl: "0" });
  if (upload.error || upload.data?.path !== key) throw new ApiError("Storage did not confirm the upload; your existing logo was not changed", 502);
  return save(t, path);
});

export const DELETE = handler(async (_req: NextRequest, ctx: Context) => save(await target(ctx, true), null));
