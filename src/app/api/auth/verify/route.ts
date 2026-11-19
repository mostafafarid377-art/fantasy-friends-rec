import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return NextResponse.json({ error: "Verification session is missing or expired" }, { status: 401 });
  }
  return NextResponse.json({ ok: Boolean(user.email_confirmed_at) });
}
