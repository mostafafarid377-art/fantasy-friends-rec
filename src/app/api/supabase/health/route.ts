import { getSupabase } from "@/db";

export const dynamic = "force-dynamic";

// Public liveness probe: it reports only up or down. Error details stay in the
// server log, because they can reveal table names, hosts or library internals.
export async function GET() {
  try {
    const supabase = await getSupabase();
    const { error } = await supabase.from("profiles").select("id").limit(1);
    if (error) {
      console.error("[health]", error.message);
      return Response.json({ ok: false }, { status: 500 });
    }
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[health]", err instanceof Error ? err.message : "unknown");
    return Response.json({ ok: false }, { status: 500 });
  }
}
