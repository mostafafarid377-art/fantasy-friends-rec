import { getSupabase } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = await getSupabase();
    const { error } = await supabase.from("profiles").select("id").limit(1);
    if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown" },
      { status: 500 },
    );
  }
}