import { getSupabase } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = await getSupabase();
    const { error } = await supabase.from("profiles").select("id").limit(1);
    if (error) return Response.json({ ok: false }, { status: 500 });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 500 });
  }
}