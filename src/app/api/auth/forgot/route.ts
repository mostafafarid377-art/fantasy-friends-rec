import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { captchaMissing, enforceLimits, guardWrite } from "@/lib/request-guard";
import { siteOrigin } from "@/lib/site-origin";

const schema = z.object({ email: z.string().email(), captchaToken: z.string().min(1).max(2048).optional() });

export async function POST(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: true });

  const { captchaToken } = parsed.data;
  if (captchaMissing(captchaToken)) {
    return NextResponse.json({ error: "Complete the verification challenge" }, { status: 422 });
  }
  const email = parsed.data.email.trim().toLowerCase();
  const limited = await enforceLimits(req, [
    { name: "forgot-ip", limit: 10, windowSeconds: 3600 },
    { name: "forgot-email", limit: 3, windowSeconds: 3600, subject: email },
  ]);
  if (limited) return limited;

  const supabase = await createClient();
  const origin = siteOrigin(req);
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=/reset`,
    captchaToken: captchaToken ?? undefined,
  });

  // Do not reveal whether an account exists.
  if (error) {
    return NextResponse.json({ error: "Could not send the reset email. Try again later." }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
