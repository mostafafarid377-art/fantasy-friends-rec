import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, checkDb, handler, requireIdentity } from "@/lib/server";
import { rateLimitUser } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  const supabase = await getSupabase();
  const user = await requireIdentity(supabase);
  const url = new URL(req.url);
  const filter = url.searchParams.get("filter");

  let query = supabase.from("notifications").select("*").eq("profile_id", user.id);

  if (filter === "unread") {
    query = query.is("read_at", null);
  }

  const [rows, count] = await Promise.all([
    query.order("created_at", { ascending: false }).limit(100),
    supabase.from("notifications").select("id", { count: "exact", head: true }).eq("profile_id", user.id).is("read_at", null),
  ]);
  checkDb(rows.error, "Could not load notifications");
  checkDb(count.error, "Could not count unread notifications");
  return Response.json({ notifications: (rows.data ?? []).map((r) => ({ id: r.id, type: r.type, title: r.title,
    body: r.body, link: r.link, readAt: r.read_at, createdAt: r.created_at })), unread: count.count ?? 0 });
});

const patchSchema = z.object({
  ids: z.array(z.string().min(1)).optional(),
  all: z.boolean().optional(),
});

export const PATCH = handler(async (req: NextRequest) => {
  const supabase = await getSupabase();
  const user = await requireIdentity(supabase);
  const body = await req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body ?? {});
  if (!parsed.success) throw new ApiError("Invalid notification update", 422);
  const { ids, all } = parsed.data;
  if (!all && !ids?.length) throw new ApiError("Choose notifications to update", 422);
  const limited = await rateLimitUser("notifications.write", user.id);
  if (limited) return limited;
  const readAt = new Date().toISOString();
  let query = supabase.from("notifications").update({ read_at: readAt }).eq("profile_id", user.id).is("read_at", null);
  if (!all && ids) query = query.in("id", ids);
  const { error } = await query;
  checkDb(error, "Could not mark notifications read");
  const count = await supabase.from("notifications").select("id", { count: "exact", head: true })
    .eq("profile_id", user.id).is("read_at", null);
  checkDb(count.error, "Could not confirm unread notifications");
  return Response.json({ ok: true, unread: count.count ?? 0, readAt });
});

export const DELETE = handler(async (req: NextRequest) => {
  const supabase = await getSupabase();
  const user = await requireIdentity(supabase);
  const limited = await rateLimitUser("notifications.write", user.id);
  if (limited) return limited;
  const id = new URL(req.url).searchParams.get("id");

  let query = supabase.from("notifications").delete().eq("profile_id", user.id);
  if (id) query = query.eq("id", id);
  const { data, error } = await query.select("id");
  checkDb(error, "Could not delete notifications");
  return Response.json({ ok: true, deleted: data?.length ?? 0 });
});
