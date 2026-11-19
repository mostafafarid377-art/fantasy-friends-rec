import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({ email: z.string().email() });

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: true });

  const supabase = await createClient();
  const origin = req.headers.get("origin") ?? new URL(req.url).origin;
  const { error } = await supabase.auth.resetPasswordForEmail(
    parsed.data.email.trim().toLowerCase(),
    { redirectTo: `${origin}/auth/callback?next=/reset` },
  );

  // Do not reveal whether an account exists.
  if (error) {
    return NextResponse.json({ error: "Could not send the reset email. Try again later." }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
