import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { rateLimitAuth } from "@/lib/server/rate-limit";

const schema = z.object({ email: z.string().email(), captchaToken: z.string().min(1).max(2048).optional() });

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: true });

  const limited = await rateLimitAuth(req, "auth.forgot", parsed.data.email);
  if (limited) return limited;

  const supabase = await createClient();
  const origin = req.headers.get("origin") ?? new URL(req.url).origin;
  const { captchaToken } = parsed.data;
  const { error } = await supabase.auth.resetPasswordForEmail(
    parsed.data.email.trim().toLowerCase(),
    {
      redirectTo: `${origin}/auth/callback?next=/reset`,
      captchaToken: captchaToken ?? undefined,
    },
  );

  // Do not reveal whether an account exists.
  if (error) {
    return NextResponse.json({ error: "Could not send the reset email. Try again later." }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
