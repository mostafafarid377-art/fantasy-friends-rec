import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, handler, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const supabase = await getSupabase();
  const url = new URL(req.url);
  const filter = url.searchParams.get("filter");

  let query = supabase.from("notifications").select("*").eq("profile_id", user.id);

  if (filter === "unread") {
    query = query.is("read_at", null);
  }

  const { data: rows } = await query.order("created_at", { ascending: false }).limit(100);

  const { count: unread } = await supabase
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .eq("profile_id", user.id)
    .is("read_at", null);

  return Response.json({ notifications: rows ?? [], unread: unread ?? 0 });
});

const patchSchema = z.object({
  ids: z.array(z.string().min(1)).optional(),
  all: z.boolean().optional(),
});

export const PATCH = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const body = await req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body ?? {});
  if (!parsed.success) throw new ApiError("Invalid notification update", 422);
  const { ids, all } = parsed.data;

  const supabase = await getSupabase();

  if (all) {
    await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("profile_id", user.id)
      .is("read_at", null);
  } else if (ids?.length) {
    await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("profile_id", user.id)
      .in("id", ids)
      .is("read_at", null);
  }

  const { count: unread } = await supabase
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .eq("profile_id", user.id)
    .is("read_at", null);

  return Response.json({ ok: true, unread: unread ?? 0 });
});

export const DELETE = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const id = new URL(req.url).searchParams.get("id");

  const supabase = await getSupabase();

  if (id) {
    const { data: rows } = await supabase
      .from("notifications")
      .delete()
      .eq("profile_id", user.id)
      .eq("id", id)
      .select();
    return Response.json({ ok: true, deleted: rows?.length ?? 0 });
  }

  const { data: rows } = await supabase
    .from("notifications")
    .delete()
    .eq("profile_id", user.id)
    .select();
  return Response.json({ ok: true, deleted: rows?.length ?? 0 });
});