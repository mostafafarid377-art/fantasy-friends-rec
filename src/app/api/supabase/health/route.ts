import { getSupabase } from "@/db";

export const dynamic = "force-dynamic";

/**
 * Supabase connectivity probe. Unauthenticated by design, so the response is
 * deliberately boolean: database error text can carry SQL fragments, schema
 * detail, or connection internals and must never cross to the client. The
 * full error is logged server-side only.
 */
export async function GET() {
  try {
    const supabase = await getSupabase();
    const { error } = await supabase.from("profiles").select("id").limit(1);
    if (error) {
      console.error("[health:supabase]", error.message);
      return Response.json({ ok: false }, { status: 500 });
    }
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[health:supabase]", err instanceof Error ? err.message : "unknown");
    return Response.json({ ok: false }, { status: 500 });
  }
}
