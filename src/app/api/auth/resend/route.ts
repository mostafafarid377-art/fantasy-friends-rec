import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { enforceLimits, guardWrite } from "@/lib/request-guard";
import { siteOrigin } from "@/lib/site-origin";

const schema = z.object({ captchaToken: z.string().min(1).max(2048).optional() });

export async function POST(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user?.email) {
    return NextResponse.json({ error: "Sign in to request a new verification email" }, { status: 401 });
  }

  // Optional Turnstile token — forwarded only when the caller completed a
  // challenge. Callers that never render one are unaffected.
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the highlighted fields" }, { status: 422 });
  }
  const { captchaToken } = parsed.data;
  const limited = await enforceLimits(req, [
    { name: "resend-user", limit: 3, windowSeconds: 3600, subject: user.id },
    { name: "resend-ip", limit: 10, windowSeconds: 3600 },
  ]);
  if (limited) return limited;

  const origin = siteOrigin(req);
  const { error } = await supabase.auth.resend({
    type: "signup",
    email: user.email,
    options: {
      emailRedirectTo: `${origin}/auth/callback?next=/dashboard`,
      captchaToken: captchaToken ?? undefined,
    },
  });
  if (error) return NextResponse.json({ error: "Could not send the email. Try again later." }, { status: 400 });
  return NextResponse.json({ ok: true });
}
